import {
  getConnectionDiagnostics,
  reviewIdea,
  reviewScript,
  saveClient,
  saveIdea,
  saveProject,
  saveScript,
  saveUploadedAssetMetadata,
  updateProjectFields,
} from "./crmDb.js";
import { AppContext } from "./context.js";
import {
  badge,
  btn,
  el,
  formatBytes,
  formatIsoShort,
  formatUserError,
  inputField,
  projectTone,
  selectField,
  showToast,
  statusTone,
  textareaField,
} from "./dom.js";
import {
  AspectRatio,
  ClientRecord,
  ContentIdeaRecord,
  IdeaScriptStatus,
  ProjectRecord,
  ProjectStatus,
  ScriptRecord,
  StudioInstructions,
} from "./types.js";

const ALL_PROJECT_STATUSES: ProjectStatus[] = [
  "Draft",
  "Idea Approval",
  "Script Approval",
  "Awaiting Footage",
  "Ready for Editing",
  "Rendering",
  "Awaiting Review",
  "Revision Requested",
  "Re-rendering",
  "Final Approval",
  "Ready for Publishing",
  "Published",
  "Failed",
];

export function renderOverviewView(container: HTMLElement, ctx: AppContext): void {
  const snap = ctx.getSnapshot();
  const session = ctx.getSession();

  const header = el("div", "view-header");
  const hl = el("div");
  hl.append(
    el("div", "eyebrow", session?.role === "admin" ? "Agency Command Center" : "Client Production Portal"),
    el("h1", "", "Production Overview"),
    el(
      "div",
      "muted",
      `Signed in as ${session?.email || "Account"} · Role: ${session?.role === "admin" ? "Admin" : "Client"} · Live Firestore metrics`
    )
  );
  const hr = el("div", "row-actions");
  if (ctx.isAdmin()) {
    hr.append(
      btn("+ New Client", "btn", () => ctx.navigate("clients")),
      btn("+ New Project", "btn primary", () => ctx.navigate("projects"))
    );
  } else {
    hr.append(btn("Open Review Queue", "btn primary", () => ctx.navigate("review")));
  }
  header.append(hl, hr);
  container.append(header);

  // Real computed KPI metrics
  const totalProjects = snap.projects.length;
  const ideasPending = snap.ideas.filter((i) => i.status === "pending_approval").length;
  const inProduction = snap.projects.filter((p) =>
    ["Ready for Editing", "Rendering", "Re-rendering", "Awaiting Footage"].includes(p.status)
  ).length;
  const awaitingReview = snap.projects.filter(
    (p) => p.status === "Awaiting Review" || p.status === "Final Approval"
  ).length;
  const revisionReqs = snap.projects.filter((p) => p.status === "Revision Requested").length;
  const approvedCount =
    snap.ideas.filter((i) => i.status === "approved").length +
    snap.scripts.filter((s) => s.status === "approved").length +
    snap.videoVersions.filter((v) => v.approvalStatus === "approved").length;
  const scheduledCount = snap.publishingRecords.filter(
    (r) => r.readiness === "scheduled" || r.readiness === "ready" || r.readiness === "not_connected"
  ).length;

  const kpiGrid = el("div", "kpi-grid");
  const kpis: Array<{ label: string; value: number; sub: string; view: Parameters<AppContext["navigate"]>[0] }> = [
    { label: "Total Projects", value: totalProjects, sub: `${snap.clients.length} client workspaces`, view: "projects" },
    { label: "Ideas Pending Approval", value: ideasPending, sub: `${snap.ideas.length} total ideas`, view: "ideas" },
    { label: "Videos in Production", value: inProduction, sub: `${snap.scripts.length} scripts tracked`, view: "projects" },
    { label: "Awaiting Review", value: awaitingReview, sub: `${snap.videoVersions.length} total cuts`, view: "review" },
    { label: "Revision Requests", value: revisionReqs, sub: `${snap.feedback.length} comments`, view: "review" },
    { label: "Approved Items", value: approvedCount, sub: `${snap.approvals.length} audit records`, view: "history" },
    { label: "Scheduled Content", value: scheduledCount, sub: `${snap.publishingRecords.length} calendar entries`, view: "calendar" },
  ];

  for (const k of kpis) {
    const card = el("button", "kpi-card") as HTMLButtonElement;
    card.type = "button";
    card.onclick = () => ctx.navigate(k.view);
    card.append(
      el("div", "kpi-label", k.label),
      el("div", "kpi-value mono", String(k.value)),
      el("div", "kpi-sub", k.sub)
    );
    kpiGrid.append(card);
  }
  container.append(kpiGrid);

  const diag = getConnectionDiagnostics();
  if (diag.warning) {
    container.append(el("div", "alert-banner alert-warn", diag.warning));
  }

  const split = el("div", "crm-two-col");

  // Active Projects Pipeline
  const projPanel = el("section", "panel");
  const ph = el("div", "panelhead");
  ph.append(
    el("h2", "", "Active Content Pipeline"),
    btn("View all →", "mini", () => ctx.navigate("projects"))
  );
  projPanel.append(ph);

  if (snap.projects.length === 0) {
    projPanel.append(
      el(
        "div",
        "empty small",
        "No projects yet. Create a Client Workspace, approve an Idea & Script, or launch a Project to start your pipeline."
      )
    );
  } else {
    const list = el("div", "list-stack");
    for (const p of snap.projects.slice(0, 8)) {
      const cli = snap.clients.find((c) => c.clientId === p.clientId);
      const row = el("div", "list-row");
      const meta = el("div", "list-meta");
      meta.append(
        el("div", "list-title", p.title || "Untitled Project"),
        el(
          "div",
          "list-sub",
          `${cli?.name || p.clientId} · ${p.targetAspectRatio || "9:16"} · v${p.latestVersionNumber ?? 0} · ${formatIsoShort(p.updatedAt)}`
        )
      );
      const right = el("div", "row-actions");
      const pStatus = p.status || "Draft";
      right.append(
        badge(pStatus, projectTone(pStatus)),
        btn("Open", "mini", () => {
          ctx.setSelectedProjectId(p.projectId);
          ctx.navigate(p.latestJobId ? "review" : "projects", { projectId: p.projectId });
        })
      );
      row.append(meta, right);
      list.append(row);
    }
    projPanel.append(list);
  }

  // Recent Activity
  const actPanel = el("section", "panel");
  const ah = el("div", "panelhead");
  ah.append(el("h2", "", "Recent Activity"), el("span", "small muted", `${snap.activityLogs.length} events`));
  actPanel.append(ah);

  if (snap.activityLogs.length === 0) {
    actPanel.append(el("div", "empty small", "Activity events will appear here as your team works."));
  } else {
    const feed = el("div", "list-stack");
    for (const log of snap.activityLogs.slice(0, 12)) {
      const row = el("div", "activity-item");
      row.append(
        el("div", "activity-summary", log.summary),
        el(
          "div",
          "activity-meta",
          `${log.actorEmail || log.actorUid} · ${formatIsoShort(log.createdAt)}`
        )
      );
      feed.append(row);
    }
    actPanel.append(feed);
  }

  split.append(projPanel, actPanel);
  container.append(split);
}

