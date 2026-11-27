import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Settings } from "./config.js";
import { MediaError, ReferenceVideoAnalysis, probe } from "./media.js";
import { AssetPathResolver, render } from "./pipeline.js";
import { Instructions, ResolutionPreset } from "./schemas.js";

export interface JobRecord {
  job_id: string;
  owner_uid?: string | null;
  owner_email?: string | null;
  project_id?: string | null;
  client_uid?: string | null;
  client_email?: string | null;
  version_number?: number | null;
  resolution_preset?: ResolutionPreset | null;
  status: "queued" | "rendering" | "completed" | "failed";
  progress: number;
  error: string | null;
  duration_s: number | null;
  output_sha256: string | null;
  created_at: string;
  finished_at: string | null;
  input: string;
}

export interface ProjectAssetRecord {
  asset_id: string;
  project_id: string;
  owner_uid: string | null;
  client_uid: string | null;
  client_email: string | null;
  kind: "source" | "reference";
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  storage_provider: "local_temp" | "r2";
  duration_s: number;
  width: number;
  height: number;
  has_audio: boolean;
  reference_analysis: ReferenceVideoAnalysis | null;
  created_at: string;
  expires_at: string;
}

export const nowIso = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export class AssetMetaStore {
  readonly root: string;

  constructor(readonly s: Settings) {
    this.root = path.join(s.dataDir, "assets-meta");
    fs.mkdirSync(this.root, { recursive: true });
  }

  newId(): string {
    return "ast_" + crypto.randomBytes(6).toString("hex");
  }

  save(rec: ProjectAssetRecord): void {
    const f = path.join(this.root, `${rec.asset_id}.json`);
    const tmp = path.join(this.root, `${rec.asset_id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec), "utf-8");
    fs.renameSync(tmp, f);
  }

  get(assetId: string): ProjectAssetRecord | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(assetId)) return null;
    const f = path.join(this.root, `${assetId}.json`);
    try {
      return JSON.parse(fs.readFileSync(f, "utf-8")) as ProjectAssetRecord;
    } catch {
      return null;
    }
  }
}

export class JobStore {
  readonly root: string;

  constructor(readonly s: Settings) {
    this.root = path.join(s.dataDir, "jobs");
    fs.mkdirSync(this.root, { recursive: true });
  }

  newId(): string {
    return "rj_" + crypto.randomBytes(4).toString("hex");
  }

  dir(jid: string): string {
    return path.join(this.root, jid);
  }

  get(jid: string): JobRecord | null {
    const f = path.join(this.dir(jid), "job.json");
    try {
      return JSON.parse(fs.readFileSync(f, "utf-8")) as JobRecord;
    } catch {
      return null;
    }
  }

  save(jid: string, data: JobRecord): void {
    const f = path.join(this.dir(jid), "job.json");
    const tmp = path.join(this.dir(jid), "job.tmp");
    fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
    fs.renameSync(tmp, f);
  }

  update(jid: string, fields: Partial<JobRecord>): void {
    const d = (this.get(jid) || {}) as JobRecord;
    Object.assign(d, fields);
    this.save(jid, d);
  }

  recoverAndCleanup(): void {
    if (!fs.existsSync(this.root)) return;
    const nowMs = Date.now();
    const ttlMs = this.s.jobTtlHours * 3600 * 1000;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const d = path.join(this.root, entry.name);
      const job = this.get(entry.name);
      if (!job) continue;
      if (job.status === "queued" || job.status === "rendering") {
        job.status = "failed";
        job.error = "Service restarted before this job finished. Submit it again.";
        job.finished_at = nowIso();
        this.save(entry.name, job);
      } else {
        const stat = fs.statSync(d);
        if (nowMs - stat.mtimeMs > ttlMs) {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    }
  }

  listByOwner(
    ownerUid: string | null,
    includeAll = false,
    limit = 20,
    userEmail?: string | null
  ): JobRecord[] {
    if (!fs.existsSync(this.root)) return [];
    const normEmail = (userEmail || "").trim().toLowerCase();
    const out: JobRecord[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = this.get(entry.name);
      if (!job) continue;
      const matchUid = Boolean(
        ownerUid && (job.owner_uid === ownerUid || job.client_uid === ownerUid)
      );
      const matchEmail = Boolean(
        normEmail && job.client_email && job.client_email.toLowerCase() === normEmail
      );
      if (includeAll || matchUid || matchEmail) {
        out.push(job);
      }
    }
    out.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return out.slice(0, limit);
  }
}

export class Worker {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    readonly store: JobStore,
    readonly s: Settings,
    readonly resolveAsset?: AssetPathResolver
  ) {}

  getStats() {
    return {
      active: this.active,
      queued: this.queue.length,
      workers: this.s.workers,
    };
  }

  submit(jid: string, ins: Instructions, src: string): void {
    const runTask = () => {
      this.active++;
      void this._run(jid, ins, src).finally(() => {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
      });
    };

    if (this.active < this.s.workers) {
      runTask();
    } else {
      this.queue.push(runTask);
    }
  }

  private async _run(jid: string, ins: Instructions, src: string): Promise<void> {
    const st = this.store;
    let last = -1;

    const progress = (f: number) => {
      const pct = Math.trunc(f * 100);
      if (pct !== last) {
        last = pct;
        st.update(jid, { progress: pct });
      }
    };

    try {
      st.update(jid, { status: "rendering", progress: 0 });
      const out = await render(src, st.dir(jid), ins, this.s, progress, this.resolveAsset);
      const hash = await new Promise<string>((resolve, reject) => {
        const h = crypto.createHash("sha256");
        const stream = fs.createReadStream(out);
        stream.on("data", (chunk) => h.update(chunk));
        stream.on("end", () => resolve(h.digest("hex")));
        stream.on("error", reject);
      });
      const info = await probe(out);
      st.update(jid, {
        status: "completed",
        progress: 100,
        error: null,
        duration_s: Math.round(info.duration * 1000) / 1000,
        output_sha256: hash,
        finished_at: nowIso(),
      });
      console.info(`[reelhouse] job ${jid} completed (${info.duration.toFixed(2)}s)`);
    } catch (err) {
      if (err instanceof MediaError) {
        console.warn(`[reelhouse] job ${jid} failed: ${err.message}`);
        st.update(jid, { status: "failed", error: err.message, finished_at: nowIso() });
      } else {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error(`[reelhouse] job ${jid} crashed`, e);
        st.update(jid, {
          status: "failed",
          error: `Internal error: ${e.name}: ${e.message}`,
          finished_at: nowIso(),
        });
      }
    }
  }
}
