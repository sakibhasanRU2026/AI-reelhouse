import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import multer from "multer";
import { Settings } from "./src/config.js";
import {
  AssetMetaStore,
  JobRecord,
  JobStore,
  ProjectAssetRecord,
  Worker,
  nowIso,
} from "./src/jobs.js";
import {
  MediaError,
  analyzeReferenceVideo,
  ffmpegVersion,
  probe,
} from "./src/media.js";
import {
  InstructionError,
  Operation,
  ResolutionPreset,
  parseInstructions,
  parseSrtToSegments,
} from "./src/schemas.js";
import { computePreviewLayout } from "./src/pipeline.js";
import { AuthPageMode, SPLASH_HTML, renderAuthPageHtml } from "./src/entryPages.js";
import { DOCS_HTML, STUDIO_HTML } from "./src/studioHtml.js";
import {
  SESSION_COOKIE,
  SessionManager,
  clearSessionCookie,
  parseCookies,
  setSessionCookie,
  verifySameOriginCsrf,
} from "./src/auth.js";
import { createRateLimiter } from "./src/rateLimit.js";
import {
  FirebaseTokenVerifier,
  FirebaseTokenVerifierFn,
  TokenVerifyResult,
  loadFirebaseConfig,
} from "./src/firebaseAuth.js";
import { LocalTempStorageAdapter } from "./src/storage.js";
import { parseRevisionFeedback } from "./src/revisionEngine.js";
import {
  RuleBasedIdeaRecommender,
  getPublishingIntegrationsStatus,
  getResearchProvidersStatus,
} from "./src/integrations.js";

interface AuthenticatedRequest extends Request {
  authId?: string;
  uid?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  isAdmin?: boolean;
  isApiKey?: boolean;
}

export interface AppOptions {
  verifyFirebaseToken?: FirebaseTokenVerifierFn;
  disableFirebase?: boolean;
}