export function renderClientsView(container: HTMLElement, ctx: AppContext): void {
  const state = { editingId: "", showForm: false, saving: false, formError: "" };

  const draft: {
    name: string;
    company: string;
    industry: string;
    niche: string;
    clientEmail: string;
    targetAudience: string;
    brandGuidelines: string;
    brandColors: string;
    preferredFonts: string;
    referenceLinks: string;
    aspectRatio: AspectRatio;
    tone: string;
    captionStyle: string;
    approvedTags: string[];
    instagram: string;
    tiktok: string;
    youtube: string;
  } = {
    name: "",
    company: "",
    industry: "",
    niche: "",
    clientEmail: "",
    targetAudience: "",
    brandGuidelines: "",
    brandColors: "#8060ee, #0b0b12",
    preferredFonts: "sans, bold",
    referenceLinks: "",
    aspectRatio: "9:16",
    tone: "Direct & energetic",
    captionStyle: "",
    approvedTags: [],
    instagram: "",
    tiktok: "",
    youtube: "",
  };

  const loadDraft = (c?: ClientRecord) => {
    state.editingId = c?.clientId || "";
    state.formError = "";
    draft.name = c?.name || "";
    draft.company = c?.company || "";
    draft.industry = c?.industry || "";
    draft.niche = c?.niche || "";
    draft.clientEmail = c?.clientEmail || "";
    draft.targetAudience = c?.targetAudience || "";
    draft.brandGuidelines = c?.brandGuidelines || "";
    draft.brandColors = (c?.brandColors || []).join(", ");
    draft.preferredFonts = (c?.preferredFonts || []).join(", ");
    draft.referenceLinks = (c?.referenceLinks || []).join("\n");
    draft.aspectRatio = c?.contentPreferences?.aspectRatio || "9:16";
    draft.tone = c?.contentPreferences?.tone || "";
    draft.captionStyle = c?.contentPreferences?.captionStyle || "";
    draft.approvedTags = Array.isArray(c?.contentPreferences?.approvedTags)
      ? [...c.contentPreferences.approvedTags]
      : [];
    draft.instagram = c?.socialAccounts?.instagram || "";
    draft.tiktok = c?.socialAccounts?.tiktok || "";
    draft.youtube = c?.socialAccounts?.youtube || "";
  };

  const draw = () => {
    if (!container.isConnected) return;
    const snap = ctx.getSnapshot();
    container.replaceChildren();
    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Workspaces"),
      el("h1", "", "Clients & Brand Profiles"),
      el("div", "muted", "Isolated workspaces, brand guidelines, colors, social links, and project history.")
    );
    const hr = el("div", "row-actions");
    hr.append(
      btn(state.showForm ? "Close Form" : "+ Add Client Workspace", "btn primary", () => {
        if (!state.showForm) loadDraft(undefined);
        state.showForm = !state.showForm;
        draw();
      })
    );
    head.append(hl, hr);
    container.append(head);

    if (state.showForm) {
      const formPanel = el("section", "panel");
      formPanel.append(
        el("div", "panelhead", state.editingId ? "Edit Client Workspace" : "New Client Workspace")
      );
      const grid = el("div", "fields");
      grid.append(
        inputField("Client Name *", draft.name, (v) => (draft.name = v), { placeholder: "Acme Fitness" }).wrap,
        inputField("Company / Brand", draft.company, (v) => (draft.company = v)).wrap,
        inputField("Client Portal Email (grants Client role access)", draft.clientEmail, (v) => (draft.clientEmail = v), {
          type: "email",
          placeholder: "client@brand.com",
        }).wrap,
        inputField("Industry", draft.industry, (v) => (draft.industry = v), { placeholder: "Health & Wellness" }).wrap,
        inputField("Niche", draft.niche, (v) => (draft.niche = v), { placeholder: "Strength Training" }).wrap,
        selectField(
          "Default Aspect Ratio",
          draft.aspectRatio,
          [
            ["9:16", "9:16 Reels / TikTok"],
            ["4:5", "4:5 Feed"],
            ["1:1", "1:1 Square"],
            ["16:9", "16:9 Landscape"],
          ],
          (v) => (draft.aspectRatio = v as AspectRatio)
        ).wrap,
        inputField("Target Audience", draft.targetAudience, (v) => (draft.targetAudience = v), { wide: true }).wrap,
        inputField("Brand Colors (comma separated)", draft.brandColors, (v) => (draft.brandColors = v)).wrap,
        inputField("Preferred Fonts / Tone", draft.preferredFonts, (v) => (draft.preferredFonts = v)).wrap,
        inputField("Instagram Handle", draft.instagram, (v) => (draft.instagram = v), { placeholder: "@brand" }).wrap,
        inputField("TikTok Handle", draft.tiktok, (v) => (draft.tiktok = v), { placeholder: "@brand" }).wrap,
        textareaField("Brand Guidelines & Content Preferences", draft.brandGuidelines, (v) => (draft.brandGuidelines = v), {
          wide: true,
          rows: 3,
        }).wrap,
        textareaField("Reference Reel Links (one per line)", draft.referenceLinks, (v) => (draft.referenceLinks = v), {
          wide: true,
          rows: 2,
        }).wrap
      );
      if (state.formError) {
        formPanel.append(el("div", "notice", state.formError));
      }
      const actions = el("div", "actions");
      actions.append(
        btn(
          "Cancel",
          "btn",
          () => {
            state.showForm = false;
            state.formError = "";
            draw();
          },
          state.saving
        ),
        btn(
          state.saving
            ? "Saving…"
            : state.editingId
              ? "Save Changes"
              : "Create Client Workspace",
          "btn primary",
          async () => {
            if (state.saving) return;
            if (!draft.name.trim()) {
              state.formError = "Client name is required.";
              showToast(state.formError, "err");
              draw();
              return;
            }
            state.saving = true;
            state.formError = "";
            draw();
            try {
              await saveClient(
                {
                  name: draft.name,
                  company: draft.company,
                  industry: draft.industry,
                  niche: draft.niche,
                  clientEmail: draft.clientEmail,
                  targetAudience: draft.targetAudience,
                  brandGuidelines: draft.brandGuidelines,
                  brandColors: draft.brandColors.split(",").map((s) => s.trim()).filter(Boolean),
                  preferredFonts: draft.preferredFonts.split(",").map((s) => s.trim()).filter(Boolean),
                  referenceLinks: draft.referenceLinks.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
                  contentPreferences: {
                    aspectRatio: draft.aspectRatio,
                    tone: draft.tone,
                    captionStyle: draft.captionStyle || undefined,
                    approvedTags: draft.approvedTags,
                  },
                  socialAccounts: {
                    instagram: draft.instagram,
                    tiktok: draft.tiktok,
                    youtube: draft.youtube,
                  },
                },
                state.editingId || undefined
              );
              await ctx.refreshSnapshot();
              state.showForm = false;
              state.editingId = "";
              showToast("Client workspace saved.", "ok");
            } catch (e) {
              const msg = formatUserError(e, "Failed to save client workspace.");
              state.formError = msg;
              showToast(msg, "err");
            } finally {
              state.saving = false;
              draw();
            }
          },
          state.saving
        )
      );
      formPanel.append(grid, actions);
      container.append(formPanel);
    }

    if (snap.clients.length === 0) {
      const empty = el("section", "panel");
      empty.append(el("div", "empty", "No client workspaces yet. Add your first client to organize ideas, scripts, and projects."));
      container.append(empty);
      return;
    }

    const cards = el("div", "crm-cards");
    for (const cli of snap.clients) {
      const cliProjects = snap.projects.filter((p) => p.clientId === cli.clientId);
      const card = el("section", "panel");
      const ch = el("div", "panelhead");
      const titleWrap = el("div");
      titleWrap.append(
        el("h2", "", cli.name),
        el(
          "div",
          "small muted",
          [cli.company, cli.industry, cli.niche].filter(Boolean).join(" · ") || "Brand Workspace"
        )
      );
      const act = el("div", "row-actions");
      act.append(
        badge(cli.status, statusTone(cli.status)),
        btn("Edit", "mini", () => {
          loadDraft(cli);
          state.showForm = true;
          draw();
        })
      );
      ch.append(titleWrap, act);
      card.append(ch);

      const meta = el("div", "meta-kv");
      if (cli.clientEmail) meta.append(el("div", "small", `Client Portal Email: ${cli.clientEmail}`));
      if (cli.targetAudience) meta.append(el("div", "small muted", `Audience: ${cli.targetAudience}`));
      if (cli.brandGuidelines) meta.append(el("div", "small muted", `Guidelines: ${cli.brandGuidelines}`));
      const brandColors = Array.isArray(cli.brandColors) ? cli.brandColors : [];
      const approvedTags = Array.isArray(cli.contentPreferences?.approvedTags)
        ? cli.contentPreferences.approvedTags
        : [];
      if (brandColors.length) {
        const swatchRow = el("div", "row-actions");
        swatchRow.style.marginTop = "6px";
        for (const col of brandColors) {
          const sw = el("span", "color-chip");
          const dot = el("span", "color-dot");
          dot.style.background = col;
          sw.append(dot, el("span", "mono small", col));
          swatchRow.append(sw);
        }
        meta.append(swatchRow);
      }
      const socialParts = [
        cli.socialAccounts?.instagram ? `IG: ${cli.socialAccounts.instagram}` : "",
        cli.socialAccounts?.tiktok ? `TikTok: ${cli.socialAccounts.tiktok}` : "",
      ].filter(Boolean);
      if (socialParts.length) {
        meta.append(el("div", "small muted", socialParts.join(" · ")));
      }
      meta.append(
        el(
          "div",
          "small muted",
          `Projects: ${cliProjects.length} · Approved tags: ${approvedTags.join(", ") || "None yet"}`
        )
      );
      card.append(meta);

      const footer = el("div", "actions");
      footer.append(
        btn("Plan Ideas →", "btn", () => {
          ctx.setSelectedClientId(cli.clientId);
          ctx.navigate("ideas", { clientId: cli.clientId });
        }),
        btn("Projects →", "btn", () => {
          ctx.setSelectedClientId(cli.clientId);
          ctx.navigate("projects", { clientId: cli.clientId });
        })
      );
      card.append(footer);
      cards.append(card);
    }
    container.append(cards);
  };

  draw();
}

