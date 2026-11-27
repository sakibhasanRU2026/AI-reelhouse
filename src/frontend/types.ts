export type AspectRatio = "9:16" | "16:9" | "1:1" | "4:5";
export type ReframeMode = "crop" | "pad" | "blur" | "manual_crop";
export type ResolutionPreset = "export_1080p" | "preview_720p";

export type ProjectStatus =
  | "Draft"
  | "Idea Approval"
  | "Script Approval"
  | "Awaiting Footage"
  | "Ready for Editing"
  | "Rendering"
  | "Awaiting Review"
  | "Revision Requested"
  | "Re-rendering"
  | "Final Approval"
  | "Ready for Publishing"
  | "Published"
  | "Failed";

export type IdeaScriptStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "changes_requested";

export type VersionApprovalStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "revision_requested";

export type CrmNavView =
  | "overview"
  | "clients"
  | "ideas"
  | "scripts"
  | "projects"
  | "studio"
  | "review"
  | "history"
  | "calendar"
  | "publishing"
  | "settings";

export interface StudioUserSession {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  role: "admin" | "client";
  isBootstrapAdmin: boolean;
}

export interface StudioOperation {
  op:
    | "reframe"
    | "cut_range"
    | "shorten_segment"
    | "overlay_text"
    | "captions"
    | "trim_range"
    | "speed"
    | "audio_adjust"
    | "fade"
    | "merge_clips";
  [key: string]: unknown;
}

export interface StudioInstructions {
  schema_version: "1.0";
  resolution_preset?: ResolutionPreset;
  operations: StudioOperation[];
}

export interface ReferenceAnalysis {
  duration_s: number;
  width: number;
  height: number;
  aspect_ratio: AspectRatio;
  has_audio: boolean;
  mean_volume_db: number | null;
  max_volume_db: number | null;
  scene_cuts_s: number[];
  recommended_intro_end_s: number | null;
}

export interface ClientRecord {
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  name: string;
  company?: string;
  industry?: string;
  niche?: string;
  targetAudience?: string;
  brandGuidelines?: string;
  brandColors?: string[];
  preferredFonts?: string[];
  referenceLinks?: string[];
  contentPreferences?: {
    tone?: string;
    aspectRatio?: AspectRatio;
    approvedTags?: string[];
    captionStyle?: string;
  };
  socialAccounts?: {
    instagram?: string;
    tiktok?: string;
    youtube?: string;
  };
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  workspaceId: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  name: string;
  defaultAspectRatio: AspectRatio;
  defaultResolution: ResolutionPreset;
  createdAt: string;
  updatedAt: string;
}