const ADMIN_EMAILS = new Set(
  [
    "sakibhasan.ru18@gmail.com",
    ...(process.env.REELHOUSE_ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ].filter(Boolean)
);

function isAdminEmail(email: string | null | undefined, emailVerified?: boolean): boolean {
  if (!email || !emailVerified) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

function buildEsbuildBundle(entryRelPath: string, globalName: string): string {
  const esbuildBin = path.resolve("node_modules/.bin/esbuild");
  const entry = path.resolve(entryRelPath);
  if (!fs.existsSync(entry) || !fs.existsSync(esbuildBin)) {
    return "";
  }
  try {
    return execFileSync(
      esbuildBin,
      [
        entry,
        "--bundle",
        "--minify",
        "--format=iife",
        `--global-name=${globalName}`,
        "--platform=browser",
      ],
      { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (err) {
    console.error(`[reelhouse] Failed to bundle ${entryRelPath}`, err);
    return "";
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const JOB_ID = /^rj_[0-9a-f]{8}$/;
const ASSET_ID = /^ast_[0-9a-f]{12}$/;
const SAFE_PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const ALLOWED_EXT = new Set([".mp4", ".mov"]);
const ALLOWED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "application/octet-stream",
]);

const ALLOWED_FONTS: Record<string, string> = {
  "DejaVuSans-Bold.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "DejaVuSans.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "DejaVuSerif-Bold.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
  "DejaVuSerif.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "DejaVuSansMono-Bold.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono.ttf": "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string> = {}
  ) {
    super(String(body.message || body.error || "ApiError"));
  }
}

function streamVideoFile(
  req: Request,
  res: Response,
  next: NextFunction,
  filePath: string,
  downloadName: string,
  contentType: string,
  isDownload: boolean
): void {
  const stat = fs.statSync(filePath);
  const total = stat.size;

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Disposition",
    `${isDownload ? "attachment" : "inline"}; filename="${downloadName}"`
  );

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const [, rawStart, rawEnd] = match;
      let start: number;
      let end: number;
      if (rawStart === "" && rawEnd !== "") {
        const suffix = parseInt(rawEnd, 10);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.status(416).set("Content-Range", `bytes */${total}`).end();
          return;
        }
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else if (rawStart !== "") {
        start = parseInt(rawStart, 10);
        end = rawEnd !== "" ? parseInt(rawEnd, 10) : total - 1;
      } else {
        res.status(416).set("Content-Range", `bytes */${total}`).end();
        return;
      }

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        start >= total ||
        end < start
      ) {
        res.status(416).set("Content-Range", `bytes */${total}`).end();
        return;
      }

      end = Math.min(end, total - 1);
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(chunkSize));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on("error", (err) => {
        if (!res.headersSent) next(err);
        else res.destroy();
      });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }
  }

  res.status(200);
  res.setHeader("Content-Length", String(total));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    if (!res.headersSent) next(err);
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export function createApp(opts: AppOptions = {}) {
  const s = new Settings();
  const firebaseConfig = opts.disableFirebase ? null : loadFirebaseConfig();
  const firebaseVerifier = new FirebaseTokenVerifier(firebaseConfig);
  const firebaseEnabled = Boolean(opts.verifyFirebaseToken) || firebaseVerifier.isEnabled();
  const verifyFbToken: FirebaseTokenVerifierFn =
    opts.verifyFirebaseToken || ((t) => firebaseVerifier.verifyIdToken(t));
  const verifyFbTokenDetailed = async (t: string): Promise<TokenVerifyResult> => {
    if (opts.verifyFirebaseToken) {
      const user = await opts.verifyFirebaseToken(t);
      return user
        ? { ok: true, user }
        : {
            ok: false,
            reason: "invalid",
            message: "Invalid or expired Firebase sign-in. Please sign in again.",
          };
    }
    return firebaseVerifier.verifyIdTokenDetailed(t);
  };

  const clientAuthBundle = buildEsbuildBundle("src/clientAuth.ts", "ReelhouseFirebase");
  let crmAppBundle = buildEsbuildBundle("src/frontend/main.ts", "ReelhouseCRM");

  if (!firebaseEnabled && !process.env.API_KEY && process.env.REELHOUSE_ALLOW_NO_AUTH !== "1") {
    console.warn(
      "[reelhouse] API_KEY and Firebase Auth are not configured — running with open auth for local/preview use."
    );
  }

  const sessions = new SessionManager(s.apiKey);
  const store = new JobStore(s);
  const assetMeta = new AssetMetaStore(s);
  const storage = new LocalTempStorageAdapter(s.dataDir, s.jobTtlHours);
  storage.cleanupExpired();
  store.recoverAndCleanup();

  const resolveAssetPath = (assetId: string): string | null => {
    const rec = assetMeta.get(assetId);
    if (!rec) return null;
    try {
      const p = storage.resolveSafePath(rec.storage_key);
      return fs.existsSync(p) ? p : null;
    } catch {
      return null;
    }
  };

  const worker = new Worker(store, s, resolveAssetPath);
  const ideaRecommender = new RuleBasedIdeaRecommender();
  const version = ffmpegVersion();
  const uploadTmpDir = path.join(s.dataDir, "tmp");
  fs.mkdirSync(uploadTmpDir, { recursive: true });

  const app = express();
  app.set("trust proxy", true);

  if (s.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: s.corsOrigins,
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With", "X-Studio-Boot"],
      })
    );
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const cl = req.headers["content-length"];
    if (
      req.method === "POST" &&
      typeof cl === "string" &&
      /^\d+$/.test(cl) &&
      parseInt(cl, 10) > s.maxUploadMb * 1048576 + 1_000_000
    ) {
      res.status(413).json({
        error: "file_too_large",
        message: `Upload exceeds ${s.maxUploadMb} MB`,
      });
      return;
    }
    next();
  });

  const rateKey = (req: Request) => {
    const authReq = req as AuthenticatedRequest;
    return `${authReq.uid || authReq.authId || "anon"}:${req.ip || "unknown"}`;
  };

  const sessionLimiter = createRateLimiter({
    windowMs: s.rateLimitWindowMs,
    max: s.rateLimitApiMax,
    keyPrefix: "session",
  });
  const apiLimiter = createRateLimiter({
    windowMs: s.rateLimitWindowMs,
    max: s.rateLimitApiMax,
    keyPrefix: "api",
    keyFn: rateKey,
  });
  const renderLimiter = createRateLimiter({
    windowMs: s.rateLimitWindowMs,
    max: s.rateLimitRenderMax,
    keyPrefix: "render",
    keyFn: rateKey,
  });
  const streamLimiter = createRateLimiter({
    windowMs: s.rateLimitWindowMs,
    max: Math.max(s.rateLimitApiMax * 3, 360),
    keyPrefix: "stream",
    keyFn: rateKey,
  });

  const auth = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const authReq = req as AuthenticatedRequest;
      const header = req.headers.authorization || "";
      const match = header.match(/^Bearer\s+(.+)$/i);
      const bearerToken = match ? match[1] : "";

      if (s.apiKey && bearerToken) {
        const a = Buffer.from(bearerToken);
        const b = Buffer.from(s.apiKey);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authReq.authId = "api_key";
          authReq.uid = "__api_key__";
          authReq.isAdmin = true;
          authReq.isApiKey = true;
          next();
          return;
        }
      }

      if (bearerToken) {
        const payload = sessions.verifySessionToken(bearerToken);
        if (payload && (!firebaseEnabled || Boolean(payload.uid))) {
          authReq.authId = payload.sid;
          authReq.uid = payload.uid || null;
          authReq.email = payload.email || null;
          authReq.emailVerified = Boolean(payload.emailVerified);
          authReq.isAdmin = isAdminEmail(payload.email, Boolean(payload.emailVerified));
          next();
          return;
        }
      }

      if (firebaseEnabled && bearerToken && bearerToken.split(".").length === 3) {
        const fbUser = await verifyFbToken(bearerToken);
        if (fbUser) {
          authReq.authId = `fb_${fbUser.uid}`;
          authReq.uid = fbUser.uid;
          authReq.email = fbUser.email;
          authReq.emailVerified = fbUser.emailVerified;
          authReq.isAdmin = isAdminEmail(fbUser.email, fbUser.emailVerified);
          next();
          return;
        }
      }

      const cookies = parseCookies(req);
      const cookieToken = cookies[SESSION_COOKIE];
      if (cookieToken) {
        const payload = sessions.verifySessionToken(cookieToken);
        if (payload && (!firebaseEnabled || Boolean(payload.uid))) {
          const isRead = req.method === "GET" || req.method === "HEAD";
          if (isRead || verifySameOriginCsrf(req)) {
            authReq.authId = payload.sid;
            authReq.uid = payload.uid || null;
            authReq.email = payload.email || null;
            authReq.emailVerified = Boolean(payload.emailVerified);
            authReq.isAdmin = isAdminEmail(payload.email, Boolean(payload.emailVerified));
            next();
            return;
          }
        }
      }

      if (!s.apiKey && !firebaseEnabled) {
        authReq.authId = "local_open";
        authReq.uid = "__local__";
        authReq.isAdmin = true;
        next();
        return;
      }

      res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({
          error: "unauthorized",
          message: "Missing or invalid authentication credentials",
        });
    })().catch(next);
  };

  const authOutput = (req: Request, res: Response, next: NextFunction): void => {
    const mt = typeof req.query.mt === "string" ? req.query.mt : "";
    const targetId = String(req.params.jid || req.params.aid || "");
    if (mt && targetId) {
      const payload = sessions.verifyMediaToken(mt, targetId);
      if (payload && (!firebaseEnabled || Boolean(payload.uid))) {
        const authReq = req as AuthenticatedRequest;
        authReq.authId = payload.sid;
        authReq.uid = payload.uid || null;
        authReq.email = payload.email || null;
        authReq.emailVerified = Boolean(payload.emailVerified);
        authReq.isAdmin = isAdminEmail(payload.email, Boolean(payload.emailVerified));
        authReq.isApiKey = payload.sid === "api_key";
        next();
        return;
      }
    }
    auth(req, res, next);
  };

  const authorizeResource = (
    req: Request,
    ownerUid?: string | null,
    clientUid?: string | null,
    clientEmail?: string | null,
    allowMediaTokenBypass = false
  ): void => {
    if (allowMediaTokenBypass) return;
    const authReq = req as AuthenticatedRequest;
    if (authReq.isApiKey || authReq.isAdmin) return;
    if (!firebaseEnabled) {
      if (authReq.uid && ownerUid && ownerUid !== authReq.uid) {
        throw new ApiError(403, {
          error: "forbidden",
          message: "You do not have permission to access this resource",
        });
      }
      return;
    }
    const matchUid = Boolean(
      authReq.uid && (ownerUid === authReq.uid || clientUid === authReq.uid)
    );
    const matchEmail = Boolean(
      authReq.emailVerified &&
        authReq.email &&
        clientEmail &&
        authReq.email.trim().toLowerCase() === clientEmail.trim().toLowerCase()
    );
    if (!matchUid && !matchEmail) {
      throw new ApiError(403, {
        error: "forbidden",
        message: "You do not have permission to access this resource",
      });
    }
  };

  const publicJob = (job: JobRecord, req: Request) => {
    const proto = req.protocol || "http";
    const host = req.get("host") || `localhost:${process.env.PORT || 3000}`;
    const base = s.publicBaseUrl || `${proto}://${host}`;
    const done = job.status === "completed";
    const outPath = path.resolve(store.dir(job.job_id), "output.mp4");
    const outputExists = done && fs.existsSync(outPath);
    return {
      job_id: job.job_id,
      project_id: job.project_id ?? null,
      version_number: job.version_number ?? null,
      resolution_preset: job.resolution_preset ?? "export_1080p",
      status: job.status,
      progress: job.progress ?? 0,
      error: job.error ?? null,
      duration_s: job.duration_s ?? null,
      output_url: done ? `${base}/v1/render-jobs/${job.job_id}/output` : null,
      output_available: outputExists,
      output_sha256: job.output_sha256 ?? null,
      created_at: job.created_at,
      finished_at: job.finished_at ?? null,
    };
  };

  const imagesDir = path.resolve("src/assets/images");
  if (fs.existsSync(imagesDir)) {
    app.use(
      "/assets/images",
      express.static(imagesDir, {
        fallthrough: true,
        maxAge: "1d",
      })
    );
  }

  const sendHtmlPage = (res: Response, template: string): void => {
    const bootToken = sessions.issueBootToken();
    const fbJson = firebaseVerifier.getPublicConfig()
      ? JSON.stringify(firebaseVerifier.getPublicConfig())
      : "null";
    const html = template
      .replace("__RH_BOOT_TOKEN__", bootToken)
      .replace("__RH_FB_CONFIG__", escapeHtmlAttr(fbJson));
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .set("Referrer-Policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(html);
  };

  const getValidSessionCookie = (req: Request) => {
    const cookieToken = parseCookies(req)[SESSION_COOKIE] || "";
    if (!cookieToken) return null;
    const payload = sessions.verifySessionToken(cookieToken);
    if (!payload) return null;
    if (firebaseEnabled && !payload.uid) return null;
    return payload;
  };

  app.head("/", (_req: Request, res: Response) => {
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .set("Referrer-Policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .end();
  });

  app.get("/studio-auth.js", (_req: Request, res: Response) => {
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .type("application/javascript; charset=utf-8")
      .send(clientAuthBundle);
  });

  app.get("/crm-app.js", (_req: Request, res: Response) => {
    if (!crmAppBundle) {
      crmAppBundle = buildEsbuildBundle("src/frontend/main.ts", "ReelhouseCRM");
    }
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .type("application/javascript; charset=utf-8")
      .send(crmAppBundle);
  });

  app.get("/", (_req: Request, res: Response) => {
    if (!firebaseEnabled) {
      res.redirect(302, "/dashboard");
      return;
    }
    sendHtmlPage(res, SPLASH_HTML);
  });

  const handleAuthPage = (mode: AuthPageMode) => (req: Request, res: Response) => {
    if (!firebaseEnabled) {
      res.redirect(302, "/dashboard");
      return;
    }
    if (mode !== "reset" && getValidSessionCookie(req)) {
      res.redirect(302, "/dashboard");
      return;
    }
    sendHtmlPage(res, renderAuthPageHtml(mode));
  };

  app.get("/login", handleAuthPage("login"));
  app.get("/register", handleAuthPage("register"));
  app.get("/reset-password", handleAuthPage("reset"));

  app.get("/dashboard", (req: Request, res: Response) => {
    if (firebaseEnabled && !getValidSessionCookie(req)) {
      res.redirect(302, "/login?next=%2Fdashboard");
      return;
    }
    sendHtmlPage(res, STUDIO_HTML);
  });

  app.post("/v1/studio/session", sessionLimiter, (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (!verifySameOriginCsrf(req)) {
        res.status(403).json({
          error: "forbidden",
          message: "Cross-origin session request rejected",
        });
        return;
      }

      const bootHeader = req.get("x-studio-boot") || "";
      const cookies = parseCookies(req);
      const existingCookie = cookies[SESSION_COOKIE] || "";

      const validBoot = bootHeader ? sessions.verifyBootToken(bootHeader) : null;
      const validCookie = existingCookie ? sessions.verifySessionToken(existingCookie) : null;

      if (!validBoot && !validCookie) {
        res.status(403).json({
          error: "forbidden",
          message: "Session handshake expired. Refresh the page to reconnect.",
        });
        return;
      }

      if (firebaseEnabled) {
        const authHeader = req.headers.authorization || "";
        const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
        const idToken = bearerMatch ? bearerMatch[1] : "";

        if (idToken) {
          const check = await verifyFbTokenDetailed(idToken);
          if (!check.ok) {
            const status = check.reason === "network" ? 503 : 401;
            res.status(status).json({
              error: check.reason === "network" ? "verification_unavailable" : "unauthorized",
              reason: check.reason,
              message: check.message,
            });
            return;
          }
          const fbUser = check.user;
          const role = isAdminEmail(fbUser.email, fbUser.emailVerified) ? "admin" : "client";
          if (validCookie && validCookie.uid === fbUser.uid) {
            setSessionCookie(req, res, existingCookie);
            res.json({
              connected: true,
              session_token: existingCookie,
              expires_at: new Date(validCookie.exp * 1000).toISOString(),
              auth_mode: "firebase",
              user: {
                uid: fbUser.uid,
                email: fbUser.email,
                emailVerified: fbUser.emailVerified,
                name: fbUser.name,
                picture: fbUser.picture,
                role,
              },
            });
            return;
          }

          const { token, payload } = sessions.issueSessionToken({
            uid: fbUser.uid,
            email: fbUser.email,
            emailVerified: fbUser.emailVerified,
            name: fbUser.name,
          });
          setSessionCookie(req, res, token);
          res.json({
            connected: true,
            session_token: token,
            expires_at: new Date(payload.exp * 1000).toISOString(),
            auth_mode: "firebase",
            user: {
              uid: fbUser.uid,
              email: fbUser.email,
              emailVerified: fbUser.emailVerified,
              name: fbUser.name,
              picture: fbUser.picture,
              role,
            },
          });
          return;
        }

        if (validCookie?.uid) {
          const role = isAdminEmail(validCookie.email, Boolean(validCookie.emailVerified))
            ? "admin"
            : "client";
          setSessionCookie(req, res, existingCookie);
          res.json({
            connected: true,
            session_token: existingCookie,
            expires_at: new Date(validCookie.exp * 1000).toISOString(),
            auth_mode: "firebase",
            user: {
              uid: validCookie.uid,
              email: validCookie.email ?? null,
              emailVerified: Boolean(validCookie.emailVerified),
              name: validCookie.name ?? null,
              picture: null,
              role,
            },
          });
          return;
        }

        res.status(401).json({
          error: "auth_required",
          message: "Please sign in to connect to the rendering backend.",
        });
        return;
      }

      if (validCookie) {
        setSessionCookie(req, res, existingCookie);
        res.json({
          connected: true,
          session_token: existingCookie,
          expires_at: new Date(validCookie.exp * 1000).toISOString(),
          auth_mode: s.apiKey ? "server_api_key" : "local_open",
          user: { uid: "__local__", email: null, emailVerified: true, name: "Local Session", picture: null, role: "admin" },
        });
        return;
      }

      const { token, payload } = sessions.issueSessionToken();
      setSessionCookie(req, res, token);
      res.json({
        connected: true,
        session_token: token,
        expires_at: new Date(payload.exp * 1000).toISOString(),
        auth_mode: s.apiKey ? "server_api_key" : "local_open",
        user: { uid: "__local__", email: null, emailVerified: true, name: "Local Session", picture: null, role: "admin" },
      });
    })().catch(next);
  });

  app.get("/v1/studio/session-check", (req: Request, res: Response) => {
    const payload = getValidSessionCookie(req);
    res
      .status(200)
      .set("Cache-Control", "no-store")
      .json({
        cookie_ok: Boolean(payload),
        uid: payload?.uid ?? null,
      });
  });

  app.post("/v1/studio/logout", sessionLimiter, (req: Request, res: Response) => {
    if (!verifySameOriginCsrf(req)) {
      res.status(403).json({ error: "forbidden", message: "Cross-origin logout rejected" });
      return;
    }
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      const p = sessions.verifySessionToken(match[1]);
      if (p) sessions.revoke(p);
    }
    const cookieToken = parseCookies(req)[SESSION_COOKIE];
    if (cookieToken) {
      const p = sessions.verifySessionToken(cookieToken);
      if (p) sessions.revoke(p);
    }
    clearSessionCookie(req, res);
    res.json({ connected: false });
  });

  app.get("/docs", (_req: Request, res: Response) => {
    res.status(200).type("text/html; charset=utf-8").send(DOCS_HTML);
  });

  app.get("/font/:name", (req: Request, res: Response) => {
    const name = String(req.params.name || "");
    const fontFile = ALLOWED_FONTS[name] || (name === "DejaVuSans-Bold.ttf" ? s.fontPath : "");
    if (!fontFile || !fs.existsSync(fontFile)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", "font/ttf");
    res.sendFile(path.resolve(fontFile));
  });

  app.get("/v1/crm/integrations", auth, apiLimiter, (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    res.json({
      ffmpeg_available: Boolean(version),
      ffmpeg_version: version,
      render_worker: {
        ...worker.getStats(),
        max_upload_mb: s.maxUploadMb,
        max_duration_s: s.maxDurationS,
        ffmpeg_timeout_s: s.ffmpegTimeoutS,
        job_ttl_hours: s.jobTtlHours,
      },
      storage: storage.getStatus(),
      research_providers: getResearchProvidersStatus(),
      publishing_integrations: getPublishingIntegrationsStatus(),
      session_role: authReq.isAdmin ? "admin" : "client",
    });
  });

  app.post(
    "/v1/crm/recommend-ideas",
    auth,
    apiLimiter,
    express.json({ limit: "256kb" }),
    (req: Request, res: Response) => {
      const body = (req.body || {}) as {
        ideas?: Array<{
          id?: unknown;
          title?: unknown;
          category?: unknown;
          niche?: unknown;
          tags?: unknown;
          status?: unknown;
        }>;
        preferred_tags?: unknown;
        client_niche?: unknown;
      };
      const ideas = Array.isArray(body.ideas)
        ? body.ideas
            .filter((i) => i && typeof i.id === "string" && typeof i.title === "string")
            .slice(0, 200)
            .map((i) => ({
              id: String(i.id),
              title: String(i.title),
              category: typeof i.category === "string" ? i.category : "",
              niche: typeof i.niche === "string" ? i.niche : "",
              tags: Array.isArray(i.tags)
                ? i.tags.filter((t): t is string => typeof t === "string").slice(0, 20)
                : [],
              status: typeof i.status === "string" ? i.status : "draft",
            }))
        : [];
      const preferredTags = Array.isArray(body.preferred_tags)
        ? body.preferred_tags.filter((t): t is string => typeof t === "string").slice(0, 30)
        : [];
      const clientNiche = typeof body.client_niche === "string" ? body.client_niche : "";
      res.json({
        recommendations: ideaRecommender.recommend(ideas, preferredTags, clientNiche),
      });
    }
  );

  app.post(
    "/v1/revisions/parse",
    auth,
    apiLimiter,
    express.json({ limit: "256kb" }),
    (req: Request, res: Response) => {
      const body = (req.body || {}) as {
        feedback_text?: unknown;
        timestamp_s?: unknown;
        current_instructions?: unknown;
      };
      const text = typeof body.feedback_text === "string" ? body.feedback_text : "";
      const ts =
        typeof body.timestamp_s === "number" && Number.isFinite(body.timestamp_s)
          ? body.timestamp_s
          : null;

      let currentIns = null;
      if (body.current_instructions && typeof body.current_instructions === "object") {
        try {
          currentIns = parseInstructions(JSON.stringify(body.current_instructions));
        } catch {
          currentIns = null;
        }
      }

      const result = parseRevisionFeedback(text, ts, currentIns);
      res.json(result);
    }
  );

  app.post(
    "/v1/captions/parse-srt",
    auth,
    apiLimiter,
    express.json({ limit: "512kb" }),
    (req: Request, res: Response) => {
      const body = (req.body || {}) as { srt?: unknown };
      if (typeof body.srt !== "string" || !body.srt.trim()) {
        res.status(422).json({
          error: "invalid_srt",
          message: "Provide non-empty SRT subtitle content.",
        });
        return;
      }
      const segments = parseSrtToSegments(body.srt);
      if (segments.length === 0) {
        res.status(422).json({
          error: "invalid_srt",
          message: "No valid subtitle entries found in the uploaded SRT file.",
        });
        return;
      }
      res.json({ segments });
    }
  );

  app.post(
    "/v1/preview-layout",
    auth,
    apiLimiter,
    express.json({ limit: "256kb" }),
    (req: Request, res: Response) => {
      const body = req.body as {
        width?: unknown;
        height?: unknown;
        resolution_preset?: unknown;
        operations?: unknown;
      };
      const srcW =
        typeof body?.width === "number" && Number.isFinite(body.width) && body.width > 0
          ? body.width
          : 1080;
      const srcH =
        typeof body?.height === "number" && Number.isFinite(body.height) && body.height > 0
          ? body.height
          : 1920;
      const preset: ResolutionPreset =
        body?.resolution_preset === "preview_720p" ? "preview_720p" : "export_1080p";
      const rawOps = Array.isArray(body?.operations) ? body.operations : [];

      let safeOps: Operation[] = [];
      try {
        const parsed = parseInstructions(
          JSON.stringify({
            schema_version: "1.0",
            resolution_preset: preset,
            operations: rawOps.length > 0 ? rawOps : [{ op: "reframe", aspect: "9:16", mode: "crop" }],
          })
        );
        safeOps = rawOps.length > 0 ? parsed.operations : [];
      } catch {
        // Fallback sanitize individually so partial edits still update live preview safely
        for (const op of rawOps) {
          if (!op || typeof op !== "object") continue;
          const o = op as Record<string, unknown>;
          if (o.op === "reframe") {
            const aspect =
              o.aspect === "16:9" || o.aspect === "1:1" || o.aspect === "4:5" ? o.aspect : "9:16";
            const mode =
              o.mode === "pad" || o.mode === "blur" || o.mode === "manual_crop"
                ? o.mode
                : "crop";
            safeOps.push({
              op: "reframe",
              aspect,
              mode,
              ...(typeof o.crop_x === "number" ? { crop_x: Math.max(0, Math.min(1, o.crop_x)) } : {}),
              ...(typeof o.crop_y === "number" ? { crop_y: Math.max(0, Math.min(1, o.crop_y)) } : {}),
            });
          } else if (
            o.op === "overlay_text" &&
            typeof o.text === "string" &&
            o.text.trim().length > 0 &&
            typeof o.at === "number" &&
            typeof o.duration === "number" &&
            o.duration > 0
          ) {
            try {
              const single = parseInstructions(
                JSON.stringify({ schema_version: "1.0", operations: [o] })
              );
              safeOps.push(single.operations[0]);
            } catch {
              // skip invalid overlay entry during typing
            }
          } else if (o.op === "captions" && o.source === "manual" && Array.isArray(o.segments)) {
            const segs = o.segments.filter(
              (seg) =>
                seg &&
                typeof seg === "object" &&
                typeof (seg as Record<string, unknown>).text === "string" &&
                String((seg as Record<string, unknown>).text).trim().length > 0 &&
                typeof (seg as Record<string, unknown>).start === "number" &&
                typeof (seg as Record<string, unknown>).end === "number" &&
                Number((seg as Record<string, unknown>).end) >
                  Number((seg as Record<string, unknown>).start)
            );
            if (segs.length > 0) {
              try {
                const single = parseInstructions(
                  JSON.stringify({
                    schema_version: "1.0",
                    operations: [{ ...o, segments: segs.slice(0, 200) }],
                  })
                );
                safeOps.push(single.operations[0]);
              } catch {
                // skip invalid caption op during editing
              }
            }
          }
        }
      }

      res.json(computePreviewLayout(srcW, srcH, safeOps, s.fontPath, preset));
    }
  );

  app.get("/health", auth, sessionLimiter, (_req: Request, res: Response) => {
    if (!version) {
      res.status(503).json({
        status: "error",
        ffmpeg: null,
        message: "ffmpeg not found on PATH",
      });
      return;
    }
    res.json({ status: "ok", ffmpeg: version, worker: worker.getStats() });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadTmpDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "").toLowerCase();
        cb(null, `upload_${crypto.randomBytes(8).toString("hex")}${ext}`);
      },
    }),
    limits: {
      fileSize: s.maxUploadMb * 1048576,
    },
  });

  const handleMulter = (fieldName: string) => (req: Request, res: Response, next: NextFunction) => {
    upload.single(fieldName)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: "file_too_large",
            message: `Upload exceeds ${s.maxUploadMb} MB`,
          });
          return;
        }
        res.status(422).json({
          error: "invalid_request",
          details: [{ loc: err.field || fieldName, msg: err.message }],
        });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  };

  app.post(
    "/v1/projects/:pid/assets",
    auth,
    renderLimiter,
    handleMulter("video"),
    async (req: Request, res: Response, next: NextFunction) => {
      const uploaded = req.file;
      const cleanupTemp = () => {
        if (uploaded?.path) fs.rmSync(uploaded.path, { force: true });
      };

      try {
        const pid = String(req.params.pid || "");
        if (!SAFE_PROJECT_ID.test(pid)) {
          throw new ApiError(422, { error: "invalid_project", message: "Invalid project ID" });
        }
        if (!uploaded) {
          throw new ApiError(422, {
            error: "invalid_request",
            details: [{ loc: "body.video", msg: "Video file required" }],
          });
        }
        const kind = req.body?.kind === "reference" ? "reference" : "source";
        const ext = path.extname(uploaded.originalname || "").toLowerCase();
        const ctype = uploaded.mimetype || "";
        if (!ALLOWED_EXT.has(ext) || !ALLOWED_TYPES.has(ctype)) {
          throw new ApiError(422, {
            error: "invalid_video",
            message: "Upload an MP4 or MOV file (video/mp4 or video/quicktime)",
          });
        }

        let info;
        let analysis = null;
        try {
          if (kind === "reference") {
            analysis = await analyzeReferenceVideo(uploaded.path, s.ffmpegTimeoutS);
            info = {
              duration: analysis.duration_s,
              width: analysis.width,
              height: analysis.height,
              has_audio: analysis.has_audio,
            };
          } else {
            info = await probe(uploaded.path);
          }
        } catch (e) {
          if (e instanceof MediaError) {
            throw new ApiError(422, { error: "invalid_video", message: e.message });
          }
          throw e;
        }

        if (info.duration > s.maxDurationS) {
          throw new ApiError(422, {
            error: "video_too_long",
            message: `Video is ${info.duration.toFixed(0)}s; the limit is ${s.maxDurationS.toFixed(0)}s`,
          });
        }

        const aid = assetMeta.newId();
        const key = `${pid}/${aid}${ext}`;
        const stored = storage.putFromTempFile(uploaded.path, key);
        const authReq = req as AuthenticatedRequest;
        const clientUid =
          typeof req.body?.client_uid === "string" && req.body.client_uid.trim()
            ? req.body.client_uid.trim().slice(0, 128)
            : null;
        const clientEmail =
          typeof req.body?.client_email === "string" && req.body.client_email.trim()
            ? req.body.client_email.trim().toLowerCase().slice(0, 320)
            : null;

        const rec: ProjectAssetRecord = {
          asset_id: aid,
          project_id: pid,
          owner_uid: authReq.uid || null,
          client_uid: clientUid,
          client_email: clientEmail,
          kind,
          filename: path.basename(uploaded.originalname || `${aid}${ext}`).slice(0, 160),
          mime_type: ext === ".mov" ? "video/quicktime" : "video/mp4",
          size_bytes: stored.sizeBytes,
          storage_key: key,
          storage_provider: stored.provider,
          duration_s: Math.round(info.duration * 1000) / 1000,
          width: info.width,
          height: info.height,
          has_audio: info.has_audio,
          reference_analysis: analysis,
          created_at: nowIso(),
          expires_at: stored.expiresAt || nowIso(),
        };
        assetMeta.save(rec);
        res.status(201).json({ ...rec, available: true });
      } catch (err) {
        cleanupTemp();
        next(err);
      }
    }
  );

  app.get(
    "/v1/projects/:pid/assets/:aid/status",
    auth,
    apiLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const pid = String(req.params.pid || "");
        const aid = String(req.params.aid || "");
        const rec = ASSET_ID.test(aid) ? assetMeta.get(aid) : null;
        if (!rec || rec.project_id !== pid) {
          res.json({
            asset_id: aid,
            available: false,
            expired: true,
            storage_provider: storage.provider,
            message: "Source footage is not on temporary server storage. Re-upload footage to re-render.",
          });
          return;
        }
        authorizeResource(req, rec.owner_uid, rec.client_uid, rec.client_email);
        const available = storage.exists(rec.storage_key);
        res.json({
          ...rec,
          available,
          expired: !available,
          message: available
            ? "Available on temporary server storage."
            : "Temporary footage file expired after server restart or TTL cleanup. Re-upload footage to re-render.",
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    "/v1/projects/:pid/assets/:aid/media-token",
    auth,
    apiLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const pid = String(req.params.pid || "");
        const aid = String(req.params.aid || "");
        const rec = ASSET_ID.test(aid) ? assetMeta.get(aid) : null;
        if (!rec || rec.project_id !== pid) {
          throw new ApiError(404, { error: "not_found", message: "Asset not found or expired" });
        }
        authorizeResource(req, rec.owner_uid, rec.client_uid, rec.client_email);
        if (!storage.exists(rec.storage_key)) {
          throw new ApiError(410, {
            error: "asset_expired",
            message: "Temporary asset file has expired. Re-upload source footage.",
          });
        }
        const authReq = req as AuthenticatedRequest;
        const { token, payload } = sessions.issueMediaToken(
          aid,
          authReq.authId || "sess_open",
          authReq.uid || null
        );
        res.json({
          media_token: token,
          expires_at: new Date(payload.exp * 1000).toISOString(),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    "/v1/projects/:pid/assets/:aid/stream",
    authOutput,
    streamLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const pid = String(req.params.pid || "");
        const aid = String(req.params.aid || "");
        const rec = ASSET_ID.test(aid) ? assetMeta.get(aid) : null;
        if (!rec || rec.project_id !== pid) {
          throw new ApiError(404, { error: "not_found", message: "Asset not found" });
        }
        const hasMt = typeof req.query.mt === "string" && req.query.mt.length > 0;
        authorizeResource(req, rec.owner_uid, rec.client_uid, rec.client_email, hasMt);
        const filePath = storage.resolveSafePath(rec.storage_key);
        if (!fs.existsSync(filePath)) {
          throw new ApiError(410, {
            error: "asset_expired",
            message: "Source file expired from temporary storage.",
          });
        }
        streamVideoFile(
          req,
          res,
          next,
          filePath,
          rec.filename,
          rec.mime_type || "video/mp4",
          req.query.download === "1"
        );
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    "/v1/projects/:pid/render",
    auth,
    renderLimiter,
    express.json({ limit: "512kb" }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pid = String(req.params.pid || "");
        if (!SAFE_PROJECT_ID.test(pid)) {
          throw new ApiError(422, { error: "invalid_project", message: "Invalid project ID" });
        }
        const body = (req.body || {}) as {
          source_asset_id?: unknown;
          instructions?: unknown;
          version_number?: unknown;
          client_uid?: unknown;
          client_email?: unknown;
        };
        const aid = typeof body.source_asset_id === "string" ? body.source_asset_id.trim() : "";
        const rec = ASSET_ID.test(aid) ? assetMeta.get(aid) : null;
        if (!rec || rec.project_id !== pid || !storage.exists(rec.storage_key)) {
          throw new ApiError(409, {
            error: "source_footage_expired",
            message:
              "Source footage is missing or expired from temporary server storage. Re-upload the video to trigger a re-render.",
          });
        }
        authorizeResource(req, rec.owner_uid, rec.client_uid, rec.client_email);

        const ins = parseInstructions(
          typeof body.instructions === "string"
            ? body.instructions
            : JSON.stringify(body.instructions || {})
        );

        const srcFile = storage.resolveSafePath(rec.storage_key);
        const jid = store.newId();
        const jdir = store.dir(jid);
        fs.mkdirSync(jdir, { recursive: true });
        const ext = path.extname(srcFile) || ".mp4";
        const dstSrc = path.join(jdir, `input${ext}`);
        fs.copyFileSync(srcFile, dstSrc);

        const created = nowIso();
        const authReq = req as AuthenticatedRequest;
        const versionNum =
          typeof body.version_number === "number" && Number.isInteger(body.version_number)
            ? body.version_number
            : null;
        const clientUid =
          typeof body.client_uid === "string" && body.client_uid.trim()
            ? body.client_uid.trim().slice(0, 128)
            : rec.client_uid;
        const clientEmail =
          typeof body.client_email === "string" && body.client_email.trim()
            ? body.client_email.trim().toLowerCase().slice(0, 320)
            : rec.client_email;

        store.save(jid, {
          job_id: jid,
          owner_uid: rec.owner_uid || authReq.uid || null,
          owner_email: authReq.email || null,
          project_id: pid,
          client_uid: clientUid,
          client_email: clientEmail,
          version_number: versionNum,
          resolution_preset: ins.resolution_preset || "export_1080p",
          status: "queued",
          progress: 0,
          error: null,
          duration_s: null,
          output_sha256: null,
          created_at: created,
          finished_at: null,
          input: path.basename(dstSrc),
        });
        worker.submit(jid, ins, dstSrc);
        res.status(202).json({
          job_id: jid,
          project_id: pid,
          version_number: versionNum,
          status: "queued",
          created_at: created,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    "/v1/render-jobs",
    auth,
    renderLimiter,
    handleMulter("video"),
    async (req: Request, res: Response, next: NextFunction) => {
      const uploaded = req.file;
      const cleanupTemp = () => {
        if (uploaded?.path) {
          fs.rmSync(uploaded.path, { force: true });
        }
      };

      try {
        const rawInstructions = req.body?.instructions;
        if (typeof rawInstructions !== "string") {
          cleanupTemp();
          res.status(422).json({
            error: "invalid_request",
            details: [{ loc: "body.instructions", msg: "Field required" }],
          });
          return;
        }
        if (!uploaded) {
          res.status(422).json({
            error: "invalid_request",
            details: [{ loc: "body.video", msg: "Field required" }],
          });
          return;
        }

        const ins = parseInstructions(rawInstructions);
        const ext = path.extname(uploaded.originalname || "").toLowerCase();
        const ctype = uploaded.mimetype || "";
        if (!ALLOWED_EXT.has(ext) || !ALLOWED_TYPES.has(ctype)) {
          throw new ApiError(422, {
            error: "invalid_video",
            message: "Upload an MP4 or MOV file (video/mp4 or video/quicktime)",
          });
        }

        const jid = store.newId();
        const jdir = store.dir(jid);
        fs.mkdirSync(jdir, { recursive: true });
        const src = path.join(jdir, `input${ext}`);
        fs.renameSync(uploaded.path, src);

        try {
          let info;
          try {
            info = await probe(src);
          } catch (e) {
            if (e instanceof MediaError) {
              throw new ApiError(422, {
                error: "invalid_video",
                message: e.message,
              });
            }
            throw e;
          }
          if (info.duration > s.maxDurationS) {
            throw new ApiError(422, {
              error: "video_too_long",
              message: `Video is ${info.duration.toFixed(0)}s; the limit is ${s.maxDurationS.toFixed(0)}s`,
            });
          }
        } catch (err) {
          fs.rmSync(jdir, { recursive: true, force: true });
          throw err;
        }

        const created = nowIso();
        const authReq = req as AuthenticatedRequest;
        const projectId =
          typeof req.body?.project_id === "string" && SAFE_PROJECT_ID.test(req.body.project_id)
            ? req.body.project_id
            : null;
        const clientUid =
          typeof req.body?.client_uid === "string" && req.body.client_uid.trim()
            ? req.body.client_uid.trim().slice(0, 128)
            : null;
        const clientEmail =
          typeof req.body?.client_email === "string" && req.body.client_email.trim()
            ? req.body.client_email.trim().toLowerCase().slice(0, 320)
            : null;
        const parsedVer = Number(req.body?.version_number);
        const versionNumber = Number.isInteger(parsedVer) && parsedVer > 0 ? parsedVer : null;

        store.save(jid, {
          job_id: jid,
          owner_uid: authReq.uid || null,
          owner_email: authReq.email || null,
          project_id: projectId,
          client_uid: clientUid,
          client_email: clientEmail,
          version_number: versionNumber,
          resolution_preset: ins.resolution_preset || "export_1080p",
          status: "queued",
          progress: 0,
          error: null,
          duration_s: null,
          output_sha256: null,
          created_at: created,
          finished_at: null,
          input: path.basename(src),
        });
        worker.submit(jid, ins, src);
        res.status(202).json({
          job_id: jid,
          project_id: projectId,
          version_number: versionNumber,
          status: "queued",
          created_at: created,
        });
      } catch (err) {
        cleanupTemp();
        next(err);
      }
    }
  );

  const loadJob = (jid: string): JobRecord => {
    const job = JOB_ID.test(jid) ? store.get(jid) : null;
    if (!job) {
      throw new ApiError(404, { error: "not_found", message: "Unknown job" });
    }
    return job;
  };

  app.get("/v1/render-jobs", auth, apiLimiter, (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const includeAll = Boolean(authReq.isApiKey || authReq.isAdmin);
      const jobs = store
        .listByOwner(
          authReq.uid || null,
          includeAll,
          40,
          authReq.emailVerified ? authReq.email : null
        )
        .map((j) => publicJob(j, req));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  app.get("/v1/render-jobs/:jid", auth, apiLimiter, (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = loadJob(String(req.params.jid));
      authorizeResource(req, job.owner_uid, job.client_uid, job.client_email);
      res.json(publicJob(job, req));
    } catch (err) {
      next(err);
    }
  });

  app.post(
    "/v1/render-jobs/:jid/media-token",
    auth,
    apiLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const jid = String(req.params.jid);
        const job = loadJob(jid);
        authorizeResource(req, job.owner_uid, job.client_uid, job.client_email);
        if (job.status !== "completed") {
          throw new ApiError(409, {
            error: "not_ready",
            message: `Job status is '${job.status}'`,
          });
        }
        const authReq = req as AuthenticatedRequest;
        const parentSid = authReq.authId || "sess_open";
        const { token, payload } = sessions.issueMediaToken(jid, parentSid, authReq.uid || null);
        res.json({
          media_token: token,
          expires_at: new Date(payload.exp * 1000).toISOString(),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get(
    "/v1/render-jobs/:jid/output",
    authOutput,
    streamLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const jid = String(req.params.jid);
        const job = loadJob(jid);
        const hasMt = typeof req.query.mt === "string" && req.query.mt.length > 0;
        authorizeResource(req, job.owner_uid, job.client_uid, job.client_email, hasMt);
        if (job.status !== "completed") {
          throw new ApiError(409, {
            error: "not_ready",
            message: `Job status is '${job.status}'`,
          });
        }
        const rootDir = path.resolve(store.root);
        const outPath = path.resolve(store.dir(jid), "output.mp4");
        if (!outPath.startsWith(rootDir + path.sep) || !fs.existsSync(outPath)) {
          throw new ApiError(404, {
            error: "not_found",
            message: "Rendered output file has expired from temporary storage.",
          });
        }

        streamVideoFile(
          req,
          res,
          next,
          outPath,
          `${jid}.mp4`,
          "video/mp4",
          req.query.download === "1"
        );
      } catch (err) {
        next(err);
      }
    }
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).set(err.headers).json(err.body);
      return;
    }
    if (err instanceof InstructionError) {
      res.status(err.status).json(err.body);
      return;
    }
    console.error("[reelhouse] unhandled error", err);
    res.status(500).json({
      error: "internal_error",
      message: err instanceof Error ? err.message : "Internal server error",
    });
  });

  return app;
}

if (process.env.REELHOUSE_NO_LISTEN !== "1") {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`REELHOUSE Render Service listening on http://0.0.0.0:${port}`);
  });
}