export function renderIdeasView(container: HTMLElement, ctx: AppContext): void {
  const initialSnap = ctx.getSnapshot();
  const state = {
    filterClientId: ctx.getSelectedClientId() || "",
    showForm: false,
    editingId: "",
    saving: false,
    recommending: false,
    formError: "",
    busyIdeaIds: new Set<string>(),
    changingIdeaId: "",
    changeNote: "",
    recommendations: [] as Array<{ ideaId: string; title: string; score: number; reason: string }>,
  };

  const draft = {
    clientId: state.filterClientId || initialSnap.clients[0]?.clientId || "",
    title: "",
    hook: "",
    category: "Educational",
    niche: "",
    tags: "",
    referenceLinks: "",
    notes: "",
  };

  const loadDraft = (idea?: ContentIdeaRecord) => {
    const snapNow = ctx.getSnapshot();
    state.editingId = idea?.ideaId || "";
    state.formError = "";
    draft.clientId = idea?.clientId || state.filterClientId || snapNow.clients[0]?.clientId || "";
    draft.title = idea?.title || "";
    draft.hook = idea?.hook || "";
    draft.category = idea?.category || "Educational";
    draft.niche = idea?.niche || "";
    draft.tags = (idea?.tags || []).join(", ");
    draft.referenceLinks = (idea?.referenceLinks || []).join("\n");
    draft.notes = idea?.notes || "";
  };

  const runRecommender = async () => {
    if (state.recommending) return;
    const snapNow = ctx.getSnapshot();
    const cid = state.filterClientId || snapNow.clients[0]?.clientId;
    const cli = snapNow.clients.find((c) => c.clientId === cid);
    const scopedIdeas = cid ? snapNow.ideas.filter((i) => i.clientId === cid) : snapNow.ideas;
    if (scopedIdeas.length === 0) {
      state.recommendations = [];
      showToast("No ideas available to score for this filter.", "info");
      draw();
      return;
    }
    state.recommending = true;
    draw();
    try {
      const r = await ctx.apiFetch("/v1/crm/recommend-ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ideas: scopedIdeas.map((i) => ({
            id: i.ideaId,
            title: i.title,
            category: i.category || "",
            niche: i.niche || "",
            tags: i.tags || [],
            status: i.status,
          })),
          preferred_tags: cli?.contentPreferences?.approvedTags || [],
          client_niche: cli?.niche || "",
        }),
      });
      const data = (await r.json()) as { recommendations?: typeof state.recommendations };
      state.recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
      if (state.recommendations.length === 0) {
        showToast("No tag or niche matches yet — approve at least one idea first.", "info");
      }
    } catch (e) {
      showToast(formatUserError(e, "Failed to score recommendations."), "err");
    } finally {
      state.recommending = false;
      draw();
    }
  };

  const handleIdeaReview = async (
    idea: ContentIdeaRecord,
    decision: IdeaScriptStatus,
    note: string,
    successMsg: string,
    successTone: "ok" | "info" = "ok"
  ) => {
    if (state.busyIdeaIds.has(idea.ideaId)) return;
    state.busyIdeaIds.add(idea.ideaId);
    draw();
    try {
      const snapNow = ctx.getSnapshot();
      const cli = snapNow.clients.find((c) => c.clientId === idea.clientId);
      await reviewIdea(idea, decision, note, cli);
      await ctx.refreshSnapshot();
      if (state.changingIdeaId === idea.ideaId) {
        state.changingIdeaId = "";
        state.changeNote = "";
      }
      showToast(successMsg, successTone);
    } catch (e) {
      showToast(formatUserError(e, "Failed to update content idea status."), "err");
    } finally {
      state.busyIdeaIds.delete(idea.ideaId);
      draw();
    }
  };

  const draw = () => {
    if (!container.isConnected) return;
    const snap = ctx.getSnapshot();
    if (state.filterClientId && !snap.clients.some((c) => c.clientId === state.filterClientId)) {
      state.filterClientId = "";
    }
    if (!draft.clientId || !snap.clients.some((c) => c.clientId === draft.clientId)) {
      draft.clientId = state.filterClientId || snap.clients[0]?.clientId || "";
    }

    container.replaceChildren();
    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Pre-Production"),
      el("h1", "", "Content Ideas & Recommendations"),
      el("div", "muted", "Plan ideas by niche/category, attach reference links, and submit for client approval.")
    );
    const hr = el("div", "row-actions");
    const cliFilter = selectField(
      "Filter by Client",
      state.filterClientId,
      [["", "All Clients"], ...snap.clients.map((c): [string, string] => [c.clientId, c.name])],
      (v) => {
        state.filterClientId = v;
        ctx.setSelectedClientId(v);
        if (state.showForm && !state.editingId && v) {
          draft.clientId = v;
        }
        draw();
      }
    );
    hr.append(
      cliFilter.wrap,
      btn(
        state.recommending ? "Scoring…" : "Score Recommendations",
        "btn",
        () => void runRecommender(),
        state.recommending
      ),
      btn(state.showForm ? "Close Form" : "+ New Idea", "btn primary", () => {
        if (!state.showForm) loadDraft(undefined);
        state.showForm = !state.showForm;
        draw();
      })
    );
    head.append(hl, hr);
    container.append(head);

    if (state.showForm) {
      const panel = el("section", "panel");
      panel.append(el("div", "panelhead", state.editingId ? "Edit Content Idea" : "Create Content Idea"));
      if (snap.clients.length === 0) {
        panel.append(el("div", "notice", "Create a Client Workspace first before adding Content Ideas."));
      } else {
        const grid = el("div", "fields");
        grid.append(
          selectField(
            "Client Workspace *",
            draft.clientId,
            snap.clients.map((c): [string, string] => [c.clientId, c.name]),
            (v) => {
              draft.clientId = v;
              state.formError = "";
            },
            { disabled: Boolean(state.editingId) || state.saving }
          ).wrap,
          inputField("Idea Title *", draft.title, (v) => {
            draft.title = v;
            state.formError = "";
          }, { disabled: state.saving }).wrap,
          inputField("Category", draft.category, (v) => (draft.category = v), {
            placeholder: "Tutorial / Myth Bust / Case Study",
            disabled: state.saving,
          }).wrap,
          inputField("Niche", draft.niche, (v) => (draft.niche = v), { disabled: state.saving }).wrap,
          inputField("Tags (comma separated)", draft.tags, (v) => (draft.tags = v), {
            wide: true,
            placeholder: "hooks, fitness, nutrition",
            disabled: state.saving,
          }).wrap,
          textareaField("Opening Hook", draft.hook, (v) => (draft.hook = v), {
            wide: true,
            rows: 2,
            disabled: state.saving,
          }).wrap,
          textareaField("Manual Reference Reel Links (one per line)", draft.referenceLinks, (v) => (draft.referenceLinks = v), {
            wide: true,
            rows: 2,
            disabled: state.saving,
          }).wrap,
          textareaField("Production Notes", draft.notes, (v) => (draft.notes = v), {
            wide: true,
            rows: 2,
            disabled: state.saving,
          }).wrap
        );
        if (state.formError) {
          panel.append(grid, el("div", "notice", state.formError));
        } else {
          panel.append(grid);
        }
        const act = el("div", "actions");
        act.append(
          btn(
            "Cancel",
            "btn",
            () => {
              state.showForm = false;
              state.formError = "";
              draw();
            },
            state.saving
          ),
          btn(
            state.saving ? "Saving…" : state.editingId ? "Save Changes" : "Save Idea",
            "btn primary",
            async () => {
              if (state.saving) return;
              const trimmedTitle = draft.title.trim();
              if (!draft.clientId || !trimmedTitle) {
                state.formError = "Select a client workspace and enter an idea title.";
                showToast(state.formError, "err");
                draw();
                return;
              }
              const duplicate = snap.ideas.find(
                (i) =>
                  i.clientId === draft.clientId &&
                  i.title.trim().toLowerCase() === trimmedTitle.toLowerCase() &&
                  i.ideaId !== state.editingId
              );
              if (duplicate) {
                state.formError = `A content idea titled "${trimmedTitle}" already exists for this client workspace.`;
                showToast(state.formError, "err");
                draw();
                return;
              }

              state.saving = true;
              state.formError = "";
              draw();
              try {
                const targetClientId = draft.clientId;
                const cli = snap.clients.find((c) => c.clientId === targetClientId);
                await saveIdea(
                  {
                    clientId: targetClientId,
                    title: trimmedTitle,
                    hook: draft.hook,
                    category: draft.category,
                    niche: draft.niche,
                    tags: draft.tags.split(",").map((s) => s.trim()).filter(Boolean),
                    referenceLinks: draft.referenceLinks.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
                    notes: draft.notes,
                  },
                  cli,
                  state.editingId || undefined
                );
                await ctx.refreshSnapshot();
                if (state.filterClientId && state.filterClientId !== targetClientId) {
                  state.filterClientId = targetClientId;
                  ctx.setSelectedClientId(targetClientId);
                }
                state.showForm = false;
                state.editingId = "";
                showToast("Content idea saved.", "ok");
              } catch (e) {
                const msg = formatUserError(e, "Failed to save content idea.");
                state.formError = msg;
                showToast(msg, "err");
              } finally {
                state.saving = false;
                draw();
              }
            },
            state.saving
          )
        );
        panel.append(act);
      }
      container.append(panel);
    }

    if (state.recommendations.length > 0) {
      const recPanel = el("section", "panel");
      recPanel.append(
        el("div", "panelhead", "Rule-Based Recommendations (Tag, Category & Niche Overlap)")
      );
      const list = el("div", "list-stack");
      for (const rec of state.recommendations) {
        const row = el("div", "list-row");
        const m = el("div", "list-meta");
        m.append(el("div", "list-title", rec.title), el("div", "list-sub", rec.reason));
        row.append(m, badge(`Score ${rec.score}`, "purple"));
        list.append(row);
      }
      recPanel.append(list);
      container.append(recPanel);
    }

    const visibleIdeas = state.filterClientId
      ? snap.ideas.filter((i) => i.clientId === state.filterClientId)
      : snap.ideas;

    if (visibleIdeas.length === 0) {
      const empty = el("section", "panel");
      empty.append(el("div", "empty", "No content ideas match this filter."));
      container.append(empty);
      return;
    }

    const listWrap = el("div", "crm-cards");
    for (const idea of visibleIdeas) {
      const cli = snap.clients.find((c) => c.clientId === idea.clientId);
      const isBusy = state.busyIdeaIds.has(idea.ideaId);
      const card = el("section", "panel");
      const ch = el("div", "panelhead");
      const tl = el("div");
      tl.append(
        el("h2", "", idea.title),
        el(
          "div",
          "small muted",
          [cli?.name || idea.clientId, idea.category, idea.niche].filter(Boolean).join(" · ")
        )
      );
      const ideaStatus = idea.status || "draft";
      const ideaTags = Array.isArray(idea.tags) ? idea.tags : [];
      const ideaRefs = Array.isArray(idea.referenceLinks) ? idea.referenceLinks : [];
      const tr = el("div", "row-actions");
      tr.append(badge(ideaStatus.replace("_", " "), statusTone(ideaStatus)));
      card.append(ch);
      ch.append(tl, tr);

      if (idea.hook) card.append(el("div", "small", `Hook: ${idea.hook}`));
      if (ideaTags.length) card.append(el("div", "small muted", `Tags: ${ideaTags.join(", ")}`));
      if (ideaRefs.length) {
        card.append(el("div", "small muted", `Reference links: ${ideaRefs.join(" · ")}`));
      }
      if (idea.reviewNote) {
        card.append(el("div", "small", `Review note: ${idea.reviewNote}`));
      }

      if (state.changingIdeaId === idea.ideaId) {
        const noteBox = el("div", "subpanel");
        noteBox.append(
          inputField(
            "Change Request Note",
            state.changeNote,
            (v) => (state.changeNote = v),
            { placeholder: "Describe requested updates…", wide: true, disabled: isBusy }
          ).wrap
        );
        const noteActs = el("div", "actions");
        noteActs.append(
          btn(
            isBusy ? "Processing…" : "Submit Change Request",
            "btn primary",
            () =>
              void handleIdeaReview(
                idea,
                "changes_requested",
                state.changeNote.trim() || "Changes requested during review",
                "Change request saved.",
                "info"
              ),
            isBusy
          ),
          btn(
            "Cancel",
            "mini",
            () => {
              state.changingIdeaId = "";
              state.changeNote = "";
              draw();
            },
            isBusy
          )
        );
        noteBox.append(noteActs);
        card.append(noteBox);
      }

      const actions = el("div", "actions");
      if (ideaStatus === "draft" || ideaStatus === "changes_requested") {
        actions.append(
          btn(
            "Edit",
            "mini",
            () => {
              loadDraft(idea);
              state.showForm = true;
              draw();
            },
            isBusy
          ),
          btn(
            isBusy ? "Processing…" : "Submit for Approval",
            "btn",
            () =>
              void handleIdeaReview(
                idea,
                "pending_approval",
                "",
                "Submitted idea for approval.",
                "ok"
              ),
            isBusy
          )
        );
      }
      actions.append(
        btn(
          isBusy ? "Processing…" : "Approve",
          "btn primary",
          () =>
            void handleIdeaReview(
              idea,
              "approved",
              "Approved for scripting",
              "Idea approved & tags recorded.",
              "ok"
            ),
          isBusy || ideaStatus === "approved"
        ),
        btn(
          "Request Changes",
          "mini",
          () => {
            state.changingIdeaId = idea.ideaId;
            state.changeNote = idea.reviewNote || "";
            draw();
          },
          isBusy
        ),
        btn(
          "Reject",
          "mini btn-danger",
          () =>
            void handleIdeaReview(
              idea,
              "rejected",
              "Rejected during review",
              "Idea marked rejected.",
              "info"
            ),
          isBusy || ideaStatus === "rejected"
        )
      );
      if (ideaStatus === "approved") {
        actions.append(
          btn("Write Script →", "btn", () => {
            ctx.setSelectedClientId(idea.clientId);
            ctx.navigate("scripts", { clientId: idea.clientId });
          })
        );
      }
      card.append(actions);
      listWrap.append(card);
    }
    container.append(listWrap);
  };

  draw();
}

