import fs from "node:fs";
import path from "node:path";
import { App, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export interface FirebaseClientConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
}

export type TokenVerifyFailureReason = "expired" | "invalid" | "network" | "misconfigured";

export type TokenVerifyResult =
  | { ok: true; user: VerifiedFirebaseUser }
  | { ok: false; reason: TokenVerifyFailureReason; message: string };

export type FirebaseTokenVerifierFn = (
  idToken: string
) => Promise<VerifiedFirebaseUser | null>;

export function loadFirebaseConfig(
  configPath = process.env.FIREBASE_CONFIG_PATH || "firebase-applet-config.json"
): FirebaseClientConfig | null {
  let fileRaw: Partial<FirebaseClientConfig> = {};
  const resolved = path.resolve(configPath);
  if (fs.existsSync(resolved)) {
    try {
      fileRaw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as Partial<FirebaseClientConfig>;
    } catch {
      fileRaw = {};
    }
  }

  const projectId = (process.env.FIREBASE_PROJECT_ID || fileRaw.projectId || "").trim();
  const appId = (process.env.FIREBASE_APP_ID || fileRaw.appId || "").trim();
  const apiKey = (process.env.FIREBASE_API_KEY || fileRaw.apiKey || "").trim();
  const authDomain = (process.env.FIREBASE_AUTH_DOMAIN || fileRaw.authDomain || "").trim();
  const firestoreDatabaseId = (
    process.env.FIREBASE_DATABASE_ID ||
    fileRaw.firestoreDatabaseId ||
    ""
  ).trim();
  const storageBucket = (process.env.FIREBASE_STORAGE_BUCKET || fileRaw.storageBucket || "").trim();
  const messagingSenderId = (
    process.env.FIREBASE_MESSAGING_SENDER_ID ||
    fileRaw.messagingSenderId ||
    ""
  ).trim();

  if (
    !projectId ||
    projectId === "remixed-project-id" ||
    !apiKey ||
    !authDomain ||
    !appId
  ) {
    return null;
  }

  return {
    projectId,
    appId,
    apiKey,
    authDomain,
    ...(firestoreDatabaseId ? { firestoreDatabaseId } : {}),
    ...(storageBucket ? { storageBucket } : {}),
    ...(messagingSenderId ? { messagingSenderId } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`) as Error & { code?: string };
      err.code = "ETIMEDOUT";
      reject(err);
    }, ms);
    timer.unref();
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class FirebaseTokenVerifier {
  private app: App | null = null;

  constructor(readonly config: FirebaseClientConfig | null) {}

  isEnabled(): boolean {
    return Boolean(this.config);
  }

  getPublicConfig(): FirebaseClientConfig | null {
    return this.config;
  }

  private getAdminApp(): App {
    if (!this.config) {
      throw new Error("Firebase is not configured");
    }
    if (!this.app) {
      this.app = getApps().length
        ? getApp()
        : initializeApp({ projectId: this.config.projectId });
    }
    return this.app;
  }

  async verifyIdTokenDetailed(idToken: string): Promise<TokenVerifyResult> {
    if (!this.config) {
      return {
        ok: false,
        reason: "misconfigured",
        message: "Firebase Authentication is not configured on this server.",
      };
    }
    if (!idToken || typeof idToken !== "string" || idToken.split(".").length !== 3) {
      return {
        ok: false,
        reason: "invalid",
        message: "Invalid Firebase ID token format. Please sign in again.",
      };
    }
    try {
      const decoded = await withTimeout(
        getAuth(this.getAdminApp()).verifyIdToken(idToken),
        10_000,
        "Firebase verifyIdToken"
      );
      if (!decoded.uid) {
        return {
          ok: false,
          reason: "invalid",
          message: "Firebase ID token is missing user identity.",
        };
      }
      return {
        ok: true,
        user: {
          uid: decoded.uid,
          email: typeof decoded.email === "string" ? decoded.email : null,
          name: typeof decoded.name === "string" ? decoded.name : null,
          picture: typeof decoded.picture === "string" ? decoded.picture : null,
          emailVerified: Boolean(decoded.email_verified),
        },
      };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const code = String(e?.code || "");
      const msg = String(e?.message || "Unknown verification error");
      console.warn(`[reelhouse] Firebase ID token verification failed (${code || "error"}): ${msg}`);

      if (code === "auth/id-token-expired" || /expired/i.test(msg)) {
        return {
          ok: false,
          reason: "expired",
          message: "Firebase sign-in token expired. Refreshing authentication and retrying…",
        };
      }
      if (
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "ENOTFOUND" ||
        /public keys|fetch|network|timed out|socket/i.test(msg)
      ) {
        return {
          ok: false,
          reason: "network",
          message: "Temporarily unable to verify Firebase credentials. Please retry.",
        };
      }
      return {
        ok: false,
        reason: "invalid",
        message: "Invalid or expired Firebase sign-in. Please sign in again.",
      };
    }
  }

  async verifyIdToken(idToken: string): Promise<VerifiedFirebaseUser | null> {
    const result = await this.verifyIdTokenDetailed(idToken);
    return result.ok ? result.user : null;
  }
}
