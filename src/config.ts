import path from "node:path";

export class Settings {
  readonly dataDir: string;
  readonly apiKey: string;
  readonly allowNoAuth: boolean;
  readonly maxUploadMb: number;
  readonly maxDurationS: number;
  readonly workers: number;
  readonly ffmpegTimeoutS: number;
  readonly jobTtlHours: number;
  readonly fontPath: string;
  readonly publicBaseUrl: string;
  readonly corsOrigins: string[];
  readonly rateLimitWindowMs: number;
  readonly rateLimitRenderMax: number;
  readonly rateLimitApiMax: number;

  constructor() {
    this.dataDir = path.resolve(process.env.DATA_DIR || "./data");
    this.apiKey = process.env.API_KEY || "";
    this.allowNoAuth = process.env.REELHOUSE_ALLOW_NO_AUTH === "1" || !this.apiKey;
    this.maxUploadMb = parseInt(process.env.MAX_UPLOAD_MB || "500", 10) || 500;
    this.maxDurationS = parseFloat(process.env.MAX_DURATION_S || "600") || 600;
    this.workers = Math.max(1, parseInt(process.env.WORKERS || "1", 10) || 1);
    this.ffmpegTimeoutS = parseInt(process.env.FFMPEG_TIMEOUT_S || "1800", 10) || 1800;
    this.jobTtlHours = parseFloat(process.env.JOB_TTL_HOURS || "72") || 72;
    this.fontPath = process.env.FONT_PATH || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    this.publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    this.corsOrigins = (process.env.CORS_ORIGINS || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    this.rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10) || 60000;
    this.rateLimitRenderMax = parseInt(process.env.RATE_LIMIT_RENDER_MAX || "20", 10) || 20;
    this.rateLimitApiMax = parseInt(process.env.RATE_LIMIT_API_MAX || "120", 10) || 120;
  }
}
