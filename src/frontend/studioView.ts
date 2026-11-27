import {
  createVideoVersionRecord,
  finalizeVideoVersionRender,
  updateProjectFields,
  upsertRenderJobRecord,
} from "./crmDb.js";
import { AppContext } from "./context.js";
import {
  btn,
  el,
  formatUserError,
  inputField,
  selectField,
  showToast,
  statusTone,
} from "./dom.js";
import {
  AspectRatio,
  ProjectRecord,
  ReframeMode,
  ResolutionPreset,
  StudioInstructions,
  StudioOperation,
} from "./types.js";
import { PreviewLayoutPayload, createManagedVideoPlayer } from "./videoPlayer.js";

const OP_LABELS: Record<string, string> = {
  reframe: "Reframe & Aspect Ratio",
  cut_range: "Cut range",
  trim_range: "Trim start / end",
  shorten_segment: "Shorten intro / outro",
  speed: "Playback speed",
  audio_adjust: "Audio level / mute",
  fade: "Video & audio fade",
  merge_clips: "Merge project clips",
  overlay_text: "Text overlay",
  captions: "Captions / SRT",
};

const DEFAULT_OP = (opName: string): StudioOperation => {
  switch (opName) {
    case "reframe":
      return { op: "reframe", aspect: "9:16", mode: "crop", crop_x: 0.5, crop_y: 0.5 };
    case "cut_range":
      return { op: "cut_range", start: 0, end: 1 };
    case "trim_range":
      return { op: "trim_range", start: 0, end: 10 };
    case "shorten_segment":
      return { op: "shorten_segment", segment: "intro", target_duration_s: 2, detect: "scene_change", scene_threshold: 0.4 };
    case "speed":
      return { op: "speed", factor: 1.25 };
    case "audio_adjust":
      return { op: "audio_adjust", volume: 1.0, mute: false };
    case "fade":
      return { op: "fade", fade_in_s: 0.5, fade_out_s: 0.5 };
    case "merge_clips":
      return { op: "merge_clips", asset_ids: [] };
    case "overlay_text":
      return {
        op: "overlay_text",
        text: "Hook headline here",
        at: 0,
        duration: 2.5,
        style: "bold-yellow",
        max_words_per_line: 4,
        font_family: "sans",
        font_weight: "bold",
        font_size_scale: 1,
        position_preset: "auto",
      };
    case "captions":
    default:
      return {
        op: "captions",
        source: "manual",
        style: "bold-yellow",
        max_words_per_line: 4,
        font_family: "sans",
        font_weight: "bold",
        font_size_scale: 1,
        position_preset: "bottom",
        segments: [{ start: 0, end: 2, text: "First caption line" }],
      };
  }
};

export interface StudioController {
  mount(container: HTMLElement): void;
  loadProject(project: ProjectRecord, autoRender?: boolean): Promise<void>;
  loadExistingJob(jobId: string): void;
}