export function renderScriptsView(container: HTMLElement, ctx: AppContext): void {
  const initialSnap = ctx.getSnapshot();
  const state = {
    filterClientId: ctx.getSelectedClientId() || "",
    showForm: false,
    editingId: "",
    saving: false,
    formError: "",
    busyScriptIds: new Set<string>(),
    changingScriptId: "",
    changeNote: "",
  };
  const draft = {
    clientId: state.filterClientId || initialSnap.clients[0]?.clientId || "",
    ideaId: "",
    title: "",
    hook: "",
    talkingPoints: "",
    cta: "",
    captionText: "",
    estimatedDurationS: "30",
  };

  const loadDraft = (s?: ScriptRecord) => {
    const snapNow = ctx.getSnapshot();
    state.editingId = s?.scriptId || "";
    state.formError = "";
    draft.clientId = s?.clientId || state.filterClientId || snapNow.clients[0]?.clientId || "";
    draft.ideaId = s?.ideaId || "";
    draft.title = s?.title || "";
    draft.hook = s?.hook || "";
    draft.talkingPoints = (s?.talkingPoints || []).join("\n");
    draft.cta = s?.cta || "";
    draft.captionText = s?.captionText || "";
    draft.estimatedDurationS = s?.estimatedDurationS ? String(s.estimatedDurationS) : "30";
  };

  const handleScriptReview = async (
    scr: ScriptRecord,
    decision: IdeaScriptStatus,
    note: string,
    msg: string,
    tone: "ok" | "info" = "ok"
  ) => {
    if (state.busyScriptIds.has(scr.scriptId)) return;
    state.busyScriptIds.add(scr.scriptId);
    draw();
    try {
      await reviewScript(scr, decision, note);
      await ctx.refreshSnapshot();
      if (state.changingScriptId === scr.scriptId) {
        state.changingScriptId = "";
        state.changeNote = "";
      }
      showToast(msg, tone);
    } catch (e) {
      showToast(formatUserError(e, "Failed to update script."), "err");
    } finally {
      state.busyScriptIds.delete(scr.scriptId);
      draw();
    }
  };

  const draw = () => {
    if (!container.isConnected) return;
    const snap = ctx.getSnapshot();
    if (state.filterClientId && !snap.clients.some((c) => c.clientId === state.filterClientId)) {
      state.filterClientId = "";
    }
    if (!draft.clientId || !snap.clients.some((c) => c.clientId === draft.clientId)) {
      draft.clientId = state.filterClientId || snap.clients[0]?.clientId || "";
    }

    container.replaceChildren();
    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Scripting"),
      el("h1", "", "Video Scripts & Captions"),
      el("div", "muted", "Define hooks, talking points, CTAs, captions, and run client script approval.")
    );
    const hr = el("div", "row-actions");
    hr.append(
      selectField(
        "Filter by Client",
        state.filterClientId,
        [["", "All Clients"], ...snap.clients.map((c): [string, string] => [c.clientId, c.name])],
        (v) => {
          state.filterClientId = v;
          ctx.setSelectedClientId(v);
          draw();
        }
      ).wrap,
      btn(state.showForm ? "Close Form" : "+ New Script", "btn primary", () => {
        if (!state.showForm) loadDraft(undefined);
        state.showForm = !state.showForm;
        draw();
      })
    );
    head.append(hl, hr);
    container.append(head);

    if (state.showForm) {
      const panel = el("section", "panel");
      panel.append(el("div", "panelhead", state.editingId ? "Edit Script" : "Create Video Script"));
      if (snap.clients.length === 0) {
        panel.append(el("div", "notice", "Create a Client Workspace first."));
      } else {
        const clientIdeas = snap.ideas.filter((i) => i.clientId === draft.clientId);
        const grid = el("div", "fields");
        grid.append(
          selectField(
            "Client Workspace *",
            draft.clientId,
            snap.clients.map((c): [string, string] => [c.clientId, c.name]),
            (v) => {
              draft.clientId = v;
              draw();
            },
            { disabled: Boolean(state.editingId) || state.saving }
          ).wrap,
          selectField(
            "Linked Content Idea (optional)",
            draft.ideaId,
            [["", "None"], ...clientIdeas.map((i): [string, string] => [i.ideaId, `${i.title} (${i.status})`])],
            (v) => (draft.ideaId = v),
            { disabled: state.saving }
          ).wrap,
          inputField("Script Title *", draft.title, (v) => (draft.title = v), { disabled: state.saving }).wrap,
          inputField("Estimated Duration (s)", draft.estimatedDurationS, (v) => (draft.estimatedDurationS = v), {
            type: "number",
            min: "1",
            disabled: state.saving,
          }).wrap,
          textareaField("Hook (First 3 seconds)", draft.hook, (v) => (draft.hook = v), {
            wide: true,
            rows: 2,
            disabled: state.saving,
          }).wrap,
          textareaField("Talking Points (one per line)", draft.talkingPoints, (v) => (draft.talkingPoints = v), {
            wide: true,
            rows: 4,
            disabled: state.saving,
          }).wrap,
          inputField("Call to Action (CTA)", draft.cta, (v) => (draft.cta = v), {
            wide: true,
            disabled: state.saving,
          }).wrap,
          textareaField("Social Post Caption", draft.captionText, (v) => (draft.captionText = v), {
            wide: true,
            rows: 3,
            disabled: state.saving,
          }).wrap
        );
        if (state.formError) {
          panel.append(grid, el("div", "notice", state.formError));
        } else {
          panel.append(grid);
        }
        const act = el("div", "actions");
        act.append(
          btn(
            "Cancel",
            "btn",
            () => {
              state.showForm = false;
              state.formError = "";
              draw();
            },
            state.saving
          ),
          btn(
            state.saving ? "Saving…" : state.editingId ? "Save Script" : "Create Script",
            "btn primary",
            async () => {
              if (state.saving) return;
              if (!draft.clientId || !draft.title.trim()) {
                state.formError = "Client and script title are required.";
                showToast(state.formError, "err");
                draw();
                return;
              }
              state.saving = true;
              state.formError = "";
              draw();
              try {
                const targetClientId = draft.clientId;
                const cli = snap.clients.find((c) => c.clientId === targetClientId);
                await saveScript(
                  {
                    clientId: targetClientId,
                    ideaId: draft.ideaId || undefined,
                    title: draft.title,
                    hook: draft.hook,
                    talkingPoints: draft.talkingPoints.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
                    cta: draft.cta,
                    captionText: draft.captionText,
                    estimatedDurationS: Number(draft.estimatedDurationS) || 30,
                  },
                  cli,
                  state.editingId || undefined
                );
                await ctx.refreshSnapshot();
                if (state.filterClientId && state.filterClientId !== targetClientId) {
                  state.filterClientId = targetClientId;
                  ctx.setSelectedClientId(targetClientId);
                }
                state.showForm = false;
                state.editingId = "";
                showToast("Script saved.", "ok");
              } catch (e) {
                const msg = formatUserError(e, "Failed to save script.");
                state.formError = msg;
                showToast(msg, "err");
              } finally {
                state.saving = false;
                draw();
              }
            },
            state.saving
          )
        );
        panel.append(act);
      }
      container.append(panel);
    }

    const visible = state.filterClientId
      ? snap.scripts.filter((s) => s.clientId === state.filterClientId)
      : snap.scripts;

    if (visible.length === 0) {
      const empty = el("section", "panel");
      empty.append(el("div", "empty", "No scripts created yet."));
      container.append(empty);
      return;
    }

    const cards = el("div", "crm-cards");
    for (const scr of visible) {
      const cli = snap.clients.find((c) => c.clientId === scr.clientId);
      const isBusy = state.busyScriptIds.has(scr.scriptId);
      const scrStatus = scr.status || "draft";
      const talkingPoints = Array.isArray(scr.talkingPoints) ? scr.talkingPoints : [];
      const card = el("section", "panel");
      const ch = el("div", "panelhead");
      const tl = el("div");
      tl.append(
        el("h2", "", scr.title || "Untitled Script"),
        el(
          "div",
          "small muted",
          `${cli?.name || scr.clientId} · ${scr.estimatedDurationS || 30}s est.`
        )
      );
      ch.append(tl, badge(scrStatus.replace("_", " "), statusTone(scrStatus)));
      card.append(ch);

      if (scr.hook) card.append(el("div", "small", `Hook: ${scr.hook}`));
      if (talkingPoints.length) {
        const ul = el("ul", "script-points");
        for (const pt of talkingPoints) ul.append(el("li", "small muted", pt));
        card.append(ul);
      }
      if (scr.cta) card.append(el("div", "small", `CTA: ${scr.cta}`));
      if (scr.captionText) card.append(el("div", "small muted", `Caption: ${scr.captionText}`));
      if (scr.reviewNote) card.append(el("div", "small", `Review note: ${scr.reviewNote}`));

      if (state.changingScriptId === scr.scriptId) {
        const noteBox = el("div", "subpanel");
        noteBox.append(
          inputField(
            "Script Revision Note",
            state.changeNote,
            (v) => (state.changeNote = v),
            { placeholder: "Describe requested script changes…", wide: true, disabled: isBusy }
          ).wrap
        );
        const noteActs = el("div", "actions");
        noteActs.append(
          btn(
            isBusy ? "Processing…" : "Submit Revision Note",
            "btn primary",
            () =>
              void handleScriptReview(
                scr,
                "changes_requested",
                state.changeNote.trim() || "Revision requested",
                "Revision request saved.",
                "info"
              ),
            isBusy
          ),
          btn(
            "Cancel",
            "mini",
            () => {
              state.changingScriptId = "";
              state.changeNote = "";
              draw();
            },
            isBusy
          )
        );
        noteBox.append(noteActs);
        card.append(noteBox);
      }

      const act = el("div", "actions");
      act.append(
        btn(
          "Edit",
          "mini",
          () => {
            loadDraft(scr);
            state.showForm = true;
            draw();
          },
          isBusy
        ),
        btn(
          isBusy ? "Processing…" : "Submit Approval",
          "btn",
          () => void handleScriptReview(scr, "pending_approval", "", "Script submitted for approval."),
          isBusy
        ),
        btn(
          isBusy ? "Processing…" : "Approve",
          "btn primary",
          () => void handleScriptReview(scr, "approved", "Script approved for filming", "Script approved."),
          isBusy || scrStatus === "approved"
        ),
        btn(
          "Request Changes",
          "mini",
          () => {
            state.changingScriptId = scr.scriptId;
            state.changeNote = scr.reviewNote || "";
            draw();
          },
          isBusy
        )
      );
      if (scrStatus === "approved") {
        const linkedIdea = scr.ideaId
          ? snap.ideas.find((i) => i.ideaId === scr.ideaId)
          : undefined;
        const existingProj = snap.projects.find(
          (p) => p.clientId === scr.clientId && p.scriptId === scr.scriptId
        );
        act.append(
          btn(
            existingProj ? "Create Project from Script →" : "Create Project from Script →",
            "btn primary",
            () => {
              ctx.setSelectedClientId(scr.clientId);
              ctx.navigate("projects", {
                clientId: scr.clientId,
                projectId: existingProj?.projectId || "",
                createProjectIntent: {
                  openCreateForm: true,
                  clientId: scr.clientId,
                  scriptId: scr.scriptId,
                  ideaId: scr.ideaId || linkedIdea?.ideaId || "",
                  title: scr.title,
                  targetDurationS: scr.estimatedDurationS || 30,
                  hook: scr.hook || linkedIdea?.hook || "",
                  captionText: scr.captionText || "",
                  aspectRatio: cli?.contentPreferences?.aspectRatio || "9:16",
                },
              });
            },
            isBusy
          )
        );
      }
      card.append(act);
      cards.append(card);
    }
    container.append(cards);
  };

  draw();
}

