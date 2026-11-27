import crypto from "node:crypto";
import { Request, Response } from "express";

export const SESSION_COOKIE = "rh_session";
export const SESSION_TTL_S = 24 * 60 * 60; // 24 hours
export const BOOT_TTL_S = 60 * 60; // 1 hour
export const MEDIA_TTL_S = 15 * 60; // 15 minutes

export interface SessionPayload {
  typ: "studio-session" | "studio-boot" | "studio-media";
  sid: string;
  uid?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
  jid?: string;
  iat: number;
  exp: number;
}

export class SessionManager {
  private readonly secret: Buffer;
  private readonly revoked = new Map<string, number>();

  constructor(apiKey: string) {
    const rawSecret =
      process.env.SESSION_SECRET ||
      (apiKey
        ? crypto
            .createHmac("sha256", "reelhouse-studio-session-v1")
            .update(apiKey)
            .digest("hex")
        : crypto.randomBytes(32).toString("hex"));
    this.secret = Buffer.from(rawSecret, "utf-8");

    const cleanupTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [sid, exp] of this.revoked.entries()) {
        if (exp <= now) this.revoked.delete(sid);
      }
    }, 60_000);
    cleanupTimer.unref();
  }

  private sign(payload: SessionPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
    const sig = crypto
      .createHmac("sha256", this.secret)
      .update(body)
      .digest("base64url");
    return `${body}.${sig}`;
  }

  private verify(token: string, expectedTyp: SessionPayload["typ"]): SessionPayload | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;

    const expectedSig = crypto
      .createHmac("sha256", this.secret)
      .update(body)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
      if (parsed.typ !== expectedTyp || typeof parsed.sid !== "string") {
        return null;
      }
      const now = Math.floor(Date.now() / 1000);
      if (typeof parsed.exp !== "number" || parsed.exp <= now) {
        return null;
      }
      if (this.revoked.has(parsed.sid)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  issueBootToken(): string {
    const now = Math.floor(Date.now() / 1000);
    return this.sign({
      typ: "studio-boot",
      sid: "boot_" + crypto.randomBytes(8).toString("hex"),
      iat: now,
      exp: now + BOOT_TTL_S,
    });
  }

  verifyBootToken(token: string): SessionPayload | null {
    return this.verify(token, "studio-boot");
  }

  issueSessionToken(user?: {
    uid: string;
    email?: string | null;
    emailVerified?: boolean;
    name?: string | null;
  }): { token: string; payload: SessionPayload } {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      typ: "studio-session",
      sid: "sess_" + crypto.randomBytes(12).toString("hex"),
      ...(user
        ? {
            uid: user.uid,
            email: user.email ?? null,
            emailVerified: Boolean(user.emailVerified),
            name: user.name ?? null,
          }
        : {}),
      iat: now,
      exp: now + SESSION_TTL_S,
    };
    return { token: this.sign(payload), payload };
  }

  verifySessionToken(token: string): SessionPayload | null {
    return this.verify(token, "studio-session");
  }

  issueMediaToken(
    jid: string,
    parentSid: string,
    uid?: string | null
  ): { token: string; payload: SessionPayload } {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      typ: "studio-media",
      sid: parentSid || "sess_open",
      ...(uid ? { uid } : {}),
      jid,
      iat: now,
      exp: now + MEDIA_TTL_S,
    };
    return { token: this.sign(payload), payload };
  }

  verifyMediaToken(token: string, expectedJid: string): SessionPayload | null {
    const parsed = this.verify(token, "studio-media");
    if (!parsed || parsed.jid !== expectedJid) {
      return null;
    }
    return parsed;
  }

  revoke(payload: SessionPayload): void {
    const now = Math.floor(Date.now() / 1000);
    // Keep revocation entry at least through session/media TTLs so logout invalidates derived tokens.
    this.revoked.set(payload.sid, Math.max(payload.exp, now + SESSION_TTL_S));
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const fwd = req.get("x-forwarded-proto");
  if (fwd && fwd.split(",")[0].trim().toLowerCase() === "https") {
    return true;
  }
  const forwarded = req.get("forwarded") || "";
  if (/proto=https\b/i.test(forwarded)) {
    return true;
  }
  const origin = req.get("origin") || "";
  if (origin.startsWith("https://")) {
    return true;
  }
  const referer = req.get("referer") || "";
  if (referer.startsWith("https://")) {
    return true;
  }
  const host = (req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .split(":")[0];
  if (
    host.endsWith(".run.app") ||
    host.endsWith(".web.app") ||
    host.endsWith(".firebaseapp.com")
  ) {
    return true;
  }
  return false;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${SESSION_TTL_S}`,
    ...(isHttpsRequest(req) ? ["SameSite=None", "Secure", "Partitioned"] : ["SameSite=Lax"]),
  ];
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0",
    ...(isHttpsRequest(req) ? ["SameSite=None", "Secure", "Partitioned"] : ["SameSite=Lax"]),
  ];
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function normalizeHostHeader(val: string): string {
  return val
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/:(80|443)$/, "");
}

export function verifySameOriginCsrf(req: Request): boolean {
  const origin = req.get("origin");
  const candidateHosts = [req.get("x-forwarded-host") || "", req.get("host") || ""]
    .map(normalizeHostHeader)
    .filter(Boolean);

  if (origin) {
    try {
      const originHost = normalizeHostHeader(new URL(origin).host);
      if (candidateHosts.length === 0 || !candidateHosts.includes(originHost)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return req.get("x-requested-with") === "ReelhouseStudio" || Boolean(origin);
}
