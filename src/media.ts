import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  has_audio: boolean;
}

export interface ReferenceVideoAnalysis {
  duration_s: number;
  width: number;
  height: number;
  aspect_ratio: "9:16" | "16:9" | "1:1" | "4:5";
  exact_aspect: string;
  has_audio: boolean;
  mean_volume_db: number | null;
  max_volume_db: number | null;
  scene_cuts_s: number[];
  recommended_intro_end_s: number | null;
}

export function ffmpegVersion(): string | null {
  try {
    const out = execFileSync("ffmpeg", ["-version"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const m = out.match(/ffmpeg version (\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function probe(filePath: string): Promise<ProbeInfo> {
  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err: unknown) {
    const e = err as { code?: string | number; stderr?: string; message?: string };
    if (typeof e.code === "number" && e.code !== 0) {
      const tail = (e.stderr || "").trim().slice(-300);
      throw new MediaError("Not a readable media file: " + tail);
    }
    throw new MediaError(`ffprobe could not run: ${e.message || String(err)}`);
  }

  let d: {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      disposition?: { attached_pic?: number };
      duration?: string;
      width?: number;
      height?: number;
      side_data_list?: Array<{ rotation?: number | string }>;
      tags?: { rotate?: string };
    }>;
  };
  try {
    d = JSON.parse(stdout);
  } catch {
    throw new MediaError("Not a readable media file: " + stderr.trim().slice(-300));
  }

  const streams = d.streams || [];
  const v = streams.find(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1
  );
  if (!v) {
    throw new MediaError("File contains no video stream");
  }

  const dur = parseFloat(d.format?.duration || v.duration || "0");
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new MediaError("Could not determine the video duration");
  }

  let w = Number(v.width || 0);
  let h = Number(v.height || 0);
  let rot = 0;
  for (const sd of v.side_data_list || []) {
    if (sd.rotation !== undefined) {
      rot = Math.trunc(parseFloat(String(sd.rotation)));
    }
  }
  if (v.tags?.rotate !== undefined) {
    rot = Math.trunc(parseFloat(String(v.tags.rotate)));
  }
  if (Math.abs(rot) % 180 === 90) {
    [w, h] = [h, w];
  }

  return {
    duration: dur,
    width: w,
    height: h,
    has_audio: streams.some((s) => s.codec_type === "audio"),
  };
}

export async function runFfmpeg(
  args: string[],
  expected: number,
  onProgress: (fraction: number) => void,
  timeoutS: number,
  cwd?: string
): Promise<void> {
  const cmdArgs = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-progress",
    "pipe:1",
    "-nostats",
    ...args,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", cmdArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      proc.kill("SIGKILL");
    }, timeoutS * 1000);

    const errChunks: Buffer[] = [];
    let errSize = 0;
    proc.stderr.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
      errSize += chunk.length;
      if (errSize > 16384 && errChunks.length > 1) {
        const removed = errChunks.shift();
        if (removed) errSize -= removed.length;
      }
    });

    let lineBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString("utf-8");
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
          const val = parseInt(line.split("=", 2)[1], 10);
          if (Number.isFinite(val) && expected > 0 && val >= 0) {
            onProgress(Math.min(1.0, val / 1e6 / expected));
          }
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new MediaError(`ffmpeg failed to start: ${err.message}`));
    });

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = Buffer.concat(errChunks).toString("utf-8").slice(-700).trim();
      if (killedByTimeout || signal || (code !== null && code < 0)) {
        reject(new MediaError(`ffmpeg was stopped (timeout ${timeoutS}s or killed)`));
      } else {
        reject(new MediaError("ffmpeg failed: " + tail));
      }
    });
  });
}

export async function detectScenes(
  filePath: string,
  threshold: number,
  timeoutS: number
): Promise<number[]> {
  try {
    const res = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        filePath,
        "-an",
        "-vf",
        `select='gt(scene,${threshold})',showinfo`,
        "-f",
        "null",
        "-",
      ],
      { timeout: timeoutS * 1000, maxBuffer: 20 * 1024 * 1024 }
    );
    const times: number[] = [];
    for (const m of res.stderr.matchAll(/pts_time:([0-9.]+)/g)) {
      times.push(parseFloat(m[1]));
    }
    return times;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const tail = (e.stderr || e.message || "").trim().slice(-300);
    throw new MediaError("Scene detection failed: " + tail);
  }
}

export async function detectAudioLevels(
  filePath: string,
  timeoutS: number
): Promise<{ meanDb: number | null; maxDb: number | null }> {
  try {
    const res = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        filePath,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { timeout: Math.min(timeoutS, 60) * 1000, maxBuffer: 10 * 1024 * 1024 }
    );
    const meanMatch = res.stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = res.stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
    return {
      meanDb: meanMatch ? parseFloat(meanMatch[1]) : null,
      maxDb: maxMatch ? parseFloat(maxMatch[1]) : null,
    };
  } catch {
    return { meanDb: null, maxDb: null };
  }
}

function classifyAspectRatio(w: number, h: number): "9:16" | "16:9" | "1:1" | "4:5" {
  if (!w || !h) return "9:16";
  const r = w / h;
  const targets: Array<{ label: "9:16" | "16:9" | "1:1" | "4:5"; val: number }> = [
    { label: "9:16", val: 9 / 16 },
    { label: "4:5", val: 4 / 5 },
    { label: "1:1", val: 1 },
    { label: "16:9", val: 16 / 9 },
  ];
  targets.sort((a, b) => Math.abs(r - a.val) - Math.abs(r - b.val));
  return targets[0].label;
}

export async function analyzeReferenceVideo(
  filePath: string,
  timeoutS: number
): Promise<ReferenceVideoAnalysis> {
  const info = await probe(filePath);
  const [scenes, audio] = await Promise.all([
    detectScenes(filePath, 0.35, Math.min(timeoutS, 60)).catch(() => [] as number[]),
    info.has_audio
      ? detectAudioLevels(filePath, Math.min(timeoutS, 60))
      : Promise.resolve({ meanDb: null, maxDb: null }),
  ]);

  const cuts = scenes
    .filter((t) => Number.isFinite(t) && t >= 0.2)
    .slice(0, 25)
    .map((t) => Math.round(t * 100) / 100);

  return {
    duration_s: Math.round(info.duration * 100) / 100,
    width: info.width,
    height: info.height,
    aspect_ratio: classifyAspectRatio(info.width, info.height),
    exact_aspect: `${info.width}:${info.height}`,
    has_audio: info.has_audio,
    mean_volume_db: audio.meanDb,
    max_volume_db: audio.maxDb,
    scene_cuts_s: cuts,
    recommended_intro_end_s: cuts.length > 0 ? cuts[0] : null,
  };
}
