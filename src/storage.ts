import fs from "node:fs";
import path from "node:path";

export type StorageProviderKind = "local_temp" | "r2";

export interface StoredFileMeta {
  key: string;
  provider: StorageProviderKind;
  sizeBytes: number;
  available: boolean;
  expiresAt: string | null;
}

export interface StorageAdapterStatus {
  activeProvider: StorageProviderKind;
  localTempDir: string;
  ttlHours: number;
  tempTtlHours: number;
  r2Configured: boolean;
  r2Status: "not_connected" | "configured";
  missingR2EnvVars: string[];
  warning: string;
  ephemeralWarning: string;
}

export interface StorageAdapter {
  readonly provider: StorageProviderKind;
  resolveSafePath(key: string): string;
  exists(key: string): boolean;
  stat(key: string): { sizeBytes: number; mtimeMs: number } | null;
  putFromTempFile(tempPath: string, key: string): StoredFileMeta;
  delete(key: string): void;
  getStatus(): StorageAdapterStatus;
}

const SAFE_KEY_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export class LocalTempStorageAdapter implements StorageAdapter {
  readonly provider: StorageProviderKind = "local_temp";
  readonly rootDir: string;

  constructor(
    baseDataDir: string,
    readonly ttlHours: number
  ) {
    this.rootDir = path.resolve(baseDataDir, "assets");
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  resolveSafePath(key: string): string {
    const cleanSegments = key
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      cleanSegments.length === 0 ||
      cleanSegments.some((s) => s === "." || s === ".." || !SAFE_KEY_SEGMENT.test(s))
    ) {
      throw new Error("Invalid storage asset key");
    }
    const resolved = path.resolve(this.rootDir, ...cleanSegments);
    if (!resolved.startsWith(this.rootDir + path.sep)) {
      throw new Error("Storage path escapes root directory");
    }
    return resolved;
  }

  exists(key: string): boolean {
    try {
      const target = this.resolveSafePath(key);
      return fs.existsSync(target) && fs.statSync(target).isFile();
    } catch {
      return false;
    }
  }

  stat(key: string): { sizeBytes: number; mtimeMs: number } | null {
    try {
      const target = this.resolveSafePath(key);
      if (!fs.existsSync(target)) return null;
      const st = fs.statSync(target);
      if (!st.isFile()) return null;
      return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  putFromTempFile(tempPath: string, key: string): StoredFileMeta {
    const target = this.resolveSafePath(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(tempPath, target);
    } catch {
      fs.copyFileSync(tempPath, target);
      fs.rmSync(tempPath, { force: true });
    }
    const st = fs.statSync(target);
    const expiresAt = new Date(Date.now() + this.ttlHours * 3600 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    return {
      key,
      provider: "local_temp",
      sizeBytes: st.size,
      available: true,
      expiresAt,
    };
  }

  delete(key: string): void {
    try {
      const target = this.resolveSafePath(key);
      fs.rmSync(target, { force: true });
    } catch {
      // Ignore invalid keys on cleanup
    }
  }

  cleanupExpired(): number {
    if (!fs.existsSync(this.rootDir)) return 0;
    const ttlMs = this.ttlHours * 3600 * 1000;
    const now = Date.now();
    let removed = 0;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          if (fs.readdirSync(full).length === 0) {
            fs.rmdirSync(full);
          }
        } else if (entry.isFile()) {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > ttlMs) {
            fs.rmSync(full, { force: true });
            removed++;
          }
        }
      }
    };
    walk(this.rootDir);
    return removed;
  }

  getStatus(): StorageAdapterStatus {
    const requiredR2Vars = [
      "R2_ENDPOINT",
      "R2_BUCKET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ];
    const missingR2EnvVars = requiredR2Vars.filter(
      (k) => !process.env[k] || !String(process.env[k]).trim()
    );
    const r2Configured = missingR2EnvVars.length === 0;
    const warning =
      `Temporary server storage is active (TTL ${this.ttlHours}h). ` +
      "Files may be cleared on Render restarts; project metadata and instructions are saved in Firestore.";
    return {
      activeProvider: "local_temp",
      localTempDir: this.rootDir,
      ttlHours: this.ttlHours,
      tempTtlHours: this.ttlHours,
      r2Configured,
      r2Status: r2Configured ? "configured" : "not_connected",
      missingR2EnvVars,
      warning,
      ephemeralWarning: warning,
    };
  }
}
