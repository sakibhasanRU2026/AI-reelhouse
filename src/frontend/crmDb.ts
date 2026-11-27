import {
  CollectionReference,
  DocumentData,
  Firestore,
  QueryConstraint,
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { Auth } from "firebase/auth";
import {
  PublicFirebaseConfig,
  getAuthInstance,
  getFirebaseApp,
  initFirebaseAuth,
} from "../clientAuth.js";
import {
  ActivityLogRecord,
  ApprovalRecord,
  AssetRecord,
  AspectRatio,
  ClientRecord,
  ContentIdeaRecord,
  CrmSnapshot,
  FeedbackRecord,
  IdeaScriptStatus,
  ProjectRecord,
  ProjectStatus,
  PublishingRecord,
  ReferenceAnalysis,
  RenderJobRecord,
  ResolutionPreset,
  ScriptRecord,
  StudioInstructions,
  StudioOperation,
  StudioUserSession,
  VersionApprovalStatus,
  VideoVersionRecord,
  WorkspaceRecord,
  cleanList,
  cleanStr,
  sanitizeId,
} from "./types.js";

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export const BOOTSTRAP_ADMIN_EMAIL = "sakibhasan.ru18@gmail.com";

let dbInstance: Firestore | null = null;
let authInstance: Auth | null = null;
let currentSession: StudioUserSession | null = null;
let connectionVerified = false;
let connectionWarning: string | null = null;

export function getDb(): Firestore {
  if (!dbInstance) {
    throw new Error("Firestore is not initialized.");
  }
  return dbInstance;
}

export function getConnectionDiagnostics(): { verified: boolean; warning: string | null } {
  return { verified: connectionVerified, warning: connectionWarning };
}

export function getSessionProfile(): StudioUserSession | null {
  return currentSession;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const user = authInstance?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: user?.uid ?? null,
      email: user?.email ?? null,
      emailVerified: user?.emailVerified ?? null,
      isAnonymous: user?.isAnonymous ?? null,
      tenantId: user?.tenantId ?? null,
      providerInfo:
        user?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function isoFromField(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return "";
    }
  }
  return "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function sanitizeFirestoreValue(v: unknown, stripNull = true): unknown {
  if (v === undefined) return undefined;
  if (v === null) return stripNull ? undefined : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    return v
      .map((item) => sanitizeFirestoreValue(item, stripNull))
      .filter((item) => item !== undefined);
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const cleaned = sanitizeFirestoreValue(val, stripNull);
      if (cleaned !== undefined) {
        out[k] = cleaned;
      }
    }
    return out;
  }
  // Preserve Firestore FieldValue sentinels (e.g. serverTimestamp(), Timestamp) intact
  return v;
}

export function compactObj<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Allow null inside analytics maps like referenceAnalysis/referenceMetrics only where explicitly typed,
    // otherwise strip undefined and null cleanly across nested plain objects.
    const preserveNull = k === "referenceAnalysis" || k === "referenceMetrics";
    const cleaned = sanitizeFirestoreValue(v, !preserveNull);
    if (cleaned !== undefined) {
      out[k] = cleaned;
    }
  }
  return out as T;
}

const VALID_ASPECT_RATIOS = new Set<AspectRatio>(["9:16", "16:9", "1:1", "4:5"]);

function cleanAspectRatio(v: unknown): AspectRatio | undefined {
  return typeof v === "string" && VALID_ASPECT_RATIOS.has(v as AspectRatio)
    ? (v as AspectRatio)
    : undefined;
}

function isValidFirestoreId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

const VALID_IDEA_STATUSES = new Set<IdeaScriptStatus>([
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "changes_requested",
]);

export async function testConnection(): Promise<boolean> {
  if (!dbInstance) return false;
  try {
    await getDocFromServer(doc(dbInstance, "test", "connection"));
    connectionVerified = true;
    connectionWarning = null;
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("the client is offline")) {
      connectionWarning = "Firestore client is offline. Verify Firebase configuration and network connectivity.";
      console.error("Please check your Firebase configuration.", msg);
      return false;
    }
    // Permission error on synthetic doc still confirms Firestore server reachability
    connectionVerified = true;
    connectionWarning = null;
    return true;
  }
}

let dbKey = "";

