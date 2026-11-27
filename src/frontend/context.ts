import {
  CrmNavView,
  CrmSnapshot,
  IntegrationsStatus,
  ProjectCreateIntent,
  ProjectRecord,
  StudioUserSession,
} from "./types.js";

export interface AppContext {
  getSession(): StudioUserSession | null;
  getSnapshot(): CrmSnapshot;
  getIntegrations(): IntegrationsStatus | null;
  isIntegrationsLoading(): boolean;
  getIntegrationsError(): string;
  isConnected(): boolean;
  isAdmin(): boolean;
  getActiveView(): CrmNavView;
  apiFetch(path: string, opts?: RequestInit): Promise<Response>;
  refreshSnapshot(): Promise<void>;
  refreshIntegrations(opts?: { silentRender?: boolean }): Promise<void>;
  navigate(
    view: CrmNavView,
    opts?: {
      projectId?: string;
      clientId?: string;
      versionId?: string;
      createProjectIntent?: ProjectCreateIntent;
    }
  ): void;
  consumeProjectCreateIntent(): ProjectCreateIntent | null;
  getSelectedProjectId(): string;
  setSelectedProjectId(pid: string): void;
  getSelectedClientId(): string;
  setSelectedClientId(cid: string): void;
  getSelectedVersionId(): string;
  setSelectedVersionId(vid: string): void;
  openProjectInStudio(project: ProjectRecord, autoRender?: boolean): void;
  openProjectInReview(projectId: string, versionId?: string): void;
  streamProjectAssetUrl(projectId: string, assetId: string): Promise<string>;
  streamJobOutputUrl(jobId: string): Promise<string>;
  downloadJobOutput(jobId: string, filename?: string): Promise<void>;
}
