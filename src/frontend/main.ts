import { AppContext } from "./context.js";
import {
  getSessionProfile,
  initCrmDb,
  loadCrmSnapshot,
} from "./crmDb.js";
import {
  renderClientsView,
  renderIdeasView,
  renderOverviewView,
  renderProjectsView,
  renderScriptsView,
} from "./crmViews.js";
import { btn, el, formatUserError, showToast } from "./dom.js";
import {
  renderCalendarView,
  renderHistoryView,
  renderPublishingView,
  renderReviewView,
  renderSettingsView,
} from "./reviewAndCalendarViews.js";
import { StudioController, createStudioController } from "./studioView.js";
import {
  CrmNavView,
  CrmSnapshot,
  IntegrationsStatus,
  ProjectCreateIntent,
  ProjectRecord,
  StudioUserSession,
} from "./types.js";
import {
  PublicFirebaseConfig,
  StudioAuthUser,
  getCurrentUser,
  getIdToken,
  initFirebaseAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  signOut as fbSignOut,
} from "../clientAuth.js";

const VALID_VIEWS: CrmNavView[] = [
  "overview",
  "clients",
  "ideas",
  "scripts",
  "projects",
  "studio",
  "review",
  "history",
  "calendar",
  "publishing",
  "settings",
];

function parseViewFromHash(rawHash: string): CrmNavView | null {
  const cleaned = rawHash.replace(/^#/, "").split(/[/?]/)[0]?.trim().toLowerCase() as CrmNavView;
  return VALID_VIEWS.includes(cleaned) ? cleaned : null;
}

function emptySnapshot(): CrmSnapshot {
  return {
    clients: [],
    workspaces: [],
    ideas: [],
    scripts: [],
    projects: [],
    assets: [],
    renderJobs: [],
    videoVersions: [],
    feedback: [],
    approvals: [],
    publishingRecords: [],
    activityLogs: [],
  };
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(msg)), ms);
    promise.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit = {},
  ms = 12000
): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("Connection timed out. Retrying…");
    }
    throw e;
  } finally {
    window.clearTimeout(t);
  }
}