export async function initCrmDb(config: PublicFirebaseConfig | null): Promise<StudioUserSession | null> {
  if (!config) return null;
  let app = getFirebaseApp();
  let auth = getAuthInstance();
  if (!app || !auth) {
    const ok = await initFirebaseAuth(config);
    if (!ok) {
      throw new Error("Firebase App/Auth configuration is missing or invalid.");
    }
    app = getFirebaseApp();
    auth = getAuthInstance();
  }
  if (!app || !auth) {
    throw new Error("Firebase App/Auth must be initialized before CRM Firestore.");
  }
  authInstance = auth;
  const targetKey = `${config.projectId}:${config.firestoreDatabaseId || "(default)"}`;
  if (!dbInstance || dbKey !== targetKey) {
    dbInstance = config.firestoreDatabaseId
      ? getFirestore(app, config.firestoreDatabaseId)
      : getFirestore(app);
    dbKey = targetKey;
  }

  await testConnection();

  const fbUser = auth.currentUser;
  if (!fbUser) {
    currentSession = null;
    return null;
  }

  const emailLower = (fbUser.email || "").trim().toLowerCase();
  const isBootstrap = Boolean(fbUser.emailVerified && emailLower === BOOTSTRAP_ADMIN_EMAIL);

  let isAdmin = isBootstrap;
  if (!isAdmin) {
    const adminPath = `admins/${fbUser.uid}`;
    try {
      const adminSnap = await getDoc(doc(dbInstance, "admins", fbUser.uid));
      if (adminSnap.exists()) {
        isAdmin = true;
      }
    } catch (err) {
      // Non-admin read denial should not crash boot; fall back to client role
      console.warn("[crmDb] admin check note:", adminPath, err);
    }
  } else {
    // Ensure trusted bootstrap admin lookup document exists
    const adminPath = `admins/${fbUser.uid}`;
    try {
      const adminRef = doc(dbInstance, "admins", fbUser.uid);
      const snap = await getDoc(adminRef);
      if (!snap.exists()) {
        await setDoc(adminRef, {
          uid: fbUser.uid,
          email: fbUser.email || BOOTSTRAP_ADMIN_EMAIL,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, adminPath);
    }
  }

  const userPath = `users/${fbUser.uid}`;
  let resolvedRole: "admin" | "client" = isAdmin ? "admin" : "client";
  try {
    const userRef = doc(dbInstance, "users", fbUser.uid);
    const existingSnap = await getDoc(userRef);
    const cleanName = cleanStr(fbUser.displayName, 120);
    const cleanPhoto = cleanStr(fbUser.photoURL, 500);
    if (!existingSnap.exists()) {
      await setDoc(
        userRef,
        compactObj({
          uid: fbUser.uid,
          email: (fbUser.email || `${fbUser.uid}@reelhouse.local`).slice(0, 320),
          displayName: cleanName,
          photoURL: cleanPhoto,
          role: resolvedRole,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      const data = existingSnap.data();
      if (data?.role === "admin" && isAdmin) {
        resolvedRole = "admin";
      } else if (isAdmin && data?.role !== "admin") {
        await updateDoc(
          userRef,
          compactObj({
            role: "admin",
            displayName: cleanName,
            photoURL: cleanPhoto,
            updatedAt: serverTimestamp(),
          })
        );
        resolvedRole = "admin";
      } else {
        resolvedRole = data?.role === "admin" ? "admin" : "client";
        await updateDoc(
          userRef,
          compactObj({
            displayName: cleanName,
            photoURL: cleanPhoto,
            updatedAt: serverTimestamp(),
          })
        );
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }

  currentSession = {
    uid: fbUser.uid,
    email: fbUser.email,
    emailVerified: Boolean(fbUser.emailVerified),
    displayName: fbUser.displayName,
    photoURL: fbUser.photoURL,
    role: resolvedRole,
    isBootstrapAdmin: isBootstrap,
  };

  return currentSession;
}

async function listScopedCollection<T>(
  colName: string,
  mapper: (id: string, data: DocumentData) => T
): Promise<T[]> {
  const db = getDb();
  const session = currentSession;
  if (!session) return [];

  const colRef: CollectionReference<DocumentData> = collection(db, colName);

  // Pillar 8: allow list uses isBootstrapAdmin() or direct field filters matching ownerUid/clientUid/clientEmail
  if (session.isBootstrapAdmin) {
    try {
      const snap = await getDocs(colRef);
      return snap.docs.map((d) => mapper(d.id, d.data()));
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, colName);
    }
  }

  const queries: Array<QueryConstraint[]> = [
    [where("ownerUid", "==", session.uid)],
    [where("clientUid", "==", session.uid)],
  ];
  if (session.emailVerified && session.email) {
    queries.push([where("clientEmail", "==", session.email.trim().toLowerCase())]);
  }

  const merged = new Map<string, T>();
  try {
    const snapshots = await Promise.all(queries.map((qc) => getDocs(query(colRef, ...qc))));
    for (const snap of snapshots) {
      for (const d of snap.docs) {
        if (!merged.has(d.id)) {
          merged.set(d.id, mapper(d.id, d.data()));
        }
      }
    }
    return Array.from(merged.values());
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colName);
  }
}

function safeStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function safeNumberList(v: unknown): number[] {
  return Array.isArray(v)
    ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    : [];
}

function normalizeInstructions(v: unknown): StudioInstructions | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as Record<string, unknown>;
  return {
    schema_version: "1.0",
    resolution_preset:
      raw.resolution_preset === "preview_720p" ? "preview_720p" : "export_1080p",
    operations: Array.isArray(raw.operations)
      ? (raw.operations.filter((o) => Boolean(o && typeof o === "object")) as StudioOperation[])
      : [],
  };
}

function normalizeReferenceAnalysis(v: unknown): ReferenceAnalysis | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as Record<string, unknown>;
  const ar = String(raw.aspect_ratio || "9:16");
  return {
    duration_s: typeof raw.duration_s === "number" && Number.isFinite(raw.duration_s) ? raw.duration_s : 0,
    width: typeof raw.width === "number" && Number.isFinite(raw.width) ? raw.width : 0,
    height: typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : 0,
    aspect_ratio: (["9:16", "16:9", "1:1", "4:5"].includes(ar) ? ar : "9:16") as AspectRatio,
    has_audio: Boolean(raw.has_audio),
    mean_volume_db: typeof raw.mean_volume_db === "number" && Number.isFinite(raw.mean_volume_db) ? raw.mean_volume_db : null,
    max_volume_db: typeof raw.max_volume_db === "number" && Number.isFinite(raw.max_volume_db) ? raw.max_volume_db : null,
    scene_cuts_s: safeNumberList(raw.scene_cuts_s),
    recommended_intro_end_s:
      typeof raw.recommended_intro_end_s === "number" && Number.isFinite(raw.recommended_intro_end_s)
        ? raw.recommended_intro_end_s
        : null,
  };
}

function mapClient(id: string, d: DocumentData): ClientRecord {
  const rawPrefs = d.contentPreferences && typeof d.contentPreferences === "object"
    ? (d.contentPreferences as Record<string, unknown>)
    : {};
  const rawSocial = d.socialAccounts && typeof d.socialAccounts === "object"
    ? (d.socialAccounts as Record<string, unknown>)
    : {};
  return {
    clientId: String(d.clientId || id).trim(),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    name: String(d.name || "Untitled Client"),
    company: typeof d.company === "string" ? d.company : undefined,
    industry: typeof d.industry === "string" ? d.industry : undefined,
    niche: typeof d.niche === "string" ? d.niche : undefined,
    targetAudience: typeof d.targetAudience === "string" ? d.targetAudience : undefined,
    brandGuidelines: typeof d.brandGuidelines === "string" ? d.brandGuidelines : undefined,
    brandColors: safeStringList(d.brandColors),
    preferredFonts: safeStringList(d.preferredFonts),
    referenceLinks: safeStringList(d.referenceLinks),
    contentPreferences: compactObj({
      tone: typeof rawPrefs.tone === "string" ? rawPrefs.tone : undefined,
      aspectRatio: typeof rawPrefs.aspectRatio === "string" ? (rawPrefs.aspectRatio as AspectRatio) : undefined,
      approvedTags: safeStringList(rawPrefs.approvedTags),
      captionStyle: typeof rawPrefs.captionStyle === "string" ? rawPrefs.captionStyle : undefined,
    }),
    socialAccounts: compactObj({
      instagram: typeof rawSocial.instagram === "string" ? rawSocial.instagram : undefined,
      tiktok: typeof rawSocial.tiktok === "string" ? rawSocial.tiktok : undefined,
      youtube: typeof rawSocial.youtube === "string" ? rawSocial.youtube : undefined,
    }),
    status: d.status === "archived" ? "archived" : "active",
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapWorkspace(id: string, d: DocumentData): WorkspaceRecord {
  return {
    workspaceId: String(d.workspaceId || id).trim(),
    clientId: String(d.clientId || "").trim(),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    name: String(d.name || "Workspace"),
    defaultAspectRatio: (d.defaultAspectRatio as AspectRatio) || "9:16",
    defaultResolution: (d.defaultResolution as ResolutionPreset) || "export_1080p",
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapIdea(id: string, d: DocumentData): ContentIdeaRecord {
  return {
    ideaId: String(d.ideaId || id).trim(),
    clientId: String(d.clientId || "").trim(),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    title: String(d.title || ""),
    hook: typeof d.hook === "string" ? d.hook : undefined,
    category: typeof d.category === "string" ? d.category : undefined,
    niche: typeof d.niche === "string" ? d.niche : undefined,
    tags: safeStringList(d.tags),
    referenceLinks: safeStringList(d.referenceLinks),
    notes: typeof d.notes === "string" ? d.notes : undefined,
    status: (d.status as IdeaScriptStatus) || "draft",
    reviewNote: typeof d.reviewNote === "string" ? d.reviewNote : undefined,
    reviewedBy: typeof d.reviewedBy === "string" ? d.reviewedBy : undefined,
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapScript(id: string, d: DocumentData): ScriptRecord {
  return {
    scriptId: String(d.scriptId || id).trim(),
    ideaId: typeof d.ideaId === "string" ? d.ideaId : undefined,
    clientId: String(d.clientId || "").trim(),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    title: String(d.title || "Untitled Script"),
    hook: typeof d.hook === "string" ? d.hook : undefined,
    talkingPoints: safeStringList(d.talkingPoints),
    cta: typeof d.cta === "string" ? d.cta : undefined,
    captionText: typeof d.captionText === "string" ? d.captionText : undefined,
    estimatedDurationS: typeof d.estimatedDurationS === "number" ? d.estimatedDurationS : undefined,
    status: (d.status as IdeaScriptStatus) || "draft",
    reviewNote: typeof d.reviewNote === "string" ? d.reviewNote : undefined,
    reviewedBy: typeof d.reviewedBy === "string" ? d.reviewedBy : undefined,
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapProject(id: string, d: DocumentData): ProjectRecord {
  return {
    projectId: String(d.projectId || id).trim(),
    title: String(d.title || "Untitled Project"),
    clientId: String(d.clientId || "").trim(),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    ideaId: typeof d.ideaId === "string" ? d.ideaId : undefined,
    scriptId: typeof d.scriptId === "string" ? d.scriptId : undefined,
    sourceAssetId: typeof d.sourceAssetId === "string" ? d.sourceAssetId : undefined,
    referenceAssetId: typeof d.referenceAssetId === "string" ? d.referenceAssetId : undefined,
    referenceMetrics: normalizeReferenceAnalysis(d.referenceMetrics),
    editingInstructions: normalizeInstructions(d.editingInstructions),
    targetAspectRatio: (d.targetAspectRatio as AspectRatio) || "9:16",
    targetDurationS: typeof d.targetDurationS === "number" ? d.targetDurationS : undefined,
    captionPreferences:
      d.captionPreferences && typeof d.captionPreferences === "object"
        ? (d.captionPreferences as ProjectRecord["captionPreferences"])
        : undefined,
    deadline: typeof d.deadline === "string" ? d.deadline : undefined,
    status: (d.status as ProjectStatus) || "Draft",
    latestVersionNumber: typeof d.latestVersionNumber === "number" ? d.latestVersionNumber : 0,
    latestJobId: typeof d.latestJobId === "string" ? d.latestJobId : undefined,
    approvedVersionNumber:
      typeof d.approvedVersionNumber === "number" ? d.approvedVersionNumber : undefined,
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapAsset(id: string, d: DocumentData): AssetRecord {
  return {
    assetId: String(d.assetId || id),
    projectId: String(d.projectId || ""),
    clientId: String(d.clientId || ""),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    kind: d.kind === "reference" ? "reference" : "source",
    filename: String(d.filename || "video.mp4"),
    mimeType: typeof d.mimeType === "string" ? d.mimeType : undefined,
    sizeBytes: typeof d.sizeBytes === "number" ? d.sizeBytes : undefined,
    durationS: typeof d.durationS === "number" ? d.durationS : undefined,
    width: typeof d.width === "number" ? d.width : undefined,
    height: typeof d.height === "number" ? d.height : undefined,
    storageProvider: d.storageProvider === "r2" ? "r2" : "local_temp",
    available: Boolean(d.available),
    expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : undefined,
    referenceAnalysis: normalizeReferenceAnalysis(d.referenceAnalysis),
    createdAt: isoFromField(d.createdAt),
  };
}

function mapRenderJob(id: string, d: DocumentData): RenderJobRecord {
  return {
    jobId: String(d.jobId || id),
    projectId: typeof d.projectId === "string" ? d.projectId : undefined,
    clientId: typeof d.clientId === "string" ? d.clientId : undefined,
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    versionNumber: typeof d.versionNumber === "number" ? d.versionNumber : undefined,
    status: (d.status as RenderJobRecord["status"]) || "queued",
    progress: typeof d.progress === "number" ? d.progress : 0,
    error: typeof d.error === "string" ? d.error : undefined,
    durationS: typeof d.durationS === "number" ? d.durationS : undefined,
    resolutionPreset: (d.resolutionPreset as ResolutionPreset) || undefined,
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapVideoVersion(id: string, d: DocumentData): VideoVersionRecord {
  return {
    versionId: String(d.versionId || id),
    projectId: String(d.projectId || ""),
    clientId: String(d.clientId || ""),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    versionNumber: typeof d.versionNumber === "number" ? d.versionNumber : 1,
    jobId: String(d.jobId || ""),
    instructions: normalizeInstructions(d.instructions),
    revisionNotes: typeof d.revisionNotes === "string" ? d.revisionNotes : undefined,
    approvalStatus: (d.approvalStatus as VersionApprovalStatus) || "pending_review",
    outputAvailable: Boolean(d.outputAvailable),
    durationS: typeof d.durationS === "number" ? d.durationS : undefined,
    aspectRatio: (d.aspectRatio as AspectRatio) || undefined,
    resolutionPreset: (d.resolutionPreset as ResolutionPreset) || undefined,
    approvedBy: typeof d.approvedBy === "string" ? d.approvedBy : undefined,
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapFeedback(id: string, d: DocumentData): FeedbackRecord {
  return {
    feedbackId: String(d.feedbackId || id),
    projectId: String(d.projectId || ""),
    versionId: String(d.versionId || ""),
    versionNumber: typeof d.versionNumber === "number" ? d.versionNumber : undefined,
    clientId: String(d.clientId || ""),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    authorUid: String(d.authorUid || ""),
    authorEmail: typeof d.authorEmail === "string" ? d.authorEmail : undefined,
    timestampS: typeof d.timestampS === "number" ? d.timestampS : undefined,
    comment: String(d.comment || ""),
    matchedRules: safeStringList(d.matchedRules),
    clarificationNeeded: Boolean(d.clarificationNeeded),
    triggeredRevisionJobId:
      typeof d.triggeredRevisionJobId === "string" ? d.triggeredRevisionJobId : undefined,
    status: (d.status as FeedbackRecord["status"]) || "open",
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapApproval(id: string, d: DocumentData): ApprovalRecord {
  return {
    approvalId: String(d.approvalId || id),
    targetType: (d.targetType as ApprovalRecord["targetType"]) || "video_version",
    targetId: String(d.targetId || ""),
    projectId: typeof d.projectId === "string" ? d.projectId : undefined,
    clientId: String(d.clientId || ""),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    versionNumber: typeof d.versionNumber === "number" ? d.versionNumber : undefined,
    decision: (d.decision as ApprovalRecord["decision"]) || "approved",
    note: typeof d.note === "string" ? d.note : undefined,
    decidedByUid: String(d.decidedByUid || ""),
    decidedByEmail: typeof d.decidedByEmail === "string" ? d.decidedByEmail : undefined,
    createdAt: isoFromField(d.createdAt),
  };
}

function mapPublishingRecord(id: string, d: DocumentData): PublishingRecord {
  return {
    recordId: String(d.recordId || id),
    projectId: String(d.projectId || ""),
    versionId: String(d.versionId || ""),
    versionNumber: typeof d.versionNumber === "number" ? d.versionNumber : undefined,
    clientId: String(d.clientId || ""),
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    title: String(d.title || "Scheduled Cut"),
    platform: d.platform === "tiktok" ? "tiktok" : "instagram",
    caption: typeof d.caption === "string" ? d.caption : undefined,
    hashtags: safeStringList(d.hashtags),
    templateName: typeof d.templateName === "string" ? d.templateName : undefined,
    plannedDate: String(d.plannedDate || ""),
    readiness: (d.readiness as PublishingRecord["readiness"]) || "draft",
    integrationStatus: d.integrationStatus === "connected" ? "connected" : "not_connected",
    createdAt: isoFromField(d.createdAt),
    updatedAt: isoFromField(d.updatedAt),
  };
}

function mapActivityLog(id: string, d: DocumentData): ActivityLogRecord {
  return {
    logId: String(d.logId || id),
    clientId: typeof d.clientId === "string" ? d.clientId : undefined,
    projectId: typeof d.projectId === "string" ? d.projectId : undefined,
    ownerUid: String(d.ownerUid || ""),
    clientUid: typeof d.clientUid === "string" ? d.clientUid : undefined,
    clientEmail: typeof d.clientEmail === "string" ? d.clientEmail : undefined,
    actorUid: String(d.actorUid || ""),
    actorEmail: typeof d.actorEmail === "string" ? d.actorEmail : undefined,
    action: String(d.action || ""),
    summary: String(d.summary || ""),
    createdAt: isoFromField(d.createdAt),
  };
}

function sortDesc<T extends { updatedAt?: string; createdAt?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const tb = Date.parse(b.updatedAt || b.createdAt || "") || 0;
    const ta = Date.parse(a.updatedAt || a.createdAt || "") || 0;
    return tb - ta;
  });
}

export async function loadCrmSnapshot(): Promise<CrmSnapshot> {
  const [
    clients,
    workspaces,
    ideas,
    scripts,
    projects,
    assets,
    renderJobs,
    videoVersions,
    feedback,
    approvals,
    publishingRecords,
    activityLogs,
  ] = await Promise.all([
    listScopedCollection("clients", mapClient),
    listScopedCollection("workspaces", mapWorkspace),
    listScopedCollection("contentIdeas", mapIdea),
    listScopedCollection("scripts", mapScript),
    listScopedCollection("projects", mapProject),
    listScopedCollection("assets", mapAsset),
    listScopedCollection("renderJobs", mapRenderJob),
    listScopedCollection("videoVersions", mapVideoVersion),
    listScopedCollection("feedback", mapFeedback),
    listScopedCollection("approvals", mapApproval),
    listScopedCollection("publishingRecords", mapPublishingRecord),
    listScopedCollection("activityLogs", mapActivityLog),
  ]);

  return {
    clients: sortDesc(clients),
    workspaces: sortDesc(workspaces),
    ideas: sortDesc(ideas),
    scripts: sortDesc(scripts),
    projects: sortDesc(projects),
    assets: sortDesc(assets),
    renderJobs: sortDesc(renderJobs),
    videoVersions: [...videoVersions].sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0)),
    feedback: sortDesc(feedback),
    approvals: sortDesc(approvals),
    publishingRecords: [...publishingRecords].sort((a, b) =>
      String(a.plannedDate || "").localeCompare(String(b.plannedDate || ""))
    ),
    activityLogs: sortDesc(activityLogs).slice(0, 60),
  };
}

export async function logActivity(params: {
  clientId?: string;
  projectId?: string;
  ownerUid?: string;
  clientUid?: string;
  clientEmail?: string;
  action: string;
  summary: string;
}): Promise<void> {
  const session = currentSession;
  if (!session) return;
  const db = getDb();
  const logId = sanitizeId("log");
  const path = `activityLogs/${logId}`;
  try {
    await setDoc(
      doc(db, "activityLogs", logId),
      compactObj({
        logId,
        clientId: cleanStr(params.clientId, 128),
        projectId: cleanStr(params.projectId, 128),
        ownerUid: cleanStr(params.ownerUid, 128) || session.uid,
        clientUid: cleanStr(params.clientUid, 128),
        clientEmail: cleanStr(params.clientEmail?.toLowerCase(), 320),
        actorUid: session.uid,
        actorEmail: cleanStr(session.email, 320),
        action: cleanStr(params.action, 80) || "activity",
        summary: cleanStr(params.summary, 300) || "Updated CRM item",
        createdAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function recordApprovalDecision(params: {
  targetType: "idea" | "script" | "video_version";
  targetId: string;
  projectId?: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  versionNumber?: number;
  decision: "approved" | "rejected" | "revision_requested";
  note?: string;
}): Promise<void> {
  const session = currentSession;
  if (!session) throw new Error("Not signed in");
  const db = getDb();
  const approvalId = sanitizeId("apr");
  const path = `approvals/${approvalId}`;
  try {
    await setDoc(
      doc(db, "approvals", approvalId),
      compactObj({
        approvalId,
        targetType: params.targetType,
        targetId: params.targetId,
        projectId: cleanStr(params.projectId, 128),
        clientId: params.clientId,
        ownerUid: params.ownerUid,
        clientUid: cleanStr(params.clientUid, 128),
        clientEmail: cleanStr(params.clientEmail?.toLowerCase(), 320),
        versionNumber:
          typeof params.versionNumber === "number" && Number.isInteger(params.versionNumber)
            ? params.versionNumber
            : undefined,
        decision: params.decision,
        note: cleanStr(params.note, 1000),
        decidedByUid: session.uid,
        decidedByEmail: cleanStr(session.email, 320),
        createdAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function saveClient(
  input: Partial<ClientRecord> & { name: string },
  existingClientId?: string
): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required.");
  const db = getDb();
  const isUpdate = Boolean(existingClientId);
  if (isUpdate && !isValidFirestoreId(existingClientId)) {
    throw new Error("Invalid client workspace identifier.");
  }
  const clientName = cleanStr(input.name, 120);
  if (!clientName) {
    throw new Error("Client workspace name is required.");
  }
  const clientId = existingClientId || sanitizeId("cli");
  const docPath = `clients/${clientId}`;

  const rawPrefs = input.contentPreferences;
  const cleanPrefs = compactObj({
    tone: cleanStr(rawPrefs?.tone, 120),
    aspectRatio: cleanAspectRatio(rawPrefs?.aspectRatio),
    captionStyle: cleanStr(rawPrefs?.captionStyle, 80),
    approvedTags: cleanList(rawPrefs?.approvedTags, 30, 40),
  });
  const rawSocial = input.socialAccounts;
  const cleanSocial = compactObj({
    instagram: cleanStr(rawSocial?.instagram, 120),
    tiktok: cleanStr(rawSocial?.tiktok, 120),
    youtube: cleanStr(rawSocial?.youtube, 120),
  });

  const payload = compactObj({
    clientUid: cleanStr(input.clientUid, 128),
    clientEmail: cleanStr(input.clientEmail?.toLowerCase(), 320),
    name: clientName,
    company: cleanStr(input.company, 160),
    industry: cleanStr(input.industry, 120),
    niche: cleanStr(input.niche, 120),
    targetAudience: cleanStr(input.targetAudience, 500),
    brandGuidelines: cleanStr(input.brandGuidelines, 3000),
    brandColors: cleanList(input.brandColors, 8, 24),
    preferredFonts: cleanList(input.preferredFonts, 6, 40),
    referenceLinks: cleanList(input.referenceLinks, 15, 300),
    contentPreferences: cleanPrefs,
    socialAccounts: cleanSocial,
    status: input.status === "archived" ? "archived" : "active",
    updatedAt: serverTimestamp(),
  });

  try {
    if (isUpdate) {
      await updateDoc(doc(db, "clients", clientId), payload);
      await logActivity({
        clientId,
        clientUid: payload.clientUid as string | undefined,
        clientEmail: payload.clientEmail as string | undefined,
        action: "client_updated",
        summary: `Updated client workspace "${payload.name}"`,
      });
    } else {
      await setDoc(doc(db, "clients", clientId), {
        clientId,
        ownerUid: session.uid,
        ...payload,
        createdAt: serverTimestamp(),
      });
      const wsId = sanitizeId("ws");
      await setDoc(
        doc(db, "workspaces", wsId),
        compactObj({
          workspaceId: wsId,
          clientId,
          ownerUid: session.uid,
          clientUid: payload.clientUid as string | undefined,
          clientEmail: payload.clientEmail as string | undefined,
          name: `${payload.name} Workspace`.slice(0, 140),
          defaultAspectRatio:
            (input.contentPreferences?.aspectRatio as AspectRatio) || "9:16",
          defaultResolution: "export_1080p",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await logActivity({
        clientId,
        clientUid: payload.clientUid as string | undefined,
        clientEmail: payload.clientEmail as string | undefined,
        action: "client_created",
        summary: `Created client workspace "${payload.name}"`,
      });
    }
    return clientId;
  } catch (err) {
    handleFirestoreError(
      err,
      isUpdate ? OperationType.UPDATE : OperationType.CREATE,
      docPath
    );
  }
}

const pendingIdeaKeys = new Set<string>();
const pendingIdeaReviews = new Set<string>();

export async function saveIdea(
  input: Partial<ContentIdeaRecord> & { clientId: string; title: string },
  client?: ClientRecord,
  existingIdeaId?: string
): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required.");
  const db = getDb();
  const isUpdate = Boolean(existingIdeaId);
  const resolvedClientId = cleanStr(client?.clientId || input.clientId, 128);
  const cleanedTitle = cleanStr(input.title, 180);
  if (!isValidFirestoreId(resolvedClientId)) {
    throw new Error("A valid client workspace is required.");
  }
  if (!cleanedTitle) {
    throw new Error("Idea title is required.");
  }
  if (isUpdate && !isValidFirestoreId(existingIdeaId)) {
    throw new Error("Invalid content idea identifier.");
  }

  const nextStatus: IdeaScriptStatus | undefined =
    input.status && VALID_IDEA_STATUSES.has(input.status)
      ? input.status
      : isUpdate
        ? undefined
        : "draft";
  const ideaId = existingIdeaId || sanitizeId("idea");
  const docPath = `contentIdeas/${ideaId}`;
  const dedupeKey = `${resolvedClientId}::${cleanedTitle.toLowerCase()}`;

  if (pendingIdeaKeys.has(dedupeKey)) {
    throw new Error("Save already in progress for this content idea.");
  }
  pendingIdeaKeys.add(dedupeKey);

  try {
    // Resolve client record if caller did not pass it so client access fields stay consistent
    let resolvedClient = client;
    if (!resolvedClient) {
      const cliSnap = await getDoc(doc(db, "clients", resolvedClientId));
      if (!cliSnap.exists()) {
        throw new Error("Selected client workspace could not be found.");
      }
      resolvedClient = mapClient(cliSnap.id, cliSnap.data());
    }

    // Check existing scoped ideas for duplicates (same client workspace + normalized title)
    const existingIdeas = await listScopedCollection("contentIdeas", mapIdea);
    const duplicate = existingIdeas.find(
      (i) =>
        i.clientId === resolvedClientId &&
        i.title.trim().toLowerCase() === cleanedTitle.toLowerCase() &&
        i.ideaId !== existingIdeaId
    );
    if (duplicate) {
      throw new Error(
        `A content idea titled "${cleanedTitle}" already exists for this client workspace.`
      );
    }

    if (isUpdate) {
      await updateDoc(
        doc(db, "contentIdeas", ideaId),
        compactObj({
          title: cleanedTitle,
          hook: cleanStr(input.hook, 400),
          category: cleanStr(input.category, 80),
          niche: cleanStr(input.niche, 80),
          tags: cleanList(input.tags, 10, 40),
          referenceLinks: cleanList(input.referenceLinks, 10, 300),
          notes: cleanStr(input.notes, 2000),
          status: nextStatus,
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      await setDoc(
        doc(db, "contentIdeas", ideaId),
        compactObj({
          ideaId,
          clientId: resolvedClientId,
          ownerUid: session.uid,
          clientUid: cleanStr(resolvedClient?.clientUid, 128),
          clientEmail: cleanStr(resolvedClient?.clientEmail?.toLowerCase(), 320),
          title: cleanedTitle,
          hook: cleanStr(input.hook, 400),
          category: cleanStr(input.category, 80),
          niche: cleanStr(input.niche, 80),
          tags: cleanList(input.tags, 10, 40),
          referenceLinks: cleanList(input.referenceLinks, 10, 300),
          notes: cleanStr(input.notes, 2000),
          status: nextStatus || "draft",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await logActivity({
        clientId: resolvedClientId,
        clientUid: resolvedClient?.clientUid,
        clientEmail: resolvedClient?.clientEmail,
        action: "idea_created",
        summary: `Created content idea "${cleanedTitle.slice(0, 80)}"`,
      });
    }
    return ideaId;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("already exists") ||
        err.message.includes("already in progress") ||
        err.message.includes("could not be found"))
    ) {
      throw err;
    }
    handleFirestoreError(
      err,
      isUpdate ? OperationType.UPDATE : OperationType.CREATE,
      docPath
    );
  } finally {
    pendingIdeaKeys.delete(dedupeKey);
  }
}

export async function reviewIdea(
  idea: ContentIdeaRecord,
  decision: IdeaScriptStatus,
  note: string,
  client?: ClientRecord
): Promise<void> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required.");
  if (!isValidFirestoreId(idea?.ideaId)) {
    throw new Error("Invalid content idea identifier.");
  }
  if (!isValidFirestoreId(idea?.clientId)) {
    throw new Error("Content idea is missing a valid client workspace reference.");
  }
  if (!VALID_IDEA_STATUSES.has(decision)) {
    throw new Error("Unsupported approval decision status.");
  }
  if (pendingIdeaReviews.has(idea.ideaId)) {
    throw new Error("Approval update is already in progress for this idea.");
  }
  pendingIdeaReviews.add(idea.ideaId);

  const db = getDb();
  const docPath = `contentIdeas/${idea.ideaId}`;
  const safeOwnerUid = cleanStr(idea.ownerUid, 128) || session.uid;
  const safeNote = decision === "pending_approval" ? "" : cleanStr(note, 1000);
  const safeReviewer = cleanStr(session.email, 320);

  try {
    let resolvedClient = client;
    if (!resolvedClient && decision === "approved" && Array.isArray(idea.tags) && idea.tags.length > 0) {
      try {
        const cliSnap = await getDoc(doc(db, "clients", idea.clientId));
        if (cliSnap.exists()) {
          resolvedClient = mapClient(cliSnap.id, cliSnap.data());
        }
      } catch {
        // Proceed without client doc if unavailable; rule check on clients will apply if needed
      }
    }

    const effectiveClientUid = cleanStr(idea.clientUid || resolvedClient?.clientUid, 128);
    const effectiveClientEmail = cleanStr(
      (idea.clientEmail || resolvedClient?.clientEmail)?.toLowerCase(),
      320
    );

    await updateDoc(
      doc(db, "contentIdeas", idea.ideaId),
      compactObj({
        status: decision,
        reviewNote: safeNote,
        reviewedBy: safeReviewer,
        updatedAt: serverTimestamp(),
      })
    );

    if (decision === "approved" || decision === "rejected" || decision === "changes_requested") {
      await recordApprovalDecision({
        targetType: "idea",
        targetId: idea.ideaId,
        clientId: idea.clientId,
        ownerUid: safeOwnerUid,
        clientUid: effectiveClientUid,
        clientEmail: effectiveClientEmail,
        decision: decision === "changes_requested" ? "revision_requested" : decision,
        note: safeNote,
      });
    }

    if (
      decision === "approved" &&
      resolvedClient &&
      isValidFirestoreId(resolvedClient.clientId) &&
      Array.isArray(idea.tags) &&
      idea.tags.length > 0
    ) {
      const existingTags = safeStringList(resolvedClient.contentPreferences?.approvedTags);
      const cleanIdeaTags = safeStringList(idea.tags)
        .map((t) => t.trim().slice(0, 40))
        .filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...cleanIdeaTags])).slice(0, 30);
      if (mergedTags.length > 0) {
        const sanitizedPrefs = compactObj({
          tone: cleanStr(resolvedClient.contentPreferences?.tone, 120),
          aspectRatio: cleanAspectRatio(resolvedClient.contentPreferences?.aspectRatio),
          captionStyle: cleanStr(resolvedClient.contentPreferences?.captionStyle, 80),
          approvedTags: mergedTags,
        });
        await updateDoc(
          doc(db, "clients", resolvedClient.clientId),
          compactObj({
            contentPreferences: sanitizedPrefs,
            updatedAt: serverTimestamp(),
          })
        );
      }
    }

    await logActivity({
      clientId: idea.clientId,
      ownerUid: safeOwnerUid,
      clientUid: effectiveClientUid,
      clientEmail: effectiveClientEmail,
      action: `idea_${decision}`,
      summary: `Idea "${cleanStr(idea.title, 80) || idea.ideaId}" marked ${decision.replace("_", " ")}`,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("already in progress")) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, docPath);
  } finally {
    pendingIdeaReviews.delete(idea.ideaId);
  }
}

export async function deleteIdea(ideaId: string): Promise<void> {
  if (!isValidFirestoreId(ideaId)) {
    throw new Error("Invalid content idea identifier.");
  }
  const db = getDb();
  try {
    await deleteDoc(doc(db, "contentIdeas", ideaId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `contentIdeas/${ideaId}`);
  }
}

export async function saveScript(
  input: Partial<ScriptRecord> & { clientId: string; title: string },
  client?: ClientRecord,
  existingScriptId?: string
): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required.");
  const db = getDb();
  const isUpdate = Boolean(existingScriptId);
  const resolvedClientId = cleanStr(client?.clientId || input.clientId, 128);
  const cleanedTitle = cleanStr(input.title, 180);
  if (!isValidFirestoreId(resolvedClientId)) {
    throw new Error("A valid client workspace is required.");
  }
  if (!cleanedTitle) {
    throw new Error("Script title is required.");
  }
  if (isUpdate && !isValidFirestoreId(existingScriptId)) {
    throw new Error("Invalid script identifier.");
  }
  const scriptId = existingScriptId || sanitizeId("scr");
  const docPath = `scripts/${scriptId}`;
  const nextStatus: IdeaScriptStatus | undefined =
    input.status && VALID_IDEA_STATUSES.has(input.status)
      ? input.status
      : isUpdate
        ? undefined
        : "draft";

  try {
    if (isUpdate) {
      await updateDoc(
        doc(db, "scripts", scriptId),
        compactObj({
          ideaId: cleanStr(input.ideaId, 128),
          title: cleanedTitle,
          hook: cleanStr(input.hook, 500),
          talkingPoints: cleanList(input.talkingPoints, 20, 400),
          cta: cleanStr(input.cta, 400),
          captionText: cleanStr(input.captionText, 2200),
          estimatedDurationS:
            typeof input.estimatedDurationS === "number" && input.estimatedDurationS >= 0
              ? Math.min(3600, input.estimatedDurationS)
              : undefined,
          status: nextStatus,
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      await setDoc(
        doc(db, "scripts", scriptId),
        compactObj({
          scriptId,
          ideaId: cleanStr(input.ideaId, 128),
          clientId: resolvedClientId,
          ownerUid: session.uid,
          clientUid: cleanStr(client?.clientUid, 128),
          clientEmail: cleanStr(client?.clientEmail?.toLowerCase(), 320),
          title: cleanedTitle,
          hook: cleanStr(input.hook, 500),
          talkingPoints: cleanList(input.talkingPoints, 20, 400),
          cta: cleanStr(input.cta, 400),
          captionText: cleanStr(input.captionText, 2200),
          estimatedDurationS:
            typeof input.estimatedDurationS === "number" && input.estimatedDurationS >= 0
              ? Math.min(3600, input.estimatedDurationS)
              : undefined,
          status: nextStatus || "draft",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await logActivity({
        clientId: resolvedClientId,
        clientUid: client?.clientUid,
        clientEmail: client?.clientEmail,
        action: "script_created",
        summary: `Created script "${cleanedTitle.slice(0, 80)}"`,
      });
    }
    return scriptId;
  } catch (err) {
    handleFirestoreError(
      err,
      isUpdate ? OperationType.UPDATE : OperationType.CREATE,
      docPath
    );
  }
}

export async function reviewScript(
  script: ScriptRecord,
  decision: IdeaScriptStatus,
  note: string
): Promise<void> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required.");
  if (!isValidFirestoreId(script?.scriptId) || !isValidFirestoreId(script?.clientId)) {
    throw new Error("Invalid script reference.");
  }
  if (!VALID_IDEA_STATUSES.has(decision)) {
    throw new Error("Unsupported approval decision status.");
  }
  const db = getDb();
  const docPath = `scripts/${script.scriptId}`;
  const safeOwnerUid = cleanStr(script.ownerUid, 128) || session.uid;
  const safeNote = decision === "pending_approval" ? "" : cleanStr(note, 1000);
  try {
    await updateDoc(
      doc(db, "scripts", script.scriptId),
      compactObj({
        status: decision,
        reviewNote: safeNote,
        reviewedBy: cleanStr(session.email, 320),
        updatedAt: serverTimestamp(),
      })
    );
    if (decision === "approved" || decision === "rejected" || decision === "changes_requested") {
      await recordApprovalDecision({
        targetType: "script",
        targetId: script.scriptId,
        clientId: script.clientId,
        ownerUid: safeOwnerUid,
        clientUid: script.clientUid,
        clientEmail: script.clientEmail,
        decision: decision === "changes_requested" ? "revision_requested" : decision,
        note: safeNote,
      });
    }
    await logActivity({
      clientId: script.clientId,
      ownerUid: safeOwnerUid,
      clientUid: script.clientUid,
      clientEmail: script.clientEmail,
      action: `script_${decision}`,
      summary: `Script "${cleanStr(script.title, 80) || script.scriptId}" marked ${decision.replace("_", " ")}`,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, docPath);
  }
}

export async function deleteScript(scriptId: string): Promise<void> {
  if (!isValidFirestoreId(scriptId)) {
    throw new Error("Invalid script identifier.");
  }
  const db = getDb();
  try {
    await deleteDoc(doc(db, "scripts", scriptId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `scripts/${scriptId}`);
  }
}

const pendingProjectKeys = new Set<string>();

export async function saveProject(
  input: Partial<ProjectRecord> & { clientId: string; title: string },
  client?: ClientRecord,
  existingProjectId?: string
): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required.");
  const db = getDb();
  const isUpdate = Boolean(existingProjectId);
  const resolvedClientId = cleanStr(client?.clientId || input.clientId, 128);
  const cleanedTitle = cleanStr(input.title, 180);
  const cleanedIdeaId = cleanStr(input.ideaId, 128);
  const cleanedScriptId = cleanStr(input.scriptId, 128);
  if (!isValidFirestoreId(resolvedClientId)) {
    throw new Error("A valid client workspace is required.");
  }
  if (!cleanedTitle) {
    throw new Error("Project title is required.");
  }
  if (isUpdate && !isValidFirestoreId(existingProjectId)) {
    throw new Error("Invalid project identifier.");
  }
  const projectId = existingProjectId || sanitizeId("prj");
  const docPath = `projects/${projectId}`;
  const dedupeKey = `${resolvedClientId}::${cleanedScriptId || cleanedTitle.toLowerCase()}`;

  if (!isUpdate && pendingProjectKeys.has(dedupeKey)) {
    throw new Error("Project creation is already in progress.");
  }
  if (!isUpdate) {
    pendingProjectKeys.add(dedupeKey);
  }

  const defaultIns: StudioInstructions = input.editingInstructions || {
    schema_version: "1.0",
    resolution_preset: "export_1080p",
    operations: [
      {
        op: "reframe",
        aspect: cleanAspectRatio(input.targetAspectRatio) || "9:16",
        mode: "crop",
      },
    ],
  };

  const rawCaptionPrefs = input.captionPreferences;
  const cleanCaptionPrefs = compactObj({
    style: cleanStr(rawCaptionPrefs?.style, 40) || "bold-yellow",
    font_family: cleanStr(rawCaptionPrefs?.font_family, 40),
    max_words_per_line:
      typeof rawCaptionPrefs?.max_words_per_line === "number" &&
      Number.isInteger(rawCaptionPrefs.max_words_per_line)
        ? Math.min(12, Math.max(1, rawCaptionPrefs.max_words_per_line))
        : 4,
    hook: cleanStr(rawCaptionPrefs?.hook, 500),
    caption_text: cleanStr(rawCaptionPrefs?.caption_text, 2200),
    brand_tone: cleanStr(rawCaptionPrefs?.brand_tone, 120),
    brand_colors: cleanList(rawCaptionPrefs?.brand_colors, 8, 24),
    preferred_fonts: cleanList(rawCaptionPrefs?.preferred_fonts, 6, 40),
  });

  try {
    let resolvedClient = client;
    if (!resolvedClient) {
      const cliSnap = await getDoc(doc(db, "clients", resolvedClientId));
      if (!cliSnap.exists()) {
        throw new Error("Selected client workspace could not be found.");
      }
      resolvedClient = mapClient(cliSnap.id, cliSnap.data());
    }

    if (!isUpdate) {
      const existingProjects = await listScopedCollection("projects", mapProject);
      const dupTitle = existingProjects.find(
        (p) =>
          p.clientId === resolvedClientId &&
          p.title.trim().toLowerCase() === cleanedTitle.toLowerCase()
      );
      if (dupTitle) {
        throw new Error(
          `A project titled "${cleanedTitle}" already exists for this client workspace.`
        );
      }
      if (cleanedScriptId) {
        const dupScript = existingProjects.find(
          (p) => p.clientId === resolvedClientId && p.scriptId === cleanedScriptId
        );
        if (dupScript) {
          throw new Error(
            `A project ("${dupScript.title}") is already linked to this script in the selected workspace.`
          );
        }
      }
    }

    if (isUpdate) {
      await updateDoc(
        doc(db, "projects", projectId),
        compactObj({
          title: cleanedTitle,
          clientUid: cleanStr(resolvedClient?.clientUid, 128),
          clientEmail: cleanStr(resolvedClient?.clientEmail?.toLowerCase(), 320),
          ideaId: cleanedIdeaId,
          scriptId: cleanedScriptId,
          targetAspectRatio: cleanAspectRatio(input.targetAspectRatio) || "9:16",
          targetDurationS:
            typeof input.targetDurationS === "number" && input.targetDurationS >= 0
              ? Math.min(3600, input.targetDurationS)
              : undefined,
          captionPreferences: cleanCaptionPrefs,
          deadline: cleanStr(input.deadline, 40),
          status: input.status || "Draft",
          editingInstructions: input.editingInstructions,
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      await setDoc(
        doc(db, "projects", projectId),
        compactObj({
          projectId,
          title: cleanedTitle,
          clientId: resolvedClientId,
          ownerUid: session.uid,
          clientUid: cleanStr(resolvedClient?.clientUid, 128),
          clientEmail: cleanStr(resolvedClient?.clientEmail?.toLowerCase(), 320),
          ideaId: cleanedIdeaId,
          scriptId: cleanedScriptId,
          editingInstructions: defaultIns,
          targetAspectRatio: cleanAspectRatio(input.targetAspectRatio) || "9:16",
          targetDurationS:
            typeof input.targetDurationS === "number" && input.targetDurationS >= 0
              ? Math.min(3600, input.targetDurationS)
              : undefined,
          captionPreferences: cleanCaptionPrefs,
          deadline: cleanStr(input.deadline, 40),
          status: input.status || "Awaiting Footage",
          latestVersionNumber: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await logActivity({
        clientId: resolvedClientId,
        projectId,
        clientUid: resolvedClient?.clientUid,
        clientEmail: resolvedClient?.clientEmail,
        action: "project_created",
        summary: `Created project "${cleanedTitle.slice(0, 80)}"`,
      });
    }
    return projectId;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("already exists") ||
        err.message.includes("already linked") ||
        err.message.includes("already in progress") ||
        err.message.includes("could not be found"))
    ) {
      throw err;
    }
    return handleFirestoreError(
      err,
      isUpdate ? OperationType.UPDATE : OperationType.CREATE,
      docPath
    );
  } finally {
    if (!isUpdate) {
      pendingProjectKeys.delete(dedupeKey);
    }
  }
}

export async function updateProjectFields(
  projectId: string,
  fields: Record<string, unknown>
): Promise<void> {
  if (!isValidFirestoreId(projectId)) {
    throw new Error("Invalid project identifier.");
  }
  const db = getDb();
  const docPath = `projects/${projectId}`;
  try {
    await updateDoc(
      doc(db, "projects", projectId),
      compactObj({
        ...fields,
        updatedAt: serverTimestamp(),
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, docPath);
  }
}

export async function saveUploadedAssetMetadata(params: {
  assetId: string;
  project: ProjectRecord;
  kind: "source" | "reference";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationS: number;
  width: number;
  height: number;
  storageProvider: "local_temp" | "r2";
  expiresAt?: string;
  referenceAnalysis?: ReferenceAnalysis | null;
}): Promise<void> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required");
  const db = getDb();
  const assetPath = `assets/${params.assetId}`;
  try {
    await setDoc(
      doc(db, "assets", params.assetId),
      compactObj({
        assetId: params.assetId,
        projectId: params.project.projectId,
        clientId: params.project.clientId,
        ownerUid: params.project.ownerUid || session.uid,
        clientUid: cleanStr(params.project.clientUid, 128),
        clientEmail: cleanStr(params.project.clientEmail?.toLowerCase(), 320),
        kind: params.kind,
        filename: cleanStr(params.filename, 200) || "video.mp4",
        mimeType: cleanStr(params.mimeType, 80),
        sizeBytes: params.sizeBytes,
        durationS: params.durationS,
        width: params.width,
        height: params.height,
        storageProvider: params.storageProvider,
        available: true,
        expiresAt: cleanStr(params.expiresAt, 64),
        referenceAnalysis: params.referenceAnalysis || undefined,
        createdAt: serverTimestamp(),
      })
    );

    const projectPatch: Record<string, unknown> = {};
    if (params.kind === "source") {
      projectPatch.sourceAssetId = params.assetId;
      if (
        params.project.status === "Draft" ||
        params.project.status === "Awaiting Footage" ||
        params.project.status === "Failed"
      ) {
        projectPatch.status = "Ready for Editing";
      }
    } else {
      projectPatch.referenceAssetId = params.assetId;
      if (params.referenceAnalysis) {
        projectPatch.referenceMetrics = params.referenceAnalysis;
      }
    }
    await updateProjectFields(params.project.projectId, projectPatch);

    await logActivity({
      clientId: params.project.clientId,
      projectId: params.project.projectId,
      ownerUid: params.project.ownerUid,
      clientUid: params.project.clientUid,
      clientEmail: params.project.clientEmail,
      action: params.kind === "source" ? "source_uploaded" : "reference_uploaded",
      summary: `Uploaded ${params.kind} video "${params.filename}" for "${params.project.title}"`,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, assetPath);
  }
}

export async function markAssetAvailability(assetId: string, available: boolean): Promise<void> {
  const db = getDb();
  try {
    await updateDoc(doc(db, "assets", assetId), { available });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `assets/${assetId}`);
  }
}

export async function upsertRenderJobRecord(params: {
  jobId: string;
  project?: ProjectRecord;
  versionNumber?: number;
  status: "queued" | "rendering" | "completed" | "failed";
  progress: number;
  error?: string | null;
  durationS?: number | null;
  resolutionPreset?: ResolutionPreset;
  isCreate?: boolean;
}): Promise<void> {
  const session = currentSession;
  if (!session) return;
  const db = getDb();
  const jobPath = `renderJobs/${params.jobId}`;
  try {
    if (params.isCreate) {
      await setDoc(
        doc(db, "renderJobs", params.jobId),
        compactObj({
          jobId: params.jobId,
          projectId: params.project?.projectId,
          clientId: params.project?.clientId,
          ownerUid: params.project?.ownerUid || session.uid,
          clientUid: cleanStr(params.project?.clientUid, 128),
          clientEmail: cleanStr(params.project?.clientEmail?.toLowerCase(), 320),
          versionNumber:
            typeof params.versionNumber === "number" && Number.isInteger(params.versionNumber)
              ? params.versionNumber
              : undefined,
          status: params.status,
          progress: Math.max(0, Math.min(100, Math.round(params.progress))),
          error: cleanStr(params.error, 1000),
          durationS: typeof params.durationS === "number" ? params.durationS : undefined,
          resolutionPreset: params.resolutionPreset || "export_1080p",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      await updateDoc(
        doc(db, "renderJobs", params.jobId),
        compactObj({
          status: params.status,
          progress: Math.max(0, Math.min(100, Math.round(params.progress))),
          error: cleanStr(params.error, 1000),
          durationS: typeof params.durationS === "number" ? params.durationS : undefined,
          updatedAt: serverTimestamp(),
        })
      );
    }
  } catch (err) {
    handleFirestoreError(
      err,
      params.isCreate ? OperationType.CREATE : OperationType.UPDATE,
      jobPath
    );
  }
}

export async function createVideoVersionRecord(params: {
  project: ProjectRecord;
  versionNumber: number;
  jobId: string;
  instructions: StudioInstructions;
  revisionNotes?: string;
  aspectRatio: AspectRatio;
  resolutionPreset: ResolutionPreset;
}): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required");
  const db = getDb();
  const versionId = `${params.project.projectId}_v${params.versionNumber}`.slice(0, 128);
  const path = `videoVersions/${versionId}`;
  try {
    await setDoc(
      doc(db, "videoVersions", versionId),
      compactObj({
        versionId,
        projectId: params.project.projectId,
        clientId: params.project.clientId,
        ownerUid: params.project.ownerUid || session.uid,
        clientUid: cleanStr(params.project.clientUid, 128),
        clientEmail: cleanStr(params.project.clientEmail?.toLowerCase(), 320),
        versionNumber: params.versionNumber,
        jobId: params.jobId,
        instructions: params.instructions,
        revisionNotes: cleanStr(params.revisionNotes, 1000),
        approvalStatus: "pending_review",
        outputAvailable: false,
        aspectRatio: params.aspectRatio,
        resolutionPreset: params.resolutionPreset,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await updateProjectFields(params.project.projectId, {
      editingInstructions: params.instructions,
      latestVersionNumber: params.versionNumber,
      latestJobId: params.jobId,
      status: params.versionNumber > 1 ? "Re-rendering" : "Rendering",
    });
    await logActivity({
      clientId: params.project.clientId,
      projectId: params.project.projectId,
      ownerUid: params.project.ownerUid,
      clientUid: params.project.clientUid,
      clientEmail: params.project.clientEmail,
      action: params.versionNumber > 1 ? "revision_started" : "first_cut_started",
      summary: `Started Version ${params.versionNumber} render for "${params.project.title}"`,
    });
    return versionId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function finalizeVideoVersionRender(params: {
  versionId: string;
  projectId: string;
  completed: boolean;
  outputAvailable: boolean;
  durationS?: number | null;
}): Promise<void> {
  const db = getDb();
  const path = `videoVersions/${params.versionId}`;
  try {
    await updateDoc(
      doc(db, "videoVersions", params.versionId),
      compactObj({
        outputAvailable: params.outputAvailable,
        durationS: typeof params.durationS === "number" ? params.durationS : undefined,
        updatedAt: serverTimestamp(),
      })
    );
    await updateProjectFields(params.projectId, {
      status: params.completed ? "Awaiting Review" : "Failed",
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function reviewVideoVersion(params: {
  project: ProjectRecord;
  version: VideoVersionRecord;
  decision: "approved" | "rejected";
  note?: string;
}): Promise<void> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required");
  const db = getDb();
  const path = `videoVersions/${params.version.versionId}`;
  try {
    await updateDoc(
      doc(db, "videoVersions", params.version.versionId),
      compactObj({
        approvalStatus: params.decision,
        approvedBy: cleanStr(session.email, 320),
        updatedAt: serverTimestamp(),
      })
    );
    await recordApprovalDecision({
      targetType: "video_version",
      targetId: params.version.versionId,
      projectId: params.project.projectId,
      clientId: params.project.clientId,
      ownerUid: params.project.ownerUid,
      clientUid: params.project.clientUid,
      clientEmail: params.project.clientEmail,
      versionNumber: params.version.versionNumber,
      decision: params.decision,
      note: params.note,
    });
    await updateProjectFields(
      params.project.projectId,
      params.decision === "approved"
        ? {
            status: "Ready for Publishing",
            approvedVersionNumber: params.version.versionNumber,
          }
        : {
            status: "Revision Requested",
          }
    );
    await logActivity({
      clientId: params.project.clientId,
      projectId: params.project.projectId,
      ownerUid: params.project.ownerUid,
      clientUid: params.project.clientUid,
      clientEmail: params.project.clientEmail,
      action: `version_${params.decision}`,
      summary: `Version ${params.version.versionNumber} of "${params.project.title}" ${params.decision}`,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function saveFeedbackRecord(params: {
  project: ProjectRecord;
  version: VideoVersionRecord;
  comment: string;
  timestampS?: number | null;
  matchedRules: string[];
  clarificationNeeded: boolean;
  triggeredRevisionJobId?: string;
  status: "open" | "applied" | "needs_clarification" | "resolved";
}): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required");
  const db = getDb();
  const feedbackId = sanitizeId("fbk");
  const path = `feedback/${feedbackId}`;
  try {
    await setDoc(
      doc(db, "feedback", feedbackId),
      compactObj({
        feedbackId,
        projectId: params.project.projectId,
        versionId: params.version.versionId,
        versionNumber: params.version.versionNumber,
        clientId: params.project.clientId,
        ownerUid: params.project.ownerUid || session.uid,
        clientUid: cleanStr(params.project.clientUid, 128),
        clientEmail: cleanStr(params.project.clientEmail?.toLowerCase(), 320),
        authorUid: session.uid,
        authorEmail: cleanStr(session.email, 320),
        timestampS:
          typeof params.timestampS === "number" && Number.isFinite(params.timestampS) && params.timestampS >= 0
            ? Number(params.timestampS.toFixed(2))
            : undefined,
        comment: cleanStr(params.comment, 2000) || "Revision comment",
        matchedRules: cleanList(params.matchedRules, 20, 180),
        clarificationNeeded: params.clarificationNeeded,
        triggeredRevisionJobId: cleanStr(params.triggeredRevisionJobId, 128),
        status: params.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    if (params.triggeredRevisionJobId) {
      await updateDoc(doc(db, "videoVersions", params.version.versionId), {
        approvalStatus: "revision_requested",
        updatedAt: serverTimestamp(),
      });
      await recordApprovalDecision({
        targetType: "video_version",
        targetId: params.version.versionId,
        projectId: params.project.projectId,
        clientId: params.project.clientId,
        ownerUid: params.project.ownerUid,
        clientUid: params.project.clientUid,
        clientEmail: params.project.clientEmail,
        versionNumber: params.version.versionNumber,
        decision: "revision_requested",
        note: params.comment,
      });
    }

    return feedbackId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function savePublishingRecord(
  input: {
    project: ProjectRecord;
    version: VideoVersionRecord;
    title: string;
    platform: "instagram" | "tiktok";
    caption?: string;
    hashtags?: string[];
    templateName?: string;
    plannedDate: string;
    readiness: PublishingRecord["readiness"];
    integrationStatus: "not_connected" | "connected";
  },
  existingRecordId?: string
): Promise<string> {
  const session = currentSession;
  if (!session) throw new Error("Sign in required");
  const db = getDb();
  const isUpdate = Boolean(existingRecordId);
  const recordId = existingRecordId || sanitizeId("pub");
  const path = `publishingRecords/${recordId}`;

  const safeReadiness =
    input.readiness === "published" && input.integrationStatus !== "connected"
      ? "not_connected"
      : input.readiness;

  try {
    if (isUpdate) {
      await updateDoc(
        doc(db, "publishingRecords", recordId),
        compactObj({
          versionId: input.version.versionId,
          versionNumber: input.version.versionNumber,
          title: cleanStr(input.title, 180) || input.project.title,
          platform: input.platform,
          caption: cleanStr(input.caption, 2200),
          hashtags: cleanList(input.hashtags, 30, 60),
          templateName: cleanStr(input.templateName, 80),
          plannedDate: cleanStr(input.plannedDate, 20) || new Date().toISOString().slice(0, 10),
          readiness: safeReadiness,
          integrationStatus: input.integrationStatus,
          updatedAt: serverTimestamp(),
        })
      );
    } else {
      await setDoc(
        doc(db, "publishingRecords", recordId),
        compactObj({
          recordId,
          projectId: input.project.projectId,
          versionId: input.version.versionId,
          versionNumber: input.version.versionNumber,
          clientId: input.project.clientId,
          ownerUid: input.project.ownerUid || session.uid,
          clientUid: cleanStr(input.project.clientUid, 128),
          clientEmail: cleanStr(input.project.clientEmail?.toLowerCase(), 320),
          title: cleanStr(input.title, 180) || input.project.title,
          platform: input.platform,
          caption: cleanStr(input.caption, 2200),
          hashtags: cleanList(input.hashtags, 30, 60),
          templateName: cleanStr(input.templateName, 80),
          plannedDate: cleanStr(input.plannedDate, 20) || new Date().toISOString().slice(0, 10),
          readiness: safeReadiness,
          integrationStatus: input.integrationStatus,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await logActivity({
        clientId: input.project.clientId,
        projectId: paramsOrFallback(input.project.projectId),
        ownerUid: input.project.ownerUid,
        clientUid: input.project.clientUid,
        clientEmail: input.project.clientEmail,
        action: "calendar_scheduled",
        summary: `Scheduled "${input.title}" (${input.platform}) for ${input.plannedDate}`,
      });
    }
    return recordId;
  } catch (err) {
    handleFirestoreError(
      err,
      isUpdate ? OperationType.UPDATE : OperationType.CREATE,
      path
    );
  }
}

function paramsOrFallback(s: string | undefined): string {
  return s || "";
}

export async function deletePublishingRecord(recordId: string): Promise<void> {
  const db = getDb();
  try {
    await deleteDoc(doc(db, "publishingRecords", recordId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `publishingRecords/${recordId}`);
  }
}
