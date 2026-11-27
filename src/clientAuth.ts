import { FirebaseApp, getApps, initializeApp } from "firebase/app";
import {
  Auth,
  GoogleAuthProvider,
  User,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  inMemoryPersistence,
  onAuthStateChanged as fbOnAuthStateChanged,
  onIdTokenChanged as fbOnIdTokenChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  updateProfile,
} from "firebase/auth";

export interface PublicFirebaseConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface StudioAuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  providerIds: string[];
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let initializedKey = "";
let initPromise: Promise<boolean> | null = null;
let persistenceReady: Promise<void> | null = null;

function serializeUser(user: User | null): StudioAuthUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    displayName: user.displayName,
    photoURL: user.photoURL,
    providerIds: (user.providerData || []).map((p) => p.providerId).filter(Boolean),
  };
}

async function ensurePersistence(authInstance: Auth): Promise<void> {
  if (!persistenceReady) {
    persistenceReady = (async () => {
      try {
        await setPersistence(authInstance, browserLocalPersistence);
      } catch {
        try {
          await setPersistence(authInstance, browserSessionPersistence);
        } catch {
          await setPersistence(authInstance, inMemoryPersistence);
        }
      }
    })();
  }
  await persistenceReady;
}

export async function initFirebaseAuth(config: PublicFirebaseConfig | null): Promise<boolean> {
  if (!config || !config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
    return false;
  }
  const key = `${config.projectId}:${config.appId}:${config.apiKey}`;
  if (app && auth && initializedKey === key) {
    await ensurePersistence(auth);
    return true;
  }
  if (initPromise && initializedKey === key) {
    return initPromise;
  }
  initializedKey = key;
  initPromise = (async () => {
    try {
      app = getApps().length ? getApps()[0] : initializeApp(config);
      auth = getAuth(app);
      await ensurePersistence(auth);
      return true;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();
  return initPromise;
}

export function getFirebaseApp(): FirebaseApp | null {
  if (app) return app;
  const apps = getApps();
  if (apps.length > 0) {
    app = apps[0];
    return app;
  }
  return null;
}

export function getAuthInstance(): Auth | null {
  if (auth) return auth;
  const existing = getFirebaseApp();
  if (existing) {
    auth = getAuth(existing);
    return auth;
  }
  return null;
}

export function isConfigured(): boolean {
  return Boolean(auth);
}

export function getCurrentUser(): StudioAuthUser | null {
  return auth ? serializeUser(auth.currentUser) : null;
}

export async function getIdToken(forceRefresh = false): Promise<string | null> {
  if (!auth?.currentUser) return null;
  return auth.currentUser.getIdToken(forceRefresh);
}

export function onAuthStateChanged(cb: (user: StudioAuthUser | null) => void): () => void {
  if (!auth) {
    cb(null);
    return () => {};
  }
  return fbOnAuthStateChanged(auth, (u) => cb(serializeUser(u)));
}

export function onIdTokenChanged(cb: (user: StudioAuthUser | null) => void): () => void {
  if (!auth) {
    return () => {};
  }
  return fbOnIdTokenChanged(auth, (u) => cb(serializeUser(u)));
}

export async function signInWithGoogle(): Promise<StudioAuthUser> {
  if (!auth) throw new Error("Firebase Authentication is not configured.");
  await ensurePersistence(auth);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const cred = await signInWithPopup(auth, provider);
  return serializeUser(cred.user)!;
}

export async function registerWithEmail(
  email: string,
  password: string,
  displayName?: string
): Promise<StudioAuthUser> {
  if (!auth) throw new Error("Firebase Authentication is not configured.");
  await ensurePersistence(auth);
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const cleanName = (displayName || "").trim();
  if (cleanName) {
    try {
      await updateProfile(cred.user, { displayName: cleanName.slice(0, 80) });
    } catch {
      // Non-fatal if profile display name update fails
    }
  }
  return serializeUser(cred.user)!;
}

export async function loginWithEmail(email: string, password: string): Promise<StudioAuthUser> {
  if (!auth) throw new Error("Firebase Authentication is not configured.");
  await ensurePersistence(auth);
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return serializeUser(cred.user)!;
}

export async function resetPassword(email: string): Promise<void> {
  if (!auth) throw new Error("Firebase Authentication is not configured.");
  await sendPasswordResetEmail(auth, email.trim());
}

export async function signOut(): Promise<void> {
  if (!auth) return;
  await fbSignOut(auth);
}