export interface ContentIdeaRecord {
  ideaId: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  title: string;
  hook?: string;
  category?: string;
  niche?: string;
  tags?: string[];
  referenceLinks?: string[];
  notes?: string;
  status: IdeaScriptStatus;
  reviewNote?: string;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptRecord {
  scriptId: string;
  ideaId?: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  title: string;
  hook?: string;
  talkingPoints?: string[];
  cta?: string;
  captionText?: string;
  estimatedDurationS?: number;
  status: IdeaScriptStatus;
  reviewNote?: string;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  projectId: string;
  title: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  ideaId?: string;
  scriptId?: string;
  sourceAssetId?: string;
  referenceAssetId?: string;
  referenceMetrics?: ReferenceAnalysis;
  editingInstructions?: StudioInstructions;
  targetAspectRatio: AspectRatio;
  targetDurationS?: number;
  captionPreferences?: {
    style?: string;
    font_family?: string;
    max_words_per_line?: number;
    hook?: string;
    caption_text?: string;
    brand_tone?: string;
    brand_colors?: string[];
    preferred_fonts?: string[];
  };
  deadline?: string;
  status: ProjectStatus;
  latestVersionNumber: number;
  latestJobId?: string;
  approvedVersionNumber?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCreateIntent {
  openCreateForm: boolean;
  clientId?: string;
  scriptId?: string;
  ideaId?: string;
  title?: string;
  targetDurationS?: number;
  hook?: string;
  captionText?: string;
  aspectRatio?: AspectRatio;
}

export interface AssetRecord {
  assetId: string;
  projectId: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  kind: "source" | "reference";
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  durationS?: number;
  width?: number;
  height?: number;
  storageProvider: "local_temp" | "r2";
  available: boolean;
  expiresAt?: string;
  referenceAnalysis?: ReferenceAnalysis;
  createdAt: string;
}

export interface RenderJobRecord {
  jobId: string;
  projectId?: string;
  clientId?: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  versionNumber?: number;
  status: "queued" | "rendering" | "completed" | "failed";
  progress: number;
  error?: string;
  durationS?: number;
  resolutionPreset?: ResolutionPreset;
  createdAt: string;
  updatedAt: string;
}

export interface VideoVersionRecord {
  versionId: string;
  projectId: string;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  versionNumber: number;
  jobId: string;
  instructions?: StudioInstructions;
  revisionNotes?: string;
  approvalStatus: VersionApprovalStatus;
  outputAvailable: boolean;
  durationS?: number;
  aspectRatio?: AspectRatio;
  resolutionPreset?: ResolutionPreset;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackRecord {
  feedbackId: string;
  projectId: string;
  versionId: string;
  versionNumber?: number;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  authorUid: string;
  authorEmail?: string;
  timestampS?: number;
  comment: string;
  matchedRules?: string[];
  clarificationNeeded?: boolean;
  triggeredRevisionJobId?: string;
  status: "open" | "applied" | "needs_clarification" | "resolved";
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  approvalId: string;
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
  decidedByUid: string;
  decidedByEmail?: string;
  createdAt: string;
}

export interface PublishingRecord {
  recordId: string;
  projectId: string;
  versionId: string;
  versionNumber?: number;
  clientId: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  title: string;
  platform: "instagram" | "tiktok";
  caption?: string;
  hashtags?: string[];
  templateName?: string;
  plannedDate: string;
  readiness: "draft" | "ready" | "scheduled" | "not_connected" | "published";
  integrationStatus: "not_connected" | "connected";
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLogRecord {
  logId: string;
  clientId?: string;
  projectId?: string;
  ownerUid: string;
  clientUid?: string;
  clientEmail?: string;
  actorUid: string;
  actorEmail?: string;
  action: string;
  summary: string;
  createdAt: string;
}

export interface RevisionParseResult {
  supported: boolean;
  clarificationNeeded: boolean;
  clarificationPrompt: string | null;
  matchedRules: string[];
  unsupportedPhrases: string[];
  updatedInstructions: StudioInstructions;
}

export interface IntegrationsStatus {
  ffmpeg_available: boolean;
  ffmpeg_version: string | null;
  render_worker?: {
    active: number;
    queued: number;
    max_workers: number;
    max_upload_mb: number;
    max_duration_s: number;
    ffmpeg_timeout_s: number;
    job_ttl_hours: number;
  };
  storage?: {
    activeProvider: "local_temp" | "r2";
    localTempDir?: string;
    ttlHours?: number;
    tempTtlHours?: number;
    r2Configured?: boolean;
    r2Status: "not_connected" | "configured";
    missingR2EnvVars?: string[];
    warning?: string;
    ephemeralWarning?: string;
  };
  research_providers?: Array<{
    id: string;
    name: string;
    connected: boolean;
    statusLabel: "Connected" | "Not Connected";
    description: string;
  }>;
  publishing_integrations?: Array<{
    platform: "instagram" | "tiktok";
    displayName: string;
    connected: boolean;
    statusLabel: "Connected" | "Not Connected";
    missingCredentials?: string[];
    note: string;
  }>;
  session_role: "admin" | "client";
}

export interface CrmSnapshot {
  clients: ClientRecord[];
  workspaces: WorkspaceRecord[];
  ideas: ContentIdeaRecord[];
  scripts: ScriptRecord[];
  projects: ProjectRecord[];
  assets: AssetRecord[];
  renderJobs: RenderJobRecord[];
  videoVersions: VideoVersionRecord[];
  feedback: FeedbackRecord[];
  approvals: ApprovalRecord[];
  publishingRecords: PublishingRecord[];
  activityLogs: ActivityLogRecord[];
}

export function cleanStr(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

export function cleanList(v: unknown, maxItems: number, maxLen = 180): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v
    .map((x) => (typeof x === "string" ? x.trim().slice(0, maxLen) : ""))
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

export function sanitizeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