function normalizeCaptionStyle(raw?: string): "bold-yellow" | "white-box" | "plain" {
  const v = (raw || "").trim().toLowerCase();
  if (v === "white-box" || v.includes("white")) return "white-box";
  if (v === "plain" || v.includes("minimal") || v.includes("clean")) return "plain";
  return "bold-yellow";
}

function normalizeFontFamily(fonts?: string[]): "sans" | "serif" | "mono" {
  const joined = (fonts || []).join(" ").toLowerCase();
  if (joined.includes("serif")) return "serif";
  if (joined.includes("mono") || joined.includes("code") || joined.includes("courier")) return "mono";
  return "sans";
}

function buildCaptionSegmentsFromText(
  captionText: string,
  durationS: number
): Array<{ start: number; end: number; text: string }> {
  const rawLines = captionText
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim().slice(0, 180))
    .filter(Boolean);
  if (rawLines.length === 0) return [];
  const totalDur = Math.max(2, Math.min(3600, durationS || 30));
  const step = Math.max(1.2, Math.min(4.5, totalDur / rawLines.length));
  return rawLines.slice(0, 50).map((text, idx) => {
    const start = Number((idx * step).toFixed(2));
    const end = Number((start + Math.max(0.8, step - 0.1)).toFixed(2));
    return { start, end, text };
  });
}