export function bootReelhouseCrm(): void {
  const rawBoot = document.querySelector('meta[name="rh-boot"]')?.getAttribute("content") || "";
  let bootToken = rawBoot === "__RH_BOOT_TOKEN__" ? "" : rawBoot;

  let fbConfig: PublicFirebaseConfig | null = null;
  try {
    const rawFb = document.querySelector('meta[name="rh-fb"]')?.getAttribute("content") || "";
    if (rawFb && rawFb !== "__RH_FB_CONFIG__" && rawFb !== "null") {
      fbConfig = JSON.parse(rawFb) as PublicFirebaseConfig;
    }
  } catch {
    fbConfig = null;
  }

  const hasFbConfig = Boolean(
    fbConfig && fbConfig.apiKey && fbConfig.authDomain && fbConfig.projectId && fbConfig.appId
  );
  let fbEnabled = false;
  let fbUser: StudioAuthUser | null = null;
  let crmSession: StudioUserSession | null = null;
  let snapshot: CrmSnapshot = emptySnapshot();
  let integrations: IntegrationsStatus | null = null;
  let integrationsLoading = false;
  let integrationsError = "";

  let sessionToken = "";
  let connState: "connecting" | "connected" | "disconnected" = "connecting";
  let connected = false;
  let manualDisconnect = false;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let reconnectAttempt = 0;
  let connectInFlight: Promise<void> | null = null;
  let bootInFlight: Promise<void> | null = null;

  let activeView: CrmNavView = parseViewFromHash(window.location.hash) || "overview";

  let selectedProjectId = "";
  let selectedClientId = "";
  let selectedVersionId = "";
  let pendingProjectCreateIntent: ProjectCreateIntent | null = null;
  let crmReady = false;
  let crmError = "";

  const studioController: StudioController = createStudioController(buildContext());

  function buildContext(): AppContext {
    return {
      getSession: () => crmSession,
      getSnapshot: () => snapshot,
      getIntegrations: () => integrations,
      isIntegrationsLoading: () => integrationsLoading,
      getIntegrationsError: () => integrationsError,
      isConnected: () => connected,
      isAdmin: () => crmSession?.role === "admin" || !fbEnabled,
      getActiveView: () => activeView,
      apiFetch,
      refreshSnapshot,
      refreshIntegrations,
      navigate: (view, opts) => {
        if (opts?.projectId !== undefined) selectedProjectId = opts.projectId;
        if (opts?.clientId !== undefined) selectedClientId = opts.clientId;
        if (opts?.versionId !== undefined) selectedVersionId = opts.versionId;
        pendingProjectCreateIntent = opts?.createProjectIntent ?? null;
        setActiveView(view);
      },
      consumeProjectCreateIntent: () => {
        const intent = pendingProjectCreateIntent;
        pendingProjectCreateIntent = null;
        return intent;
      },
      getSelectedProjectId: () => selectedProjectId,
      setSelectedProjectId: (pid) => {
        selectedProjectId = pid;
      },
      getSelectedClientId: () => selectedClientId,
      setSelectedClientId: (cid) => {
        selectedClientId = cid;
      },
      getSelectedVersionId: () => selectedVersionId,
      setSelectedVersionId: (vid) => {
        selectedVersionId = vid;
      },
      openProjectInStudio: (proj: ProjectRecord, autoRender = false) => {
        selectedProjectId = proj.projectId;
        setActiveView("studio");
        void studioController.loadProject(proj, autoRender);
      },
      openProjectInReview: (projectId: string, versionId?: string) => {
        selectedProjectId = projectId;
        if (versionId) selectedVersionId = versionId;
        setActiveView("review");
      },
      streamProjectAssetUrl: async (projectId: string, assetId: string) => {
        const r = await apiFetch(`/v1/projects/${projectId}/assets/${assetId}/media-token`, {
          method: "POST",
        });
        const d = (await r.json()) as { media_token: string };
        return `/v1/projects/${projectId}/assets/${assetId}/stream?mt=${encodeURIComponent(
          d.media_token
        )}`;
      },
      streamJobOutputUrl: async (jobId: string) => {
        const r = await apiFetch(`/v1/render-jobs/${jobId}/media-token`, {
          method: "POST",
        });
        const d = (await r.json()) as { media_token: string };
        return `/v1/render-jobs/${jobId}/output?mt=${encodeURIComponent(d.media_token)}`;
      },
      downloadJobOutput: async (jobId: string, filename?: string) => {
        try {
          const r = await apiFetch(`/v1/render-jobs/${jobId}/output?download=1`);
          const blob = await r.blob();
          const dlUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = dlUrl;
          a.download = filename || `${jobId}.mp4`;
          document.body.append(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);
        } catch (e) {
          showToast(formatUserError(e, "Download failed."), "err");
        }
      },
    };
  }

  function extractErrorDetail(data: Record<string, unknown> | undefined, status: number): string {
    if (!data) return `HTTP ${status}`;
    if (typeof data.message === "string" && data.message) return data.message;
    if (Array.isArray(data.details)) {
      return data.details
        .map((d: { loc?: string; msg?: string }) => `${d.loc || ""}: ${d.msg || ""}`)
        .join("\n");
    }
    if (typeof data.error === "string") return data.error;
    return `HTTP ${status}`;
  }

  async function refreshBootToken(): Promise<void> {
    const r = await fetchWithTimeout("/", { credentials: "same-origin", cache: "no-store" }, 8000);
    if (!r.ok) return;
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const nextBoot = doc.querySelector('meta[name="rh-boot"]')?.getAttribute("content") || "";
    if (nextBoot && nextBoot !== "__RH_BOOT_TOKEN__") bootToken = nextBoot;
  }

  async function establishSession(allowBootRefresh = true, forceIdRefresh = false): Promise<void> {
    const headers: Record<string, string> = { "X-Requested-With": "ReelhouseStudio" };
    if (bootToken) headers["X-Studio-Boot"] = bootToken;
    if (fbEnabled) {
      const idToken = await withTimeout(
        getIdToken(forceIdRefresh),
        10000,
        "Authentication token request timed out."
      );
      if (!idToken) throw new Error("Sign in required.");
      headers["Authorization"] = `Bearer ${idToken}`;
    }
    const r = await fetchWithTimeout(
      "/v1/studio/session",
      { method: "POST", credentials: "same-origin", cache: "no-store", headers },
      12000
    );
    if (r.status === 403 && allowBootRefresh) {
      await refreshBootToken();
      return establishSession(false, forceIdRefresh);
    }
    if (r.status === 401 && fbEnabled && !forceIdRefresh) {
      return establishSession(allowBootRefresh, true);
    }
    if (!r.ok) {
      let d: Record<string, unknown> | undefined;
      try {
        d = (await r.json()) as Record<string, unknown>;
      } catch {}
      throw new Error(extractErrorDetail(d, r.status));
    }
    const data = (await r.json()) as {
      session_token?: string;
      user?: { role?: "admin" | "client" };
    };
    sessionToken = data.session_token || "";
  }

  async function apiFetch(path: string, opts: RequestInit = {}, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      "X-Requested-With": "ReelhouseStudio",
      ...((opts.headers as Record<string, string>) || {}),
    };
    if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;
    let r: Response;
    try {
      r = await fetch(path, { ...opts, headers, credentials: "same-origin", cache: "no-store" });
    } catch {
      if (!manualDisconnect && (!fbEnabled || fbUser)) {
        setConnection("disconnected", "Unable to reach render backend.", "Reconnecting automatically…");
        scheduleReconnect();
      }
      throw new Error("Unable to reach render backend.");
    }
    if (r.status === 401 && !retried && !manualDisconnect && (!fbEnabled || fbUser)) {
      await establishSession(true, true);
      return apiFetch(path, opts, true);
    }
    if (!r.ok) {
      let d: Record<string, unknown> | undefined;
      try {
        d = (await r.json()) as Record<string, unknown>;
      } catch {}
      throw new Error(extractErrorDetail(d, r.status));
    }
    return r;
  }

  function setConnection(
    state: "connecting" | "connected" | "disconnected",
    msg = "",
    sub = ""
  ): void {
    connState = state;
    connected = state === "connected";
    const dot = $("dot");
    const connText = $("connectionText");
    const sessTitle = $("sessionTitle");
    const sessSub = $("sessionSub");
    const authMsg = $("authMessage");
    const recBtn = $("reconnect") as HTMLButtonElement | null;
    const discBtn = $("disconnect") as HTMLButtonElement | null;

    if (dot) dot.className = `dot ${state === "connected" ? "ok" : state === "connecting" ? "connecting" : "bad"}`;
    if (connText) {
      connText.textContent =
        state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : "Disconnected";
    }
    if (sessTitle) {
      sessTitle.textContent =
        state === "connected"
          ? "Render backend connected"
          : state === "connecting"
            ? "Connecting to render backend…"
            : "Render backend disconnected";
    }
    if (sessSub) sessSub.textContent = sub;
    if (authMsg) {
      authMsg.textContent = msg;
      authMsg.className = `notice ${state === "connected" ? "success" : ""}`;
    }
    if (discBtn) discBtn.hidden = !connected;
    if (recBtn) {
      recBtn.hidden = connected;
      recBtn.disabled = connState === "connecting";
    }
  }

  function renderProfileHeader(): void {
    const label = fbUser?.displayName || fbUser?.email || (hasFbConfig ? "Account" : "Local Studio");
    const roleChip = $("roleBadge");
    const pName = $("profileName");
    const mName = $("menuName");
    const mEmail = $("menuEmail");
    const av = $("userAvatar");
    const signOutBtn = $("signOut") as HTMLButtonElement | null;

    if (pName) pName.textContent = label;
    if (mName) mName.textContent = label;
    if (mEmail) mEmail.textContent = fbUser?.email || (hasFbConfig ? "" : "Local workspace session");
    if (roleChip) {
      if (!fbEnabled && !hasFbConfig) {
        roleChip.textContent = "Admin";
        roleChip.className = "badge badge-purple";
      } else if (crmSession) {
        const isAdm = crmSession.role === "admin";
        roleChip.textContent = isAdm ? "Admin" : "Client";
        roleChip.className = `badge ${isAdm ? "badge-purple" : "badge-green"}`;
      } else if (crmError) {
        roleChip.textContent = "Role error";
        roleChip.className = "badge badge-red";
      } else {
        roleChip.textContent = "Checking role";
        roleChip.className = "badge badge-neutral";
      }
    }
    if (signOutBtn) signOutBtn.hidden = !fbEnabled && !hasFbConfig;
    if (av) {
      av.replaceChildren();
      if (fbUser?.photoURL) {
        const img = document.createElement("img");
        img.src = fbUser.photoURL;
        img.alt = label;
        img.referrerPolicy = "no-referrer";
        av.append(img);
      } else {
        av.textContent = label.trim().charAt(0).toUpperCase() || "R";
      }
    }
  }

  async function refreshSnapshot(): Promise<void> {
    if (!fbEnabled || !fbUser) return;
    snapshot = await loadCrmSnapshot();
  }

  async function refreshIntegrations(opts: { silentRender?: boolean } = {}): Promise<void> {
    if (!connected) {
      integrationsError = "Render backend is disconnected.";
      if (!opts.silentRender && crmReady && (activeView === "settings" || activeView === "publishing")) {
        renderCurrentView();
      }
      return;
    }
    integrationsLoading = true;
    integrationsError = "";
    if (!opts.silentRender && crmReady && (activeView === "settings" || activeView === "publishing")) {
      renderCurrentView();
    }
    try {
      const r = await apiFetch("/v1/crm/integrations");
      const raw = (await r.json()) as IntegrationsStatus;
      if (!raw || typeof raw !== "object") {
        throw new Error("Invalid diagnostics payload returned from backend.");
      }
      integrations = raw;
      integrationsError = "";
    } catch (e) {
      integrationsError = formatUserError(e, "Failed to fetch backend diagnostics.");
      if (!opts.silentRender) {
        showToast(integrationsError, "err");
      }
    } finally {
      integrationsLoading = false;
      if (
        !opts.silentRender &&
        crmReady &&
        (activeView === "settings" || activeView === "publishing" || activeView === "calendar")
      ) {
        renderCurrentView();
      }
    }
  }

  function scheduleReconnect(): void {
    if (manualDisconnect || (fbEnabled && !fbUser)) return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    const delays = [1500, 3000, 5000, 10000, 15000];
    const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
    reconnectAttempt++;
    reconnectTimer = window.setTimeout(() => {
      if (!manualDisconnect && (!fbEnabled || fbUser)) {
        void connectBackend(true);
      }
    }, delay);
  }

  function scheduleHeartbeat(): void {
    if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
    heartbeatTimer = window.setTimeout(async () => {
      if (!connected || manualDisconnect || (fbEnabled && !fbUser)) return;
      if (document.hidden) {
        scheduleHeartbeat();
        return;
      }
      try {
        const r = await apiFetch("/health");
        const j = (await r.json()) as { status?: string };
        if (j.status !== "ok") throw new Error("Renderer unavailable");
        scheduleHeartbeat();
      } catch {
        // handled inside apiFetch
      }
    }, 25000);
  }

  async function connectBackend(
    isRetry = false,
    opts: { throwOnSessionError?: boolean; silentRender?: boolean } = {}
  ): Promise<void> {
    if (fbEnabled && !fbUser) return;
    if (manualDisconnect && isRetry) return;
    if (connectInFlight) return connectInFlight;

    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);

    connectInFlight = (async () => {
      setConnection(
        "connecting",
        "",
        isRetry ? "Reconnecting to render backend…" : "Verifying authenticated session…"
      );
      let sessionVerified = false;
      try {
        await establishSession(true, false);
        sessionVerified = true;
        const r = await apiFetch("/health");
        const j = (await r.json()) as { status?: string; ffmpeg?: string };
        if (j.status !== "ok") throw new Error("Renderer unavailable");
        reconnectAttempt = 0;
        setConnection(
          "connected",
          `FFmpeg ${j.ffmpeg || "ready"} active.`,
          fbEnabled ? `Verified session (${fbUser?.email || fbUser?.uid})` : "Authenticated local session"
        );
        scheduleHeartbeat();
        await refreshIntegrations({ silentRender: opts.silentRender });
        if (!opts.silentRender) {
          renderCurrentView();
        }
      } catch (e) {
        if (!sessionVerified) sessionToken = "";
        const msg = formatUserError(e, "Connection failed.");
        if (manualDisconnect) {
          setConnection("disconnected", "Disconnected from render backend.", "Click Reconnect renderer to restore.");
        } else {
          setConnection("disconnected", msg, "Automatic reconnection scheduled…");
          scheduleReconnect();
        }
        if (!sessionVerified && opts.throwOnSessionError) {
          throw e;
        }
      } finally {
        connectInFlight = null;
      }
    })();

    return connectInFlight;
  }

  function syncSidebarActive(): void {
    document.querySelectorAll<HTMLElement>("[data-crm-nav]").forEach((elItem) => {
      const target = elItem.dataset.crmNav as CrmNavView | undefined;
      elItem.classList.toggle("active", target === activeView);
    });
    const drawer = $("crmSidebar");
    drawer?.classList.remove("open");
  }

  function setActiveView(view: CrmNavView, opts: { historyMode?: "push" | "replace" | "none" } = {}): void {
    activeView = view;
    const historyMode = opts.historyMode || "push";
    if (historyMode !== "none" && parseViewFromHash(window.location.hash) !== view) {
      if (historyMode === "push") {
        window.history.pushState(null, "", `#${view}`);
      } else {
        window.history.replaceState(null, "", `#${view}`);
      }
    }
    syncSidebarActive();
    renderCurrentView();
    if (typeof window.scrollTo === "function") {
      try {
        window.scrollTo(0, 0);
      } catch {
        // ignore in non-browser environments
      }
    }
  }

  function renderCurrentView(): void {
    const mount = $("crmMain");
    if (!mount) return;
    mount.replaceChildren();

    if (crmError) {
      const errPanel = el("section", "panel");
      const errActions = el("div", "row-actions");
      errActions.append(
        btn("Retry Loading Workspace", "btn primary", () => {
          crmError = "";
          manualDisconnect = false;
          reconnectAttempt = 0;
          void bootDataAndRender();
        })
      );
      if (fbEnabled || hasFbConfig) {
        errActions.append(
          btn("Sign out", "btn btn-danger", () => void handleSignOut())
        );
      }
      errPanel.append(
        el("h2", "", "Workspace Error Recovery"),
        el("div", "notice", crmError),
        errActions
      );
      mount.append(errPanel);
      return;
    }

    if (!crmReady && (fbEnabled || hasFbConfig)) {
      const loading = el("section", "panel");
      loading.append(
        el("div", "empty", "Loading REELHOUSE workspace and verifying Firestore security session…")
      );
      mount.append(loading);
      return;
    }

    const viewRoot = el("div", "view-root");
    viewRoot.style.display = "contents";
    mount.replaceChildren(viewRoot);

    const ctx = buildContext();
    try {
      switch (activeView) {
        case "overview":
          renderOverviewView(viewRoot, ctx);
          break;
        case "clients":
          renderClientsView(viewRoot, ctx);
          break;
        case "ideas":
          renderIdeasView(viewRoot, ctx);
          break;
        case "scripts":
          renderScriptsView(viewRoot, ctx);
          break;
        case "projects":
          renderProjectsView(viewRoot, ctx);
          break;
        case "studio":
          studioController.mount(viewRoot);
          break;
        case "review":
          renderReviewView(viewRoot, ctx);
          break;
        case "history":
          renderHistoryView(viewRoot, ctx);
          break;
        case "calendar":
          renderCalendarView(viewRoot, ctx);
          break;
        case "publishing":
          renderPublishingView(viewRoot, ctx);
          break;
        case "settings":
          renderSettingsView(viewRoot, ctx, {
            reconnect: () => {
              manualDisconnect = false;
              reconnectAttempt = 0;
              void connectBackend(false);
            },
            disconnect: async () => {
              manualDisconnect = true;
              sessionToken = "";
              await logoutBackend();
              setConnection("disconnected", "Disconnected from render backend.", "Click Reconnect to restore.");
              renderCurrentView();
            },
            signOut: () => void handleSignOut(),
          });
          break;
      }
    } catch (err) {
      const msg = formatUserError(err, "An unexpected error occurred while rendering this view.");
      const errBox = el("section", "panel");
      const errActs = el("div", "row-actions");
      const reloadBtn = btn("Reload View", "btn primary", async () => {
        reloadBtn.disabled = true;
        reloadBtn.textContent = "Reloading…";
        try {
          if (fbEnabled && fbUser) {
            await refreshSnapshot();
          }
          if (connected) {
            await refreshIntegrations({ silentRender: true });
          }
          renderCurrentView();
        } catch (reloadErr) {
          crmError = formatUserError(reloadErr, "Failed to reload workspace view.");
          renderProfileHeader();
          renderCurrentView();
        }
      });
      errActs.append(
        reloadBtn,
        btn("Go to Overview", "btn", () => setActiveView("overview"))
      );
      errBox.append(
        el("h2", "", "View Error Caught"),
        el("div", "notice", msg),
        errActs
      );
      mount.replaceChildren(errBox);
    }
  }

  async function logoutBackend(): Promise<void> {
    try {
      const headers: Record<string, string> = { "X-Requested-With": "ReelhouseStudio" };
      if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;
      await fetch("/v1/studio/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers,
      });
    } catch {
      // ignore
    }
  }

  async function handleSignOut(): Promise<void> {
    manualDisconnect = true;
    sessionToken = "";
    await logoutBackend();
    if (fbEnabled) {
      try {
        await fbSignOut();
      } catch {}
    }
    window.location.replace("/login");
  }

  async function bootDataAndRender(): Promise<void> {
    if (bootInFlight) return bootInFlight;
    bootInFlight = (async () => {
      crmError = "";
      crmReady = false;
      renderProfileHeader();
      renderCurrentView();
      try {
        if (hasFbConfig && !fbEnabled) {
          fbEnabled = await initFirebaseAuth(fbConfig);
        }
        if (fbEnabled) {
          if (!fbUser) {
            fbUser = getCurrentUser();
          }
          if (!fbUser) {
            throw new Error("Waiting for signed-in user session. Sign in again to continue.");
          }
          // 1. Verify backend session & Firebase ID token first
          await connectBackend(false, { throwOnSessionError: true, silentRender: true });
          // 2. Initialize Firestore only after App/Auth & backend session are verified
          crmSession = await initCrmDb(fbConfig);
          if (!crmSession) {
            throw new Error("Authenticated user profile could not be initialized.");
          }
          renderProfileHeader();
          // 3. Load scoped CRM collections from Firestore
          await refreshSnapshot();
        } else {
          crmSession = getSessionProfile();
          renderProfileHeader();
          await connectBackend(false, { silentRender: true });
        }
        crmReady = true;
        renderProfileHeader();
        renderCurrentView();
      } catch (err) {
        crmError = formatUserError(err, "Failed to load REELHOUSE workspace.");
        crmReady = true;
        if (connState === "connecting") {
          setConnection("disconnected", crmError, "Click Retry Loading Workspace or Reconnect.");
        }
        renderProfileHeader();
        renderCurrentView();
      } finally {
        bootInFlight = null;
      }
    })();
    return bootInFlight;
  }

  // Wire Sidebar & Header controls
  document.querySelectorAll<HTMLElement>("[data-crm-nav]").forEach((navEl) => {
    navEl.onclick = (e) => {
      e.preventDefault();
      const target = navEl.dataset.crmNav as CrmNavView | undefined;
      if (target && VALID_VIEWS.includes(target)) {
        setActiveView(target);
      }
    };
  });

  const mobileToggle = $("sidebarToggle");
  const sidebarEl = $("crmSidebar");
  if (mobileToggle && sidebarEl) {
    mobileToggle.onclick = () => sidebarEl.classList.toggle("open");
  }

  const profileBtn = $("profileBtn");
  const profileMenu = $("profileMenu");
  const profileWrap = $("profileWrap");
  if (profileBtn && profileMenu) {
    profileBtn.onclick = (e) => {
      e.stopPropagation();
      const open = profileMenu.hidden;
      profileMenu.hidden = !open;
      profileBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    document.addEventListener("click", (e) => {
      if (!profileMenu.hidden && profileWrap && !profileWrap.contains(e.target as Node)) {
        profileMenu.hidden = true;
        profileBtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  const recBtn = $("reconnect");
  if (recBtn) {
    recBtn.onclick = () => {
      manualDisconnect = false;
      reconnectAttempt = 0;
      void connectBackend(false);
    };
  }
  const discBtn = $("disconnect");
  if (discBtn) {
    discBtn.onclick = async () => {
      manualDisconnect = true;
      sessionToken = "";
      await logoutBackend();
      setConnection("disconnected", "Disconnected from render backend.", "Click Reconnect renderer to restore.");
    };
  }
  const signOutBtn = $("signOut");
  if (signOutBtn) {
    signOutBtn.onclick = () => void handleSignOut();
  }

  window.addEventListener("online", () => {
    if (!manualDisconnect && !connected && (!fbEnabled || fbUser)) {
      reconnectAttempt = 0;
      void connectBackend(true);
    }
  });
  window.addEventListener("offline", () => {
    if (!manualDisconnect) {
      setConnection("disconnected", "Browser is offline.", "Waiting for network connection…");
    }
  });

  const syncFromLocationHash = () => {
    const parsed = parseViewFromHash(window.location.hash);
    if (parsed && parsed !== activeView) {
      pendingProjectCreateIntent = null;
      setActiveView(parsed, { historyMode: "none" });
    }
  };
  window.addEventListener("hashchange", syncFromLocationHash);
  window.addEventListener("popstate", syncFromLocationHash);

  // Boot auth flow
  syncSidebarActive();
  renderCurrentView();

  void (async () => {
    if (hasFbConfig && fbConfig) {
      try {
        fbEnabled = await initFirebaseAuth(fbConfig);
      } catch (err) {
        fbEnabled = false;
        crmError = formatUserError(err, "Failed to initialize Firebase Authentication.");
        crmReady = true;
        setConnection("disconnected", crmError, "Verify Firebase configuration and retry.");
        renderProfileHeader();
        renderCurrentView();
        return;
      }
    }

    if (fbEnabled) {
      setConnection("connecting", "", "Verifying account session…");
      let prevUid: string | null = null;
      onAuthStateChanged((u) => {
        fbUser = u;
        if (!u) {
          void logoutBackend().then(() => {
            window.location.replace("/login");
          });
          return;
        }
        if (prevUid && prevUid !== u.uid) {
          snapshot = emptySnapshot();
          crmSession = null;
        }
        prevUid = u.uid;
        manualDisconnect = false;
        reconnectAttempt = 0;
        renderProfileHeader();
        void bootDataAndRender();
      });
      onIdTokenChanged((u) => {
        if (u && fbUser && u.uid === fbUser.uid) {
          fbUser = u;
        }
      });
    } else {
      crmReady = true;
      renderProfileHeader();
      void connectBackend(false);
    }
  })();
}

bootReelhouseCrm();