export function createStudioController(ctx: AppContext): StudioController {
  let ops: StudioOperation[] = [];
  let resolutionPreset: ResolutionPreset = "export_1080p";
  let boundProjectId = "";
  let localFile: File | null = null;
  let localObjectUrl = "";
  let sourceStreamUrl = "";
  let outputStreamUrl = "";
  let activeJobId = "";
  let activeVersionId = "";
  let jobStatus = "";
  let jobProgress = 0;
  let jobMessage = "Choose a video or select a CRM Project with uploaded footage.";
  let jobError = "";
  let formError = "";
  let busy = false;
  let previewMode: "source" | "output" = "source";
  let showSafeZone = true;
  let previewLayout: PreviewLayoutPayload | null = null;
  let pollTimer: number | null = null;
  let pollEpoch = 0;
  let previewTimer: number | null = null;
  let previewEpoch = 0;
  let recentJobs: Array<{ job_id: string; status: string; progress: number; duration_s: number | null; project_id?: string | null }> = [];

  let hostEl: HTMLElement | null = null;
  const player = createManagedVideoPlayer({
    emptyTitle: "No video selected",
    emptySub: "Upload a local clip or pick a Project with uploaded footage.",
    maxPortraitWidth: 400,
    onStreamError: () => {
      if (previewMode === "output" && activeJobId && jobStatus === "completed") {
        player.setStatusOverlay(true, false, "Unable to play rendered stream.", () => {
          void loadCompletedOutput(pollEpoch, true);
        });
      }
    },
  });

  const stopPolling = () => {
    pollEpoch++;
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const buildInstructions = (): StudioInstructions => {
    const cleanedOps = ops.map((o) => {
      const copy = { ...o } as Record<string, unknown>;
      if (copy.op === "shorten_segment") {
        if (copy.keep === "" || copy.keep === null) delete copy.keep;
        if (copy.segment === "intro") delete copy.segment_start_s;
        if (copy.segment === "outro") delete copy.segment_end_s;
        if (copy.segment_end_s === "" || copy.segment_end_s === null) delete copy.segment_end_s;
        if (copy.segment_start_s === "" || copy.segment_start_s === null) delete copy.segment_start_s;
      }
      if (copy.op === "overlay_text" || copy.op === "captions") {
        if (copy.text_color === "") delete copy.text_color;
        if (copy.bg_color === "") delete copy.bg_color;
        if (copy.position_preset !== "custom") {
          delete copy.x_pct;
          delete copy.y_pct;
        }
      }
      return copy as StudioOperation;
    });
    return {
      schema_version: "1.0",
      resolution_preset: resolutionPreset,
      operations: cleanedOps,
    };
  };

  const schedulePreviewLayout = () => {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      void fetchPreviewLayout();
    }, 100);
  };

  const fetchPreviewLayout = async () => {
    if (!ctx.isConnected()) return;
    const ep = ++previewEpoch;
    const proj = ctx.getSnapshot().projects.find((p) => p.projectId === boundProjectId);
    const srcAsset = proj?.sourceAssetId
      ? ctx.getSnapshot().assets.find((a) => a.assetId === proj.sourceAssetId)
      : undefined;
    const w = srcAsset?.width || 1080;
    const h = srcAsset?.height || 1920;

    try {
      const r = await ctx.apiFetch("/v1/preview-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          width: w,
          height: h,
          resolution_preset: resolutionPreset,
          operations: buildInstructions().operations,
        }),
      });
      const data = (await r.json()) as PreviewLayoutPayload;
      if (ep !== previewEpoch) return;
      previewLayout = data;
      const reframeOp = ops.find((o) => o.op === "reframe");
      const cropMode = reframeOp && reframeOp.mode !== "pad" && reframeOp.mode !== "blur";
      player.setLayoutData(previewLayout, showSafeZone, Boolean(cropMode));
    } catch {
      // ignore transient layout errors while typing
    }
  };

  const refreshRecentJobs = async () => {
    if (!ctx.isConnected()) return;
    try {
      const r = await ctx.apiFetch("/v1/render-jobs");
      const d = (await r.json()) as { jobs?: typeof recentJobs };
      recentJobs = Array.isArray(d.jobs) ? d.jobs : [];
      if (hostEl) renderIntoHost();
    } catch {
      // ignore
    }
  };

  const loadCompletedOutput = async (epoch: number, autoplay = false) => {
    if (!activeJobId) return;
    player.setStatusOverlay(true, true, "Loading rendered video…");
    try {
      const streamUrl = await ctx.streamJobOutputUrl(activeJobId);
      if (epoch !== pollEpoch) return;
      outputStreamUrl = streamUrl;
      previewMode = "output";
      player.setStreamUrl(streamUrl, { autoplay });
      player.setStatusOverlay(false, false, "");
      if (hostEl) renderIntoHost();
    } catch (e) {
      const msg = formatUserError(e, "Could not load rendered output.");
      player.setStatusOverlay(true, false, msg, () => void loadCompletedOutput(epoch, true));
    }
  };

  const pollJob = async (epoch: number) => {
    if (!activeJobId || epoch !== pollEpoch || !ctx.isConnected()) return;
    try {
      const r = await ctx.apiFetch(`/v1/render-jobs/${activeJobId}`);
      const j = (await r.json()) as {
        status: "queued" | "rendering" | "completed" | "failed";
        progress: number;
        error?: string | null;
        duration_s?: number | null;
        output_available?: boolean;
      };
      if (epoch !== pollEpoch) return;
      jobStatus = j.status;
      jobProgress = j.progress ?? 0;
      jobError = j.error || "";
      busy = j.status === "queued" || j.status === "rendering";
      jobMessage =
        j.status === "completed"
          ? "Render finished. Previewing output."
          : j.status === "failed"
            ? "Rendering failed."
            : `Processing video (${jobProgress}%)…`;

      const proj = boundProjectId
        ? ctx.getSnapshot().projects.find((p) => p.projectId === boundProjectId)
        : undefined;

      await upsertRenderJobRecord({
        jobId: activeJobId,
        project: proj,
        status: j.status,
        progress: jobProgress,
        error: j.error || undefined,
        durationS: j.duration_s ?? undefined,
        resolutionPreset,
        isCreate: false,
      }).catch((fsErr) => {
        const msg = formatUserError(fsErr, "Failed to sync render job in Firestore.");
        jobError = msg;
      });

      if (!busy) {
        if (activeVersionId && boundProjectId) {
          await finalizeVideoVersionRender({
            versionId: activeVersionId,
            projectId: boundProjectId,
            completed: j.status === "completed",
            outputAvailable: Boolean(j.output_available ?? j.status === "completed"),
            durationS: j.duration_s ?? undefined,
          }).catch((fsErr) => {
            const msg = formatUserError(fsErr, "Failed to finalize version in Firestore.");
            jobError = msg;
            showToast(msg, "err");
          });
          await ctx.refreshSnapshot().catch((fsErr) => {
            showToast(formatUserError(fsErr, "Failed to refresh workspace snapshot."), "err");
          });
        }
        void refreshRecentJobs();
        if (j.status === "completed") {
          await loadCompletedOutput(epoch, false);
        }
      } else {
        pollTimer = window.setTimeout(() => void pollJob(epoch), 1600);
      }
      if (hostEl) renderIntoHost();
    } catch (err) {
      jobError = formatUserError(err, "Failed to check render status.");
      busy = false;
      if (hostEl) renderIntoHost();
    }
  };

  const validateOps = () => {
    if (ops.length === 0) throw new Error("Add at least one editing operation.");
    const boundProj = boundProjectId
      ? ctx.getSnapshot().projects.find((p) => p.projectId === boundProjectId)
      : undefined;
    if (!localFile && !boundProj?.sourceAssetId) {
      throw new Error("Select a local video file or bind a CRM Project with uploaded source footage.");
    }
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.op === "cut_range" || o.op === "trim_range") {
        if (Number(o.end) <= Number(o.start)) {
          throw new Error(`Op ${i + 1} (${o.op}): End time must exceed start time.`);
        }
      }
      if (o.op === "overlay_text" && !String(o.text || "").trim()) {
        throw new Error(`Op ${i + 1}: Text overlay cannot be empty.`);
      }
      if (o.op === "captions") {
        const segs = Array.isArray(o.segments) ? o.segments : [];
        if (segs.length === 0) throw new Error(`Op ${i + 1}: Add at least one caption segment.`);
        for (const s of segs) {
          if (!String(s.text || "").trim() || Number(s.end) <= Number(s.start)) {
            throw new Error(`Op ${i + 1}: Every caption requires non-empty text and end > start.`);
          }
        }
      }
      if (o.op === "merge_clips") {
        const ids = Array.isArray(o.asset_ids) ? o.asset_ids : [];
        if (ids.length === 0) throw new Error(`Op ${i + 1}: Choose at least one clip to merge.`);
      }
    }
  };

  const startRender = async () => {
    formError = "";
    jobError = "";
    try {
      validateOps();
      stopPolling();
      outputStreamUrl = "";
      activeVersionId = "";
      busy = true;
      jobStatus = "queued";
      jobProgress = 0;
      jobMessage = "Submitting render job…";
      if (hostEl) renderIntoHost();

      const ins = buildInstructions();
      const proj = boundProjectId
        ? ctx.getSnapshot().projects.find((p) => p.projectId === boundProjectId)
        : undefined;
      const ep = pollEpoch;

      if (proj && proj.sourceAssetId && !localFile) {
        const nextVer = (proj.latestVersionNumber || 0) + 1;
        const r = await ctx.apiFetch(`/v1/projects/${proj.projectId}/render`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_asset_id: proj.sourceAssetId,
            instructions: ins,
            version_number: nextVer,
            client_uid: proj.clientUid,
            client_email: proj.clientEmail,
          }),
        });
        const j = (await r.json()) as { job_id: string; status: "queued" };
        if (ep !== pollEpoch) return;
        activeJobId = j.job_id;
        await upsertRenderJobRecord({
          jobId: activeJobId,
          project: proj,
          versionNumber: nextVer,
          status: "queued",
          progress: 0,
          resolutionPreset,
          isCreate: true,
        });
        const reframeOp = ins.operations.find((o) => o.op === "reframe");
        activeVersionId = await createVideoVersionRecord({
          project: proj,
          versionNumber: nextVer,
          jobId: activeJobId,
          instructions: ins,
          revisionNotes: nextVer === 1 ? "First cut from Video Studio" : `Studio cut v${nextVer}`,
          aspectRatio: ((reframeOp?.aspect as AspectRatio) || proj.targetAspectRatio || "9:16"),
          resolutionPreset,
        });
        await ctx.refreshSnapshot();
      } else if (localFile) {
        const fd = new FormData();
        fd.append("video", localFile, localFile.name);
        fd.append("instructions", JSON.stringify(ins));
        if (proj) {
          const nextVer = (proj.latestVersionNumber || 0) + 1;
          fd.append("project_id", proj.projectId);
          if (proj.clientUid) fd.append("client_uid", proj.clientUid);
          if (proj.clientEmail) fd.append("client_email", proj.clientEmail);
          fd.append("version_number", String(nextVer));
        }
        const r = await ctx.apiFetch("/v1/render-jobs", { method: "POST", body: fd });
        const j = (await r.json()) as { job_id: string; version_number?: number | null };
        if (ep !== pollEpoch) return;
        activeJobId = j.job_id;
        await upsertRenderJobRecord({
          jobId: activeJobId,
          project: proj,
          versionNumber: j.version_number ?? undefined,
          status: "queued",
          progress: 0,
          resolutionPreset,
          isCreate: true,
        }).catch((fsErr) => {
          const msg = formatUserError(fsErr, "Failed to log render job to Firestore.");
          jobError = msg;
          showToast(msg, "err");
        });
        if (proj && j.version_number) {
          const reframeOp = ins.operations.find((o) => o.op === "reframe");
          activeVersionId = await createVideoVersionRecord({
            project: proj,
            versionNumber: j.version_number,
            jobId: activeJobId,
            instructions: ins,
            revisionNotes: "Uploaded & rendered in Studio",
            aspectRatio: ((reframeOp?.aspect as AspectRatio) || proj.targetAspectRatio || "9:16"),
            resolutionPreset,
          });
          await ctx.refreshSnapshot();
        }
      }

      void refreshRecentJobs();
      await pollJob(ep);
    } catch (err) {
      busy = false;
      jobStatus = "failed";
      formError = formatUserError(err, "Failed to start render.");
      jobMessage = "Render submission failed.";
      if (hostEl) renderIntoHost();
    }
  };

  const renderTextStyleControls = (op: StudioOperation, onMutate: () => void): HTMLDivElement => {
    const grid = el("div", "fields");
    grid.style.marginTop = "10px";

    grid.append(
      selectField(
        "Style preset",
        String(op.style || "bold-yellow"),
        [
          ["bold-yellow", "Bold Yellow"],
          ["white-box", "White on Dark Box"],
          ["plain", "Clean White"],
        ],
        (v) => {
          op.style = v;
          onMutate();
        }
      ).wrap,
      selectField(
        "Font family",
        String(op.font_family || "sans"),
        [
          ["sans", "DejaVu Sans"],
          ["serif", "DejaVu Serif"],
          ["mono", "DejaVu Mono"],
        ],
        (v) => {
          op.font_family = v;
          onMutate();
        }
      ).wrap,
      selectField(
        "Font weight",
        String(op.font_weight || "bold"),
        [
          ["bold", "Bold"],
          ["regular", "Regular"],
        ],
        (v) => {
          op.font_weight = v;
          onMutate();
        }
      ).wrap,
      inputField(
        "Font size scale (0.5–2.0)",
        String(op.font_size_scale ?? 1),
        (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) op.font_size_scale = Math.max(0.5, Math.min(2, n));
          schedulePreviewLayout();
        },
        { type: "number", min: "0.5", max: "2", step: "0.05" }
      ).wrap,
      inputField(
        "Words per line",
        String(op.max_words_per_line ?? 4),
        (v) => {
          const n = parseInt(v, 10);
          if (Number.isInteger(n)) op.max_words_per_line = Math.max(1, Math.min(12, n));
          schedulePreviewLayout();
        },
        { type: "number", min: "1", max: "12", step: "1" }
      ).wrap,
      selectField(
        "Placement",
        String(op.position_preset || "auto"),
        [
          ["auto", "Auto safe zone"],
          ["top", "Top"],
          ["middle", "Middle"],
          ["bottom", "Bottom"],
          ["custom", "Custom X/Y %"],
        ],
        (v) => {
          op.position_preset = v;
          if (v === "custom") {
            op.x_pct = typeof op.x_pct === "number" ? op.x_pct : 0.5;
            op.y_pct = typeof op.y_pct === "number" ? op.y_pct : 0.72;
          }
          onMutate();
        }
      ).wrap,
      selectField(
        "Alignment",
        String(op.align || "center"),
        [
          ["center", "Center"],
          ["left", "Left"],
          ["right", "Right"],
        ],
        (v) => {
          op.align = v;
          onMutate();
        }
      ).wrap,
      inputField(
        "Text color (hex or name)",
        String(op.text_color || ""),
        (v) => {
          op.text_color = v.trim();
          schedulePreviewLayout();
        },
        { placeholder: "#FFFFFF or yellow" }
      ).wrap,
      inputField(
        "Box opacity (0–1)",
        op.bg_opacity !== undefined ? String(op.bg_opacity) : "",
        (v) => {
          op.bg_opacity = v === "" ? undefined : Math.max(0, Math.min(1, Number(v)));
          schedulePreviewLayout();
        },
        { type: "number", min: "0", max: "1", step: "0.1", placeholder: "Default" }
      ).wrap,
      inputField(
        "Line spacing (1.0–2.0)",
        op.line_spacing !== undefined ? String(op.line_spacing) : "1.32",
        (v) => {
          const n = Number(v);
          if (Number.isFinite(n)) op.line_spacing = Math.max(1, Math.min(2, n));
          schedulePreviewLayout();
        },
        { type: "number", min: "1", max: "2", step: "0.05" }
      ).wrap
    );

    if (op.position_preset === "custom") {
      grid.append(
        inputField(
          "Horizontal X (0.05–0.95)",
          String(op.x_pct ?? 0.5),
          (v) => {
            op.x_pct = Math.max(0.05, Math.min(0.95, Number(v) || 0.5));
            schedulePreviewLayout();
          },
          { type: "number", min: "0.05", max: "0.95", step: "0.02" }
        ).wrap,
        inputField(
          "Vertical Y (0.08–0.92)",
          String(op.y_pct ?? 0.72),
          (v) => {
            op.y_pct = Math.max(0.08, Math.min(0.92, Number(v) || 0.72));
            schedulePreviewLayout();
          },
          { type: "number", min: "0.08", max: "0.92", step: "0.02" }
        ).wrap
      );
    }

    return grid;
  };

  const renderIntoHost = () => {
    if (!hostEl) return;
    hostEl.replaceChildren();
    const snap = ctx.getSnapshot();
    const boundProj = snap.projects.find((p) => p.projectId === boundProjectId);
    const projectAssets = boundProj
      ? snap.assets.filter((a) => a.projectId === boundProj.projectId)
      : [];

    // Header
    const head = el("div", "view-header");
    const leftH = el("div");
    leftH.append(
      el("div", "eyebrow", "Video Studio"),
      el("h1", "", boundProj ? `Editing: ${boundProj.title}` : "FFmpeg Render Studio"),
      el(
        "div",
        "muted",
        boundProj
          ? `Project status: ${boundProj.status} · Latest v${boundProj.latestVersionNumber} · Multi-aspect & precision typography`
          : "Upload, reframe (9:16 / 16:9 / 1:1 / 4:5), trim, style captions, and render MP4 exports."
      )
    );
    const rightH = el("div", "row-actions");
    const resSel = selectField(
      "Output Quality",
      resolutionPreset,
      [
        ["export_1080p", "1080p Final Export"],
        ["preview_720p", "720p Fast Preview"],
      ],
      (v) => {
        resolutionPreset = v === "preview_720p" ? "preview_720p" : "export_1080p";
        schedulePreviewLayout();
      }
    );
    resSel.wrap.style.minWidth = "190px";
    rightH.append(resSel.wrap);
    head.append(leftH, rightH);
    hostEl.append(head);

    const layout = el("div", "studio-grid");
    const leftCol = el("div", "stack");
    const rightCol = el("div", "stack");

    // Panel 01: Project & Source Selection
    const srcPanel = el("section", "panel");
    srcPanel.append(
      (() => {
        const ph = el("div", "panelhead");
        const h2 = el("h2");
        h2.append(el("span", "num", "01"), "Source Footage & Project Binding");
        ph.append(h2, el("span", "small muted", "MP4 / MOV"));
        return ph;
      })()
    );

    const projOpts: Array<[string, string]> = [
      ["", "Standalone Ad-hoc Render (No Project)"],
      ...snap.projects.map((p): [string, string] => [
        p.projectId,
        `${p.title} (${p.status}${p.sourceAssetId ? " · Footage Ready" : " · No Footage"})`,
      ]),
    ];
    const projSel = selectField(
      "Bind to CRM Project (optional)",
      boundProjectId,
      projOpts,
      (pid) => {
        if (!pid) {
          boundProjectId = "";
          renderIntoHost();
          return;
        }
        const p = snap.projects.find((x) => x.projectId === pid);
        if (p) void loadProject(p, false);
      },
      { wide: true }
    );
    srcPanel.append(projSel.wrap);

    if (boundProj) {
      const projBar = el("div", "inline-info");
      projBar.append(
        el(
          "span",
          "small muted",
          boundProj.sourceAssetId
            ? `Linked Server Footage: ${boundProj.sourceAssetId}`
            : "No server footage uploaded yet for this project — drop a local file below or upload in Content Projects."
        ),
        btn("Save Instructions to Project", "mini", async () => {
          try {
            await updateProjectFields(boundProj.projectId, {
              editingInstructions: buildInstructions(),
            });
            await ctx.refreshSnapshot();
            showToast("Editing instructions saved to project.", "ok");
          } catch (e) {
            showToast(formatUserError(e, "Save failed."), "err");
          }
        })
      );
      srcPanel.append(projBar);
    }

    const fileInp = document.createElement("input");
    fileInp.type = "file";
    fileInp.accept = ".mp4,.mov,video/mp4,video/quicktime";
    fileInp.hidden = true;
    const drop = el("div", "drop");
    drop.style.marginTop = "12px";
    drop.tabIndex = 0;
    const dropInner = el("div");
    dropInner.append(
      el("strong", "", localFile ? `Selected: ${localFile.name}` : "Drop local MP4 or MOV here"),
      el(
        "p",
        "muted small",
        localFile
          ? `${(localFile.size / 1048576).toFixed(1)} MB · click to replace`
          : "or click to browse (optional when Project footage is already uploaded)"
      )
    );
    drop.append(dropInner);
    const selectLocalFile = (f: File | undefined) => {
      if (!f) return;
      if (!/\.(mp4|mov)$/i.test(f.name)) {
        formError = "Choose an MP4 or MOV file.";
        renderIntoHost();
        return;
      }
      if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
      localFile = f;
      localObjectUrl = URL.createObjectURL(f);
      previewMode = "source";
      player.setLocalSourceUrl(localObjectUrl);
      schedulePreviewLayout();
      renderIntoHost();
    };
    fileInp.onchange = () => selectLocalFile(fileInp.files?.[0]);
    drop.onclick = () => fileInp.click();
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    };
    drop.ondragleave = () => drop.classList.remove("drag");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      selectLocalFile(e.dataTransfer?.files?.[0]);
    };
    srcPanel.append(fileInp, drop);

    if (localFile) {
      const fi = el("div", "fileinfo");
      fi.append(
        el("span", "small", `${localFile.name} · ${(localFile.size / 1048576).toFixed(1)} MB`),
        btn("Clear local file", "mini", () => {
          if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
          localFile = null;
          localObjectUrl = "";
          if (sourceStreamUrl) player.setStreamUrl(sourceStreamUrl, { showTextOverlay: true });
          else player.setLocalSourceUrl(null);
          renderIntoHost();
        })
      );
      srcPanel.append(fi);
    }

    // Panel 02: Operations
    const opsPanel = el("section", "panel");
    const opsHead = el("div", "panelhead");
    const opsTitle = el("h2");
    opsTitle.append(el("span", "num", "02"), "Editing Pipeline");
    opsHead.append(opsTitle, el("span", "small muted", `${ops.length} / 20`));
    opsPanel.append(opsHead);

    const addBar = el("div", "opbuttons");
    const addButtons: Array<[string, string]> = [
      ["reframe", "+ Reframe"],
      ["cut_range", "+ Cut range"],
      ["trim_range", "+ Trim start/end"],
      ["shorten_segment", "+ Shorten intro/outro"],
      ["speed", "+ Speed"],
      ["audio_adjust", "+ Audio"],
      ["fade", "+ Fade"],
      ["merge_clips", "+ Merge clips"],
      ["overlay_text", "+ Text overlay"],
      ["captions", "+ Captions / SRT"],
    ];
    for (const [k, label] of addButtons) {
      addBar.append(
        btn(
          label,
          "btn",
          () => {
            if (ops.length < 20) {
              ops.push(DEFAULT_OP(k));
              schedulePreviewLayout();
              renderIntoHost();
            }
          },
          ops.length >= 20
        )
      );
    }
    opsPanel.append(addBar);

    if (ops.length === 0) {
      opsPanel.append(el("div", "empty small", "Add editing operations above to build your cut."));
    }

    ops.forEach((op, idx) => {
      const card = el("div", "op");
      const ch = el("div", "ophead");
      ch.append(el("h3", "", `${idx + 1}. ${OP_LABELS[op.op] || op.op}`));
      const tools = el("div", "optools");
      tools.append(
        btn(
          "↑",
          "mini",
          () => {
            [ops[idx - 1], ops[idx]] = [ops[idx], ops[idx - 1]];
            schedulePreviewLayout();
            renderIntoHost();
          },
          idx === 0
        ),
        btn(
          "↓",
          "mini",
          () => {
            [ops[idx + 1], ops[idx]] = [ops[idx], ops[idx + 1]];
            schedulePreviewLayout();
            renderIntoHost();
          },
          idx === ops.length - 1
        ),
        btn("Remove", "mini", () => {
          ops.splice(idx, 1);
          schedulePreviewLayout();
          renderIntoHost();
        })
      );
      ch.append(tools);
      card.append(ch);

      const fields = el("div", "fields");
      if (op.op === "reframe") {
        fields.append(
          selectField(
            "Target Aspect Ratio",
            String(op.aspect || "9:16"),
            [
              ["9:16", "9:16 Vertical Reels / TikTok"],
              ["4:5", "4:5 Social Feed"],
              ["1:1", "1:1 Square"],
              ["16:9", "16:9 Landscape"],
            ],
            (v) => {
              op.aspect = v as AspectRatio;
              schedulePreviewLayout();
              renderIntoHost();
            }
          ).wrap,
          selectField(
            "Reframe Mode",
            String(op.mode || "crop"),
            [
              ["crop", "Auto Center Crop"],
              ["manual_crop", "Manual Crop Position (X / Y)"],
              ["blur", "Blurred Background Fill"],
              ["pad", "Letterbox / Black Padding"],
            ],
            (v) => {
              op.mode = v as ReframeMode;
              schedulePreviewLayout();
              renderIntoHost();
            }
          ).wrap
        );
        if (op.mode === "manual_crop") {
          fields.append(
            inputField(
              "Crop X Position (0 = left, 0.5 = center, 1 = right)",
              String(op.crop_x ?? 0.5),
              (v) => {
                op.crop_x = Math.max(0, Math.min(1, Number(v) || 0.5));
                schedulePreviewLayout();
              },
              { type: "number", min: "0", max: "1", step: "0.05" }
            ).wrap,
            inputField(
              "Crop Y Position (0 = top, 0.5 = center, 1 = bottom)",
              String(op.crop_y ?? 0.5),
              (v) => {
                op.crop_y = Math.max(0, Math.min(1, Number(v) || 0.5));
                schedulePreviewLayout();
              },
              { type: "number", min: "0", max: "1", step: "0.05" }
            ).wrap
          );
        }
      } else if (op.op === "cut_range" || op.op === "trim_range") {
        fields.append(
          inputField(
            op.op === "cut_range" ? "Cut Start (s)" : "Keep From (s)",
            String(op.start ?? 0),
            (v) => {
              op.start = Number(v) || 0;
            },
            { type: "number", min: "0", step: "0.1" }
          ).wrap,
          inputField(
            op.op === "cut_range" ? "Cut End (s)" : "Keep Until (s)",
            String(op.end ?? 2),
            (v) => {
              op.end = Number(v) || 0;
            },
            { type: "number", min: "0.1", step: "0.1" }
          ).wrap
        );
      } else if (op.op === "shorten_segment") {
        fields.append(
          selectField(
            "Segment",
            String(op.segment || "intro"),
            [
              ["intro", "Intro"],
              ["outro", "Outro"],
            ],
            (v) => {
              op.segment = v;
              renderIntoHost();
            }
          ).wrap,
          inputField(
            "Target Duration (s)",
            String(op.target_duration_s ?? 2),
            (v) => {
              op.target_duration_s = Math.max(0.1, Number(v) || 2);
            },
            { type: "number", min: "0.1", step: "0.1" }
          ).wrap,
          inputField(
            op.segment === "outro" ? "Outro starts at (s, optional)" : "Intro ends at (s, optional)",
            String(
              op.segment === "outro" ? op.segment_start_s ?? "" : op.segment_end_s ?? ""
            ),
            (v) => {
              const key = op.segment === "outro" ? "segment_start_s" : "segment_end_s";
              op[key] = v === "" ? undefined : Number(v);
            },
            { type: "number", min: "0", step: "0.1", placeholder: "Auto scene detect" }
          ).wrap,
          selectField(
            "Keep Portion",
            String(op.keep || ""),
            [
              ["", "Default"],
              ["first", "First part"],
              ["last", "Last part"],
            ],
            (v) => {
              op.keep = v;
            }
          ).wrap
        );
      } else if (op.op === "speed") {
        fields.append(
          inputField(
            "Speed Factor (0.25x – 4.0x)",
            String(op.factor ?? 1.25),
            (v) => {
              op.factor = Math.max(0.25, Math.min(4, Number(v) || 1));
            },
            { type: "number", min: "0.25", max: "4", step: "0.05", wide: true }
          ).wrap
        );
      } else if (op.op === "audio_adjust") {
        fields.append(
          inputField(
            "Volume Multiplier (0 = mute, 1 = 100%, 3 = 300%)",
            String(op.volume ?? 1),
            (v) => {
              op.volume = Math.max(0, Math.min(3, Number(v) || 0));
            },
            { type: "number", min: "0", max: "3", step: "0.05" }
          ).wrap,
          selectField(
            "Mute Audio",
            op.mute ? "true" : "false",
            [
              ["false", "Keep Audio"],
              ["true", "Mute Audio"],
            ],
            (v) => {
              op.mute = v === "true";
            }
          ).wrap
        );
      } else if (op.op === "fade") {
        fields.append(
          inputField(
            "Fade In (s)",
            String(op.fade_in_s ?? 0.5),
            (v) => {
              op.fade_in_s = Math.max(0, Math.min(10, Number(v) || 0));
            },
            { type: "number", min: "0", max: "10", step: "0.1" }
          ).wrap,
          inputField(
            "Fade Out (s)",
            String(op.fade_out_s ?? 0.5),
            (v) => {
              op.fade_out_s = Math.max(0, Math.min(10, Number(v) || 0));
            },
            { type: "number", min: "0", max: "10", step: "0.1" }
          ).wrap
        );
      } else if (op.op === "merge_clips") {
        const assetIds = Array.isArray(op.asset_ids) ? (op.asset_ids as string[]) : [];
        const candidates = projectAssets.filter((a) => a.assetId !== boundProj?.sourceAssetId);
        const listWrap = el("div", "wide");
        if (candidates.length === 0) {
          listWrap.append(
            el(
              "div",
              "small muted",
              "Upload additional clips in the Content Projects view to merge them after the primary source video."
            )
          );
        } else {
          for (const asset of candidates) {
            const checked = assetIds.includes(asset.assetId);
            const row = el("label", "check-row");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = checked;
            cb.onchange = () => {
              const cur = new Set(assetIds);
              if (cb.checked) cur.add(asset.assetId);
              else cur.delete(asset.assetId);
              op.asset_ids = Array.from(cur);
              renderIntoHost();
            };
            row.append(cb, el("span", "small", `${asset.filename} (${asset.durationS?.toFixed(1) || "?"}s)`));
            listWrap.append(row);
          }
        }
        fields.append(listWrap);
      } else if (op.op === "overlay_text") {
        fields.append(
          inputField(
            "Overlay Text",
            String(op.text || ""),
            (v) => {
              op.text = v.slice(0, 200);
              schedulePreviewLayout();
            },
            { wide: true }
          ).wrap,
          inputField(
            "Start at (s)",
            String(op.at ?? 0),
            (v) => {
              op.at = Math.max(0, Number(v) || 0);
              schedulePreviewLayout();
            },
            { type: "number", min: "0", step: "0.1" }
          ).wrap,
          inputField(
            "Duration (s)",
            String(op.duration ?? 2),
            (v) => {
              op.duration = Math.max(0.1, Number(v) || 1);
              schedulePreviewLayout();
            },
            { type: "number", min: "0.1", max: "60", step: "0.1" }
          ).wrap
        );
      } else if (op.op === "captions") {
        const segs = Array.isArray(op.segments)
          ? (op.segments as Array<{ start: number; end: number; text: string }>)
          : [];
        const srtInp = document.createElement("input");
        srtInp.type = "file";
        srtInp.accept = ".srt,text/plain";
        srtInp.hidden = true;
        srtInp.onchange = async () => {
          const file = srtInp.files?.[0];
          if (!file) return;
          try {
            const srtText = await file.text();
            const res = await ctx.apiFetch("/v1/captions/parse-srt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ srt: srtText }),
            });
            const data = (await res.json()) as {
              segments?: Array<{ start: number; end: number; text: string }>;
            };
            const parsedSegs = Array.isArray(data.segments) ? data.segments : [];
            op.segments = parsedSegs;
            showToast(`Imported ${parsedSegs.length} SRT caption segments.`, "ok");
            schedulePreviewLayout();
            renderIntoHost();
          } catch (err) {
            showToast(formatUserError(err, "Failed to parse SRT."), "err");
          }
        };

        const srtBar = el("div", "wide row-actions");
        srtBar.append(
          srtInp,
          btn("Import .SRT Subtitle File", "mini", () => srtInp.click()),
          btn("+ Add Caption Segment", "mini", () => {
            const lastEnd = segs.length > 0 ? segs[segs.length - 1].end : 0;
            segs.push({ start: lastEnd, end: lastEnd + 2, text: "" });
            op.segments = segs;
            renderIntoHost();
          })
        );
        fields.append(srtBar);

        const segList = el("div", "wide");
        segs.forEach((seg, sIdx) => {
          const row = el("div", "captionline");
          row.append(
            inputField(
              "Start (s)",
              String(seg.start),
              (v) => {
                seg.start = Math.max(0, Number(v) || 0);
                schedulePreviewLayout();
              },
              { type: "number", min: "0", step: "0.1" }
            ).wrap,
            inputField(
              "End (s)",
              String(seg.end),
              (v) => {
                seg.end = Math.max(0.1, Number(v) || 0.1);
                schedulePreviewLayout();
              },
              { type: "number", min: "0.1", step: "0.1" }
            ).wrap,
            inputField(
              "Caption text",
              seg.text,
              (v) => {
                seg.text = v.slice(0, 200);
                schedulePreviewLayout();
              }
            ).wrap,
            btn("×", "mini", () => {
              segs.splice(sIdx, 1);
              schedulePreviewLayout();
              renderIntoHost();
            })
          );
          segList.append(row);
        });
        fields.append(segList);
      }

      card.append(fields);
      if (op.op === "overlay_text" || op.op === "captions") {
        card.append(
          renderTextStyleControls(op, () => {
            schedulePreviewLayout();
            renderIntoHost();
          })
        );
      }
      opsPanel.append(card);
    });

    if (formError) {
      opsPanel.append(el("div", "notice", formError));
    }

    const details = document.createElement("details");
    details.style.marginTop = "10px";
    details.append(
      el("summary", "", "View request JSON"),
      el("pre", "", JSON.stringify(buildInstructions(), null, 2))
    );
    opsPanel.append(details, el("div", "divider"));

    const renderBtn = btn(
      busy ? "Rendering…" : boundProj ? "▶ Render & Save Project Version" : "▶ Render MP4",
      "btn primary full",
      () => void startRender(),
      !ctx.isConnected() || busy || ops.length === 0
    );
    opsPanel.append(renderBtn);

    leftCol.append(srcPanel, opsPanel);

    // Right Column: Preview + Render Progress & Resume
    const prevPanel = el("section", "panel");
    const prevHead = el("div", "panelhead");
    prevHead.append(el("h2", "", "Preview"));
    const tabGroup = el("div", "row-actions");
    const safeToggle = btn(
      showSafeZone ? "Safe Zone: ON" : "Safe Zone: OFF",
      "mini",
      () => {
        showSafeZone = !showSafeZone;
        const reframeOp = ops.find((o) => o.op === "reframe");
        const cropMode = reframeOp && reframeOp.mode !== "pad" && reframeOp.mode !== "blur";
        player.setLayoutData(previewLayout, showSafeZone, Boolean(cropMode));
        renderIntoHost();
      }
    );
    const tabs = el("div", "tabrow");
    const origTab = btn(
      "Original",
      `tab ${previewMode === "source" ? "active" : ""}`,
      () => {
        previewMode = "source";
        if (localObjectUrl) player.setLocalSourceUrl(localObjectUrl);
        else if (sourceStreamUrl) player.setStreamUrl(sourceStreamUrl, { showTextOverlay: true });
        else player.setLocalSourceUrl(null);
        renderIntoHost();
      }
    );
    const outTab = btn(
      "Rendered",
      `tab ${previewMode === "output" ? "active" : ""}`,
      () => {
        if (!outputStreamUrl) return;
        previewMode = "output";
        player.setStreamUrl(outputStreamUrl);
        renderIntoHost();
      },
      !outputStreamUrl
    );
    tabs.append(origTab, outTab);
    tabGroup.append(safeToggle, tabs);
    prevHead.append(tabGroup);
    prevPanel.append(prevHead, player.root);

    // Panel 03: Render output & resume
    const jobPanel = el("section", "panel");
    const jobHead = el("div", "panelhead");
    const jobTitle = el("h2");
    jobTitle.append(el("span", "num", "03"), "Render Output");
    jobHead.append(jobTitle, el("span", `badge badge-${statusTone(jobStatus || "ready")}`, jobStatus || "Ready"));
    jobPanel.append(jobHead);

    const statusRow = el("div", "statusrow");
    statusRow.append(el("span", "muted small", jobMessage), el("strong", "mono", `${jobProgress}%`));
    const prog = el("div", "progress");
    const barFill = el("div");
    barFill.style.width = `${Math.max(0, Math.min(100, jobProgress))}%`;
    prog.append(barFill);
    jobPanel.append(statusRow, prog, el("div", "small muted", activeJobId ? `Job: ${activeJobId}` : "No active job"));
    if (jobError) jobPanel.append(el("div", "notice", jobError));

    const actRow = el("div", "actions");
    actRow.append(
      btn("Refresh status", "btn", () => {
        stopPolling();
        void pollJob(pollEpoch);
      }, !activeJobId),
      btn(
        "↓ Download MP4",
        "btn primary",
        () => void ctx.downloadJobOutput(activeJobId, `${activeJobId}.mp4`),
        jobStatus !== "completed" || !activeJobId
      )
    );
    if (boundProj && jobStatus === "completed") {
      actRow.append(
        btn("Open Client Review →", "btn", () => ctx.openProjectInReview(boundProj.projectId))
      );
    }
    jobPanel.append(actRow, el("div", "divider"));

    const resumeRow = el("div", "keyrow");
    const resumeInp = document.createElement("input");
    resumeInp.placeholder = "Resume job ID (rj_…)";
    resumeInp.value = activeJobId;
    resumeRow.append(
      resumeInp,
      btn("Load", "btn", () => {
        const val = resumeInp.value.trim();
        if (!/^rj_[0-9a-f]{8}$/.test(val)) {
          jobError = "Enter a valid job ID (rj_xxxxxxxx).";
          renderIntoHost();
          return;
        }
        loadExistingJob(val);
      })
    );
    jobPanel.append(resumeRow);

    if (recentJobs.length > 0) {
      const rw = el("div", "recent-wrap");
      rw.append(el("div", "small muted", "Your recent render jobs"));
      const rl = el("div", "recent-list");
      for (const rj of recentJobs.slice(0, 6)) {
        const item = el("div", "recent-item");
        const meta = el("div", "recent-meta");
        meta.append(
          el("div", "recent-id", rj.job_id),
          el("div", "recent-sub", `${rj.status} · ${rj.progress ?? 0}%${rj.duration_s ? ` · ${rj.duration_s.toFixed(1)}s` : ""}`)
        );
        item.append(meta, btn("Load", "mini", () => loadExistingJob(rj.job_id)));
        rl.append(item);
      }
      rw.append(rl);
      jobPanel.append(rw);
    }

    rightCol.append(prevPanel, jobPanel);
    layout.append(leftCol, rightCol);
    hostEl.append(layout);
  };

  const loadExistingJob = (jid: string) => {
    stopPolling();
    outputStreamUrl = "";
    activeJobId = jid;
    jobStatus = "";
    jobError = "";
    busy = true;
    renderIntoHost();
    void pollJob(pollEpoch);
  };

  const loadProject = async (project: ProjectRecord, autoRender = false) => {
    boundProjectId = project.projectId;
    ctx.setSelectedProjectId(project.projectId);
    if (Array.isArray(project.editingInstructions?.operations) && project.editingInstructions.operations.length > 0) {
      ops = JSON.parse(JSON.stringify(project.editingInstructions.operations)) as StudioOperation[];
      resolutionPreset = project.editingInstructions.resolution_preset || "export_1080p";
    } else {
      ops = [{ op: "reframe", aspect: project.targetAspectRatio || "9:16", mode: "crop", crop_x: 0.5, crop_y: 0.5 }];
    }

    sourceStreamUrl = "";
    if (!localFile && project.sourceAssetId) {
      try {
        sourceStreamUrl = await ctx.streamProjectAssetUrl(project.projectId, project.sourceAssetId);
        previewMode = "source";
        player.setStreamUrl(sourceStreamUrl, { showTextOverlay: true });
      } catch {
        sourceStreamUrl = "";
      }
    }

    schedulePreviewLayout();
    renderIntoHost();

    if (autoRender) {
      await startRender();
    }
  };

  return {
    mount(container: HTMLElement) {
      hostEl = container;
      if (!ops.length) {
        ops = [{ op: "reframe", aspect: "9:16", mode: "crop", crop_x: 0.5, crop_y: 0.5 }];
      }
      void refreshRecentJobs();
      renderIntoHost();
      schedulePreviewLayout();
    },
    loadProject,
    loadExistingJob,
  };
}