export function renderProjectsView(container: HTMLElement, ctx: AppContext): void {
  const initialSnap = ctx.getSnapshot();
  const createIntent = ctx.consumeProjectCreateIntent();

  const resolveInitialClientId = (): string => {
    if (createIntent?.clientId && initialSnap.clients.some((c) => c.clientId === createIntent.clientId)) {
      return createIntent.clientId;
    }
    const selCid = ctx.getSelectedClientId();
    if (selCid && initialSnap.clients.some((c) => c.clientId === selCid)) {
      return selCid;
    }
    return initialSnap.clients[0]?.clientId || "";
  };

  const initialClientId = resolveInitialClientId();
  if (createIntent?.clientId) {
    ctx.setSelectedClientId(createIntent.clientId);
  }

  const state = {
    showForm: Boolean(createIntent?.openCreateForm),
    saving: false,
    formError: "",
    filterClientId: createIntent?.clientId || ctx.getSelectedClientId() || "",
    highlightedProjectId: ctx.getSelectedProjectId() || "",
    assetStatusMap: new Map<string, { available: boolean; message: string }>(),
  };

  const initialCli = initialSnap.clients.find((c) => c.clientId === initialClientId);
  const initialScript = createIntent?.scriptId
    ? initialSnap.scripts.find((s) => s.scriptId === createIntent.scriptId)
    : undefined;
  const initialIdea = (createIntent?.ideaId || initialScript?.ideaId)
    ? initialSnap.ideas.find((i) => i.ideaId === (createIntent?.ideaId || initialScript?.ideaId))
    : undefined;

  const draft = {
    clientId: initialClientId,
    title: createIntent?.title ?? initialScript?.title ?? "",
    ideaId: createIntent?.ideaId ?? initialScript?.ideaId ?? "",
    scriptId: createIntent?.scriptId ?? "",
    aspectRatio: (createIntent?.aspectRatio ||
      initialCli?.contentPreferences?.aspectRatio ||
      "9:16") as AspectRatio,
    targetDurationS: String(
      createIntent?.targetDurationS ?? initialScript?.estimatedDurationS ?? 30
    ),
    deadline: "",
    status: "Awaiting Footage" as ProjectStatus,
    hook: createIntent?.hook ?? initialScript?.hook ?? initialIdea?.hook ?? "",
    captionText: createIntent?.captionText ?? initialScript?.captionText ?? "",
    captionStyle: normalizeCaptionStyle(initialCli?.contentPreferences?.captionStyle),
    fontFamily: normalizeFontFamily(initialCli?.preferredFonts),
    brandTone: initialCli?.contentPreferences?.tone || "",
    rawFootageFile: null as File | null,
    referenceVideoFile: null as File | null,
  };

  const applyClientBrandDefaults = (clientId: string) => {
    const cli = ctx.getSnapshot().clients.find((c) => c.clientId === clientId);
    if (!cli) return;
    draft.aspectRatio = cli.contentPreferences?.aspectRatio || "9:16";
    draft.captionStyle = normalizeCaptionStyle(cli.contentPreferences?.captionStyle);
    draft.fontFamily = normalizeFontFamily(cli.preferredFonts);
    draft.brandTone = cli.contentPreferences?.tone || "";
  };

  const applyScriptDefaults = (scriptId: string) => {
    const snapNow = ctx.getSnapshot();
    const scr = snapNow.scripts.find((s) => s.scriptId === scriptId);
    if (!scr) return;
    const linkedIdea = scr.ideaId
      ? snapNow.ideas.find((i) => i.ideaId === scr.ideaId)
      : undefined;
    draft.ideaId = scr.ideaId || linkedIdea?.ideaId || "";
    draft.title = scr.title || "";
    draft.targetDurationS = String(scr.estimatedDurationS || 30);
    draft.hook = scr.hook || linkedIdea?.hook || "";
    draft.captionText = scr.captionText || "";
  };

  const checkAssetStatus = async (projectId: string, assetId: string) => {
    try {
      const r = await ctx.apiFetch(`/v1/projects/${projectId}/assets/${assetId}/status`);
      const d = (await r.json()) as { available: boolean; message: string };
      state.assetStatusMap.set(assetId, { available: Boolean(d.available), message: d.message });
      draw();
    } catch {
      // ignore
    }
  };

  const uploadProjectAsset = async (
    project: ProjectRecord,
    kind: "source" | "reference",
    file: File,
    opts: { silentRefresh?: boolean } = {}
  ) => {
    const fd = new FormData();
    fd.append("video", file, file.name);
    fd.append("kind", kind);
    if (project.clientUid) fd.append("client_uid", project.clientUid);
    if (project.clientEmail) fd.append("client_email", project.clientEmail);

    showToast(`Uploading ${kind} video "${file.name}"…`, "info");
    const r = await ctx.apiFetch(`/v1/projects/${project.projectId}/assets`, {
      method: "POST",
      body: fd,
    });
    const d = (await r.json()) as {
      asset_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      duration_s: number;
      width: number;
      height: number;
      storage_provider: "local_temp" | "r2";
      expires_at?: string;
      reference_analysis?: ProjectRecord["referenceMetrics"];
    };

    await saveUploadedAssetMetadata({
      assetId: d.asset_id,
      project,
      kind,
      filename: d.filename,
      mimeType: d.mime_type,
      sizeBytes: d.size_bytes,
      durationS: d.duration_s,
      width: d.width,
      height: d.height,
      storageProvider: d.storage_provider,
      expiresAt: d.expires_at,
      referenceAnalysis: d.reference_analysis || null,
    });
    state.assetStatusMap.set(d.asset_id, {
      available: true,
      message: "Uploaded and ready on server storage.",
    });
    if (!opts.silentRefresh) {
      await ctx.refreshSnapshot();
      showToast(`${kind === "source" ? "Source footage" : "Reference video"} uploaded.`, "ok");
      draw();
    }
  };

  const draw = () => {
    if (!container.isConnected) return;
    const snap = ctx.getSnapshot();
    if (state.filterClientId && !snap.clients.some((c) => c.clientId === state.filterClientId)) {
      state.filterClientId = "";
    }
    if (!draft.clientId || !snap.clients.some((c) => c.clientId === draft.clientId)) {
      draft.clientId = state.filterClientId || snap.clients[0]?.clientId || "";
      if (draft.clientId) applyClientBrandDefaults(draft.clientId);
    }

    container.replaceChildren();
    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Production"),
      el("h1", "", "Content Projects"),
      el(
        "div",
        "muted",
        "Upload raw footage & reference reels, apply extracted reference metrics, and launch First Cut rendering."
      )
    );
    const hr = el("div", "row-actions");
    hr.append(
      selectField(
        "Filter by Client",
        state.filterClientId,
        [["", "All Clients"], ...snap.clients.map((c): [string, string] => [c.clientId, c.name])],
        (v) => {
          state.filterClientId = v;
          ctx.setSelectedClientId(v);
          if (v && state.showForm && !draft.scriptId) {
            draft.clientId = v;
            applyClientBrandDefaults(v);
          }
          draw();
        }
      ).wrap,
      btn(state.showForm ? "Close Form" : "+ New Project", "btn primary", () => {
        if (!state.showForm) {
          const fallbackClientId = state.filterClientId || snap.clients[0]?.clientId || "";
          draft.clientId = fallbackClientId;
          if (fallbackClientId) applyClientBrandDefaults(fallbackClientId);
        }
        state.showForm = !state.showForm;
        state.formError = "";
        draw();
      })
    );
    head.append(hl, hr);
    container.append(head);

    if (state.showForm) {
      const formPanel = el("section", "panel");
      formPanel.id = "projectCreateForm";
      const selectedClient = snap.clients.find((c) => c.clientId === draft.clientId);
      const linkedScript = draft.scriptId
        ? snap.scripts.find((s) => s.scriptId === draft.scriptId)
        : undefined;
      const existingDupByScript = draft.scriptId
        ? snap.projects.find(
            (p) => p.clientId === draft.clientId && p.scriptId === draft.scriptId
          )
        : undefined;
      const existingDupByTitle = draft.title.trim()
        ? snap.projects.find(
            (p) =>
              p.clientId === draft.clientId &&
              p.title.trim().toLowerCase() === draft.title.trim().toLowerCase()
          )
        : undefined;
      const existingMatch = existingDupByScript || existingDupByTitle;

      const formHead = el("div", "panelhead");
      formHead.append(
        el(
          "span",
          "",
          linkedScript
            ? `Create Content Project · From Script "${linkedScript.title}"`
            : "Create Content Project"
        ),
        linkedScript ? badge("Script Linked", "green") : badge("New Project", "purple")
      );
      formPanel.append(formHead);

      if (snap.clients.length === 0) {
        formPanel.append(el("div", "notice", "Create a Client Workspace first."));
      } else {
        if (existingMatch) {
          const dupWarn = el("div", "alert-banner");
          dupWarn.append(
            el(
              "div",
              "small",
              existingDupByScript
                ? `A project ("${existingMatch.title}") is already linked to this script in ${selectedClient?.name || "this client workspace"}. Open it below or pick a different script.`
                : `A project titled "${existingMatch.title}" already exists in ${selectedClient?.name || "this client workspace"}.`
            )
          );
          const dupActs = el("div", "row-actions");
          dupActs.style.marginTop = "8px";
          dupActs.append(
            btn("Open Existing Project", "mini", () => {
              state.showForm = false;
              state.formError = "";
              state.filterClientId = existingMatch.clientId;
              state.highlightedProjectId = existingMatch.projectId;
              ctx.setSelectedClientId(existingMatch.clientId);
              ctx.setSelectedProjectId(existingMatch.projectId);
              draw();
            })
          );
          dupWarn.append(dupActs);
          formPanel.append(dupWarn);
        }

        const clientIdeas = snap.ideas.filter((i) => i.clientId === draft.clientId);
        const clientScripts = snap.scripts.filter((s) => s.clientId === draft.clientId);
        const grid = el("div", "fields");
        grid.append(
          selectField(
            "Client Workspace *",
            draft.clientId,
            snap.clients.map((c): [string, string] => [c.clientId, c.name]),
            (v) => {
              draft.clientId = v;
              draft.ideaId = "";
              draft.scriptId = "";
              state.formError = "";
              applyClientBrandDefaults(v);
              draw();
            },
            { disabled: state.saving }
          ).wrap,
          inputField(
            "Project Title *",
            draft.title,
            (v) => {
              draft.title = v;
              state.formError = "";
            },
            { placeholder: "Enter project title…", disabled: state.saving }
          ).wrap,
          selectField(
            "Linked Content Idea",
            draft.ideaId,
            [["", "None"], ...clientIdeas.map((i): [string, string] => [i.ideaId, `${i.title} (${i.status})`])],
            (v) => {
              draft.ideaId = v;
              const chosenIdea = clientIdeas.find((i) => i.ideaId === v);
              if (chosenIdea && !draft.hook.trim() && chosenIdea.hook) {
                draft.hook = chosenIdea.hook;
                draw();
              }
            },
            { disabled: state.saving }
          ).wrap,
          selectField(
            "Linked Script",
            draft.scriptId,
            [["", "None"], ...clientScripts.map((s): [string, string] => [s.scriptId, `${s.title} (${s.status})`])],
            (v) => {
              draft.scriptId = v;
              state.formError = "";
              if (v) applyScriptDefaults(v);
              draw();
            },
            { disabled: state.saving }
          ).wrap,
          selectField(
            "Target Aspect Ratio",
            draft.aspectRatio,
            [
              ["9:16", "9:16 Reels / TikTok"],
              ["4:5", "4:5 Feed"],
              ["1:1", "1:1 Square"],
              ["16:9", "16:9 Landscape"],
            ],
            (v) => (draft.aspectRatio = v as AspectRatio),
            { disabled: state.saving }
          ).wrap,
          inputField(
            "Estimated Duration (s)",
            draft.targetDurationS,
            (v) => (draft.targetDurationS = v),
            { type: "number", min: "1", max: "3600", disabled: state.saving }
          ).wrap,
          inputField("Deadline", draft.deadline, (v) => (draft.deadline = v), {
            type: "date",
            disabled: state.saving,
          }).wrap,
          selectField(
            "Initial Stage",
            draft.status,
            ALL_PROJECT_STATUSES.map((st): [string, string] => [st, st]),
            (v) => (draft.status = v as ProjectStatus),
            { disabled: state.saving }
          ).wrap,
          textareaField(
            "Hook (First 3s Overlay)",
            draft.hook,
            (v) => (draft.hook = v),
            {
              wide: true,
              rows: 2,
              placeholder: "Opening hook text synced from approved script…",
              disabled: state.saving,
            }
          ).wrap,
          textareaField(
            "Captions / Social Post Copy",
            draft.captionText,
            (v) => (draft.captionText = v),
            {
              wide: true,
              rows: 3,
              placeholder: "Captions or script copy for Video Studio & social publishing…",
              disabled: state.saving,
            }
          ).wrap
        );
        formPanel.append(grid);

        // Brand preferences subpanel
        const brandBox = el("div", "subpanel");
        const brandHead = el("div", "panelhead");
        brandHead.append(
          el("h3", "", "Brand Preferences"),
          el("span", "small muted", selectedClient?.name || "Client Defaults")
        );
        brandBox.append(brandHead);

        const brandGrid = el("div", "fields");
        brandGrid.append(
          selectField(
            "Caption Style",
            draft.captionStyle,
            [
              ["bold-yellow", "Bold Yellow (High Contrast)"],
              ["white-box", "White Box Card"],
              ["plain", "Clean Plain Text"],
            ],
            (v) => (draft.captionStyle = normalizeCaptionStyle(v)),
            { disabled: state.saving }
          ).wrap,
          selectField(
            "Preferred Font Style",
            draft.fontFamily,
            [
              ["sans", "Modern Sans"],
              ["serif", "Editorial Serif"],
              ["mono", "Monospace"],
            ],
            (v) => (draft.fontFamily = (v === "serif" || v === "mono" ? v : "sans")),
            { disabled: state.saving }
          ).wrap,
          inputField(
            "Brand Tone",
            draft.brandTone,
            (v) => (draft.brandTone = v),
            { wide: true, placeholder: "e.g. Direct & energetic", disabled: state.saving }
          ).wrap
        );
        brandBox.append(brandGrid);

        const brandColors = Array.isArray(selectedClient?.brandColors)
          ? selectedClient.brandColors
          : [];
        const preferredFonts = Array.isArray(selectedClient?.preferredFonts)
          ? selectedClient.preferredFonts
          : [];
        const approvedTags = Array.isArray(selectedClient?.contentPreferences?.approvedTags)
          ? selectedClient.contentPreferences.approvedTags
          : [];
        if (brandColors.length > 0) {
          const swatchRow = el("div", "row-actions");
          for (const col of brandColors) {
            const sw = el("span", "color-chip");
            const dot = el("span", "color-dot");
            dot.style.background = col;
            sw.append(dot, el("span", "mono small", col));
            swatchRow.append(sw);
          }
          brandBox.append(swatchRow);
        }
        const brandMetaParts = [
          preferredFonts.length ? `Fonts: ${preferredFonts.join(", ")}` : "",
          approvedTags.length ? `Approved tags: ${approvedTags.join(", ")}` : "",
        ].filter(Boolean);
        if (brandMetaParts.length > 0) {
          brandBox.append(el("div", "small muted", brandMetaParts.join(" · ")));
        }
        if (selectedClient?.brandGuidelines) {
          brandBox.append(
            el("div", "small muted", `Guidelines: ${selectedClient.brandGuidelines.slice(0, 260)}`)
          );
        }
        formPanel.append(brandBox);

        // Optional Raw Footage & Reference Video pickers inside creation form
        const mediaGrid = el("div", "crm-two-col");

        const formSrcBox = el("div", "subpanel");
        formSrcBox.append(
          el("h3", "", "Raw Source Footage (Optional)"),
          el(
            "div",
            "small muted",
            draft.rawFootageFile
              ? `${draft.rawFootageFile.name} (${formatBytes(draft.rawFootageFile.size)})`
              : "Attach MP4/MOV footage now or upload later on the project card."
          )
        );
        const formSrcInp = document.createElement("input");
        formSrcInp.type = "file";
        formSrcInp.accept = ".mp4,.mov,video/mp4,video/quicktime";
        formSrcInp.hidden = true;
        formSrcInp.disabled = state.saving;
        formSrcInp.onchange = () => {
          draft.rawFootageFile = formSrcInp.files?.[0] || null;
          draw();
        };
        const formSrcActs = el("div", "row-actions");
        formSrcActs.append(
          formSrcInp,
          btn(
            draft.rawFootageFile ? "Change Raw Footage" : "Select Raw Footage",
            "btn",
            () => formSrcInp.click(),
            state.saving
          )
        );
        if (draft.rawFootageFile) {
          formSrcActs.append(
            btn(
              "Clear",
              "mini",
              () => {
                draft.rawFootageFile = null;
                draw();
              },
              state.saving
            )
          );
        }
        formSrcBox.append(formSrcActs);

        const formRefBox = el("div", "subpanel");
        formRefBox.append(
          el("h3", "", "Reference Video (Optional)"),
          el(
            "div",
            "small muted",
            draft.referenceVideoFile
              ? `${draft.referenceVideoFile.name} (${formatBytes(draft.referenceVideoFile.size)})`
              : "Attach a reference reel to analyze pacing, loudness, and aspect ratio."
          )
        );
        const formRefInp = document.createElement("input");
        formRefInp.type = "file";
        formRefInp.accept = ".mp4,.mov,video/mp4,video/quicktime";
        formRefInp.hidden = true;
        formRefInp.disabled = state.saving;
        formRefInp.onchange = () => {
          draft.referenceVideoFile = formRefInp.files?.[0] || null;
          draw();
        };
        const formRefActs = el("div", "row-actions");
        formRefActs.append(
          formRefInp,
          btn(
            draft.referenceVideoFile ? "Change Reference Video" : "Select Reference Video",
            "btn",
            () => formRefInp.click(),
            state.saving
          )
        );
        if (draft.referenceVideoFile) {
          formRefActs.append(
            btn(
              "Clear",
              "mini",
              () => {
                draft.referenceVideoFile = null;
                draw();
              },
              state.saving
            )
          );
        }
        formRefBox.append(formRefActs);

        mediaGrid.append(formSrcBox, formRefBox);
        formPanel.append(mediaGrid);

        if (state.formError) {
          formPanel.append(el("div", "notice", state.formError));
        }

        const act = el("div", "actions");
        act.append(
          btn(
            "Cancel",
            "btn",
            () => {
              state.showForm = false;
              state.formError = "";
              draft.rawFootageFile = null;
              draft.referenceVideoFile = null;
              draw();
            },
            state.saving
          ),
          btn(
            state.saving ? "Creating…" : "Create Project",
            "btn primary",
            async () => {
              if (state.saving) return;
              const trimmedTitle = draft.title.trim();
              if (!draft.clientId || !trimmedTitle) {
                state.formError = "Client workspace and project title are required.";
                showToast(state.formError, "err");
                draw();
                return;
              }
              const latestSnap = ctx.getSnapshot();
              const dupTitle = latestSnap.projects.find(
                (p) =>
                  p.clientId === draft.clientId &&
                  p.title.trim().toLowerCase() === trimmedTitle.toLowerCase()
              );
              if (dupTitle) {
                state.formError = `A project titled "${trimmedTitle}" already exists for this client workspace.`;
                showToast(state.formError, "err");
                draw();
                return;
              }
              if (draft.scriptId) {
                const dupScript = latestSnap.projects.find(
                  (p) => p.clientId === draft.clientId && p.scriptId === draft.scriptId
                );
                if (dupScript) {
                  state.formError = `A project ("${dupScript.title}") is already linked to this script in the selected workspace.`;
                  showToast(state.formError, "err");
                  draw();
                  return;
                }
              }

              state.saving = true;
              state.formError = "";
              draw();
              try {
                const targetClientId = draft.clientId;
                const cli = latestSnap.clients.find((c) => c.clientId === targetClientId);
                const estDuration = Math.max(1, Math.min(3600, Number(draft.targetDurationS) || 30));
                const trimmedHook = draft.hook.trim();
                const trimmedCaptions = draft.captionText.trim();
                const captionSegments = trimmedCaptions
                  ? buildCaptionSegmentsFromText(trimmedCaptions, estDuration)
                  : [];

                const editingOperations: StudioInstructions["operations"] = [
                  {
                    op: "reframe",
                    aspect: draft.aspectRatio,
                    mode: "crop",
                  },
                ];
                if (trimmedHook) {
                  editingOperations.push({
                    op: "overlay_text",
                    text: trimmedHook.slice(0, 180),
                    at: 0,
                    duration: Math.min(3.5, estDuration),
                    style: draft.captionStyle,
                    font_family: draft.fontFamily,
                    font_weight: "bold",
                    font_size_scale: 1,
                    max_words_per_line: 4,
                    position_preset: "top",
                  });
                }
                if (captionSegments.length > 0) {
                  editingOperations.push({
                    op: "captions",
                    source: "manual",
                    style: draft.captionStyle,
                    font_family: draft.fontFamily,
                    font_weight: "bold",
                    font_size_scale: 1,
                    max_words_per_line: 4,
                    position_preset: "bottom",
                    segments: captionSegments,
                  });
                }

                const createdProjectId = await saveProject(
                  {
                    clientId: targetClientId,
                    title: trimmedTitle,
                    ideaId: draft.ideaId || undefined,
                    scriptId: draft.scriptId || undefined,
                    targetAspectRatio: draft.aspectRatio,
                    targetDurationS: estDuration,
                    deadline: draft.deadline || undefined,
                    status: draft.status,
                    captionPreferences: {
                      style: draft.captionStyle,
                      font_family: draft.fontFamily,
                      max_words_per_line: 4,
                      hook: trimmedHook || undefined,
                      caption_text: trimmedCaptions || undefined,
                      brand_tone: draft.brandTone.trim() || undefined,
                      brand_colors: cli?.brandColors,
                      preferred_fonts: cli?.preferredFonts,
                    },
                    editingInstructions: {
                      schema_version: "1.0",
                      resolution_preset: "export_1080p",
                      operations: editingOperations,
                    },
                  },
                  cli
                );

                await ctx.refreshSnapshot();
                const createdProject = ctx
                  .getSnapshot()
                  .projects.find((p) => p.projectId === createdProjectId);

                let uploadErrorMsg = "";
                if (createdProject) {
                  if (draft.rawFootageFile) {
                    try {
                      await uploadProjectAsset(createdProject, "source", draft.rawFootageFile, {
                        silentRefresh: true,
                      });
                    } catch (upErr) {
                      uploadErrorMsg = formatUserError(
                        upErr,
                        "Project saved, but raw footage upload failed."
                      );
                    }
                  }
                  if (draft.referenceVideoFile) {
                    try {
                      const refreshedProj =
                        ctx.getSnapshot().projects.find((p) => p.projectId === createdProjectId) ||
                        createdProject;
                      await uploadProjectAsset(
                        refreshedProj,
                        "reference",
                        draft.referenceVideoFile,
                        { silentRefresh: true }
                      );
                    } catch (refErr) {
                      const refMsg = formatUserError(
                        refErr,
                        "Project saved, but reference video upload failed."
                      );
                      uploadErrorMsg = uploadErrorMsg ? `${uploadErrorMsg} ${refMsg}` : refMsg;
                    }
                  }
                  if (draft.rawFootageFile || draft.referenceVideoFile) {
                    await ctx.refreshSnapshot();
                  }
                }

                state.filterClientId = targetClientId;
                ctx.setSelectedClientId(targetClientId);
                ctx.setSelectedProjectId(createdProjectId);
                state.highlightedProjectId = createdProjectId;
                state.showForm = false;
                draft.rawFootageFile = null;
                draft.referenceVideoFile = null;

                if (uploadErrorMsg) {
                  showToast(uploadErrorMsg, "err");
                } else {
                  showToast("Project created.", "ok");
                }
              } catch (e) {
                const msg = formatUserError(e, "Failed to create project.");
                state.formError = msg;
                showToast(msg, "err");
              } finally {
                state.saving = false;
                draw();
              }
            },
            state.saving
          )
        );
        formPanel.append(act);
      }
      container.append(formPanel);
    }

    const projects = state.filterClientId
      ? snap.projects.filter((p) => p.clientId === state.filterClientId)
      : snap.projects;

    if (projects.length === 0) {
      const empty = el("section", "panel");
      empty.append(el("div", "empty", "No projects yet. Create a project or launch one from an approved Script."));
      container.append(empty);
      return;
    }

    const stack = el("div", "stack");
    for (const proj of projects) {
      const cli = snap.clients.find((c) => c.clientId === proj.clientId);
      const linkedIdea = proj.ideaId
        ? snap.ideas.find((i) => i.ideaId === proj.ideaId)
        : undefined;
      const linkedScr = proj.scriptId
        ? snap.scripts.find((s) => s.scriptId === proj.scriptId)
        : undefined;
      const srcAsset = proj.sourceAssetId
        ? snap.assets.find((a) => a.assetId === proj.sourceAssetId)
        : undefined;
      const refAsset = proj.referenceAssetId
        ? snap.assets.find((a) => a.assetId === proj.referenceAssetId)
        : undefined;

      const card = el("section", "panel");
      if (state.highlightedProjectId && state.highlightedProjectId === proj.projectId) {
        card.style.borderColor = "rgba(180,162,255,.55)";
      }
      const ch = el("div", "panelhead");
      const tl = el("div");
      tl.append(
        el("h2", "", proj.title),
        el(
          "div",
          "small muted",
          `${cli?.name || proj.clientId} · ${proj.targetAspectRatio}${proj.targetDurationS ? ` · ${proj.targetDurationS}s` : ""}${proj.deadline ? ` · Due ${proj.deadline}` : ""} · Latest v${proj.latestVersionNumber}`
        )
      );
      const tr = el("div", "row-actions");
      tr.append(badge(proj.status, projectTone(proj.status)));
      const stSel = selectField(
        "Stage",
        proj.status || "Draft",
        ALL_PROJECT_STATUSES.map((st): [string, string] => [st, st]),
        async (nextStatus) => {
          try {
            await updateProjectFields(proj.projectId, { status: nextStatus });
            await ctx.refreshSnapshot();
            showToast(`Project moved to "${nextStatus}".`, "ok");
            draw();
          } catch (e) {
            showToast(formatUserError(e, "Failed to update project stage."), "err");
            draw();
          }
        }
      );
      stSel.wrap.style.minWidth = "175px";
      tr.append(stSel.wrap);
      ch.append(tl, tr);
      card.append(ch);

      const hookText = proj.captionPreferences?.hook || linkedScr?.hook || "";
      const captionPreview = proj.captionPreferences?.caption_text || linkedScr?.captionText || "";
      const linkSummary = [
        linkedScr ? `Script: ${linkedScr.title}` : "",
        linkedIdea ? `Idea: ${linkedIdea.title}` : "",
        proj.captionPreferences?.brand_tone ? `Tone: ${proj.captionPreferences.brand_tone}` : "",
      ].filter(Boolean);
      if (linkSummary.length > 0) {
        card.append(el("div", "small muted", linkSummary.join(" · ")));
      }
      if (hookText) {
        card.append(el("div", "small", `Hook: ${hookText}`));
      }
      if (captionPreview) {
        card.append(el("div", "small muted", `Captions: ${captionPreview.slice(0, 180)}`));
      }

      const assetGrid = el("div", "crm-two-col");

      // Raw Source Footage box
      const srcBox = el("div", "subpanel");
      srcBox.append(el("h3", "", "Raw Source Footage"));
      if (srcAsset) {
        const stInfo = state.assetStatusMap.get(srcAsset.assetId);
        srcBox.append(
          el(
            "div",
            "small",
            `${srcAsset.filename} (${srcAsset.width}×${srcAsset.height} · ${srcAsset.durationS?.toFixed(1) || "?"}s · ${formatBytes(srcAsset.sizeBytes)})`
          ),
          el(
            "div",
            "small muted",
            stInfo
              ? stInfo.message
              : `Storage: ${srcAsset.storageProvider} · Expires: ${formatIsoShort(srcAsset.expiresAt)}`
          )
        );
        if (stInfo && !stInfo.available) {
          srcBox.append(
            el(
              "div",
              "notice",
              "Temporary footage expired on server. Re-upload footage below — your saved editing instructions are preserved."
            )
          );
        }
      } else {
        srcBox.append(el("div", "small muted", "No source footage uploaded yet."));
      }
      const srcInp = document.createElement("input");
      srcInp.type = "file";
      srcInp.accept = ".mp4,.mov,video/mp4,video/quicktime";
      srcInp.hidden = true;
      srcInp.onchange = async () => {
        const f = srcInp.files?.[0];
        if (!f) return;
        try {
          await uploadProjectAsset(proj, "source", f);
        } catch (e) {
          showToast(formatUserError(e, "Upload failed."), "err");
        }
      };
      const srcBtns = el("div", "row-actions");
      srcBtns.style.marginTop = "8px";
      srcBtns.append(
        srcInp,
        btn(srcAsset ? "Upload Replacement / Extra Clip" : "Upload Raw Footage", "btn", () =>
          srcInp.click()
        )
      );
      if (srcAsset) {
        srcBtns.append(
          btn("Verify Server File", "mini", () => void checkAssetStatus(proj.projectId, srcAsset.assetId))
        );
      }
      srcBox.append(srcBtns);

      // Reference Video box
      const refBox = el("div", "subpanel");
      refBox.append(el("h3", "", "Reference Video Analysis"));
      if (refAsset && proj.referenceMetrics) {
        const rm = proj.referenceMetrics;
        const sceneCuts = Array.isArray(rm.scene_cuts_s) ? rm.scene_cuts_s : [];
        const hasMeanVol = typeof rm.mean_volume_db === "number";
        refBox.append(
          el("div", "small", `${refAsset.filename} · ${rm.width ?? 0}×${rm.height ?? 0} (${rm.aspect_ratio || "9:16"})`),
          el(
            "div",
            "small muted",
            `Duration: ${rm.duration_s ?? 0}s · Audio: ${hasMeanVol ? `${rm.mean_volume_db} dB avg` : "Silent"} · Scene cuts: ${sceneCuts.length} (${rm.recommended_intro_end_s ? `intro end ~${rm.recommended_intro_end_s}s` : "none detected"})`
          )
        );
        const applyBtn = btn("Apply Reference Settings", "mini", async () => {
          try {
            const curIns: StudioInstructions = proj.editingInstructions || {
              schema_version: "1.0",
              resolution_preset: "export_1080p",
              operations: [],
            };
            const nextOps = [...(Array.isArray(curIns.operations) ? curIns.operations : [])];
            const refIdx = nextOps.findIndex((o) => o.op === "reframe");
            if (refIdx >= 0) nextOps[refIdx].aspect = rm.aspect_ratio || "9:16";
            else nextOps.unshift({ op: "reframe", aspect: rm.aspect_ratio || "9:16", mode: "crop" });
            if (rm.recommended_intro_end_s && rm.recommended_intro_end_s > 2) {
              nextOps.unshift({
                op: "shorten_segment",
                segment: "intro",
                target_duration_s: 2,
                segment_end_s: rm.recommended_intro_end_s,
                detect: "scene_change",
              });
            }
            await updateProjectFields(proj.projectId, {
              targetAspectRatio: rm.aspect_ratio || "9:16",
              editingInstructions: { ...curIns, operations: nextOps },
            });
            await ctx.refreshSnapshot();
            showToast("Applied reference aspect ratio & intro boundary.", "ok");
            draw();
          } catch (e) {
            showToast(formatUserError(e, "Failed to apply reference settings."), "err");
          }
        });
        refBox.append(applyBtn);
      } else {
        refBox.append(
          el("div", "small muted", "Upload a reference reel to extract measurable aspect ratio, loudness, and cut timestamps.")
        );
      }
      const refInp = document.createElement("input");
      refInp.type = "file";
      refInp.accept = ".mp4,.mov,video/mp4,video/quicktime";
      refInp.hidden = true;
      refInp.onchange = async () => {
        const f = refInp.files?.[0];
        if (!f) return;
        try {
          await uploadProjectAsset(proj, "reference", f);
        } catch (e) {
          showToast(formatUserError(e, "Reference analysis failed."), "err");
        }
      };
      const refBtns = el("div", "row-actions");
      refBtns.style.marginTop = "8px";
      refBtns.append(refInp, btn(refAsset ? "Replace Reference" : "Upload Reference Video", "btn", () => refInp.click()));
      refBox.append(refBtns);

      assetGrid.append(srcBox, refBox);
      card.append(assetGrid);

      const act = el("div", "actions");
      act.append(
        btn(
          "⚡ Generate First Cut",
          "btn primary",
          () => ctx.openProjectInStudio(proj, true),
          !proj.sourceAssetId
        ),
        btn("Open in Video Studio", "btn", () => ctx.openProjectInStudio(proj, false)),
        btn(
          "Client Review →",
          "btn",
          () => ctx.openProjectInReview(proj.projectId),
          proj.latestVersionNumber === 0
        )
      );
      card.append(act);
      stack.append(card);
    }
    container.append(stack);
  };

  draw();
}
