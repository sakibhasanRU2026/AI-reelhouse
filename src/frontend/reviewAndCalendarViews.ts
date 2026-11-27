import {
  createVideoVersionRecord,
  deletePublishingRecord,
  finalizeVideoVersionRender,
  getConnectionDiagnostics,
  reviewVideoVersion,
  saveFeedbackRecord,
  savePublishingRecord,
  upsertRenderJobRecord,
} from "./crmDb.js";
import { AppContext } from "./context.js";
import {
  badge,
  btn,
  el,
  formatIsoShort,
  formatTimeClock,
  formatUserError,
  inputField,
  selectField,
  showToast,
  statusTone,
  textareaField,
} from "./dom.js";
import { AspectRatio, RevisionParseResult, StudioInstructions } from "./types.js";
import { createManagedVideoPlayer } from "./videoPlayer.js";

const CAPTION_TEMPLATES: Record<string, { label: string; text: string; tags: string }> = {
  value_hook: {
    label: "Value Breakdown + Save CTA",
    text: "3 steps to level up your workflow without extra guesswork. Save this for later!",
    tags: "#contentcreation #workflow #reels #automation",
  },
  bts_story: {
    label: "Behind The Scenes",
    text: "How we turned raw footage into a polished cut in minutes. Full breakdown below.",
    tags: "#behindthescenes #videoediting #creatorstudio",
  },
  product_launch: {
    label: "Launch Announcement",
    text: "Introducing our latest release — built for speed and clarity. Link in bio.",
    tags: "#launch #shortformvideo #growth",
  },
};

export function renderReviewView(container: HTMLElement, ctx: AppContext): void {
  const snap = ctx.getSnapshot();
  const projectsWithVersions = snap.projects.filter((p) =>
    snap.videoVersions.some((v) => v.projectId === p.projectId)
  );
  const state = {
    projectId: ctx.getSelectedProjectId() || projectsWithVersions[0]?.projectId || snap.projects[0]?.projectId || "",
    versionId: ctx.getSelectedVersionId() || "",
    compareVersionId: "",
    feedbackText: "",
    capturedTimestampS: null as number | null,
    parsePreview: null as RevisionParseResult | null,
    revisionBusy: false,
    approvalBusy: false,
    rejectOpen: false,
    rejectNote: "",
    revisionStatus: "",
    loadedStreamVersionId: "",
  };

  const player = createManagedVideoPlayer({
    emptyTitle: "No rendered version available",
    emptySub: "Render a First Cut in Content Projects or Video Studio first.",
    maxPortraitWidth: 380,
    onCaptureTimestamp: (sec) => {
      state.capturedTimestampS = Number(sec.toFixed(2));
      showToast(`Captured timestamp ${formatTimeClock(sec)}`, "info");
      draw(false);
    },
  });

  const loadVersionStream = async (jobId: string, versionId: string) => {
    if (!jobId || state.loadedStreamVersionId === versionId) return;
    state.loadedStreamVersionId = versionId;
    player.setStatusOverlay(true, true, "Loading version stream…");
    try {
      const url = await ctx.streamJobOutputUrl(jobId);
      player.setStreamUrl(url);
      player.setStatusOverlay(false, false, "");
    } catch (e) {
      player.setStatusOverlay(
        true,
        false,
        `${formatUserError(e, "Output unavailable.")} (Temporary file may have expired — re-upload source footage to regenerate.)`,
        () => {
          state.loadedStreamVersionId = "";
          void loadVersionStream(jobId, versionId);
        }
      );
    }
  };

  const pollRevisionJob = async (
    jobId: string,
    versionId: string,
    projectId: string
  ): Promise<void> => {
    const proj = ctx.getSnapshot().projects.find((p) => p.projectId === projectId);
    const pollLoop = async (): Promise<void> => {
      try {
        const r = await ctx.apiFetch(`/v1/render-jobs/${jobId}`);
        const j = (await r.json()) as {
          status: "queued" | "rendering" | "completed" | "failed";
          progress: number;
          error?: string | null;
          duration_s?: number | null;
          output_available?: boolean;
        };
        state.revisionStatus = `Revision rendering (${j.status} · ${j.progress}%)…`;
        await upsertRenderJobRecord({
          jobId,
          project: proj,
          status: j.status,
          progress: j.progress,
          error: j.error || undefined,
          durationS: j.duration_s ?? undefined,
          isCreate: false,
        }).catch(() => {});

        if (j.status === "completed" || j.status === "failed") {
          await finalizeVideoVersionRender({
            versionId,
            projectId,
            completed: j.status === "completed",
            outputAvailable: Boolean(j.output_available ?? j.status === "completed"),
            durationS: j.duration_s ?? undefined,
          });
          await ctx.refreshSnapshot();
          state.revisionBusy = false;
          state.versionId = versionId;
          state.loadedStreamVersionId = "";
          state.revisionStatus =
            j.status === "completed"
              ? "New revision rendered! Fresh approval required."
              : `Revision render failed: ${j.error || "FFmpeg error"}`;
          draw(true);
          return;
        }
        draw(false);
        window.setTimeout(() => void pollLoop(), 1600);
      } catch (e) {
        state.revisionBusy = false;
        state.revisionStatus = formatUserError(e, "Failed to poll revision.");
        draw(false);
      }
    };
    await pollLoop();
  };

  const previewParsedEdits = async (curIns?: StudioInstructions): Promise<RevisionParseResult | null> => {
    if (!state.feedbackText.trim()) {
      showToast("Enter revision instructions first.", "err");
      return null;
    }
    try {
      const r = await ctx.apiFetch("/v1/revisions/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback_text: state.feedbackText,
          timestamp_s: state.capturedTimestampS,
          current_instructions: curIns,
        }),
      });
      const parsed = (await r.json()) as RevisionParseResult;
      state.parsePreview = {
        ...parsed,
        matchedRules: Array.isArray(parsed.matchedRules) ? parsed.matchedRules : [],
        unsupportedPhrases: Array.isArray(parsed.unsupportedPhrases) ? parsed.unsupportedPhrases : [],
        updatedInstructions: parsed.updatedInstructions || {
          schema_version: "1.0",
          resolution_preset: "export_1080p",
          operations: [],
        },
      };
      draw(false);
      return state.parsePreview;
    } catch (e) {
      showToast(formatUserError(e, "Failed to parse revision instructions."), "err");
      return null;
    }
  };

  const draw = (reloadStream = true) => {
    container.replaceChildren();
    const curSnap = ctx.getSnapshot();
    const proj = curSnap.projects.find((p) => p.projectId === state.projectId);
    const versions = proj
      ? curSnap.videoVersions
          .filter((v) => v.projectId === proj.projectId)
          .sort((a, b) => b.versionNumber - a.versionNumber)
      : [];
    const curVer =
      versions.find((v) => v.versionId === state.versionId) || versions[0];
    if (curVer) state.versionId = curVer.versionId;

    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Review & Approvals"),
      el("h1", "", "Client Review & Automatic Revision Engine"),
      el(
        "div",
        "muted",
        "Watch rendered versions, capture timestamps, trigger deterministic FFmpeg revisions, and issue fresh version approvals."
      )
    );
    const hr = el("div", "row-actions");
    hr.append(
      selectField(
        "Project",
        state.projectId,
        curSnap.projects.map((p): [string, string] => [p.projectId, `${p.title} (${p.status})`]),
        (pid) => {
          state.projectId = pid;
          state.versionId = "";
          state.loadedStreamVersionId = "";
          state.parsePreview = null;
          ctx.setSelectedProjectId(pid);
          draw(true);
        }
      ).wrap
    );
    if (versions.length > 0 && curVer) {
      hr.append(
        selectField(
          "Version",
          curVer.versionId,
          versions.map((v): [string, string] => [
            v.versionId,
            `v${v.versionNumber} (${(v.approvalStatus || "pending_review").replace("_", " ")})`,
          ]),
          (vid) => {
            state.versionId = vid;
            state.loadedStreamVersionId = "";
            ctx.setSelectedVersionId(vid);
            draw(true);
          }
        ).wrap
      );
    }
    head.append(hl, hr);
    container.append(head);

    if (!proj || !curVer) {
      const empty = el("section", "panel");
      empty.append(
        el(
          "div",
          "empty",
          "Select a project that has at least one rendered video version to start reviewing."
        )
      );
      container.append(empty);
      return;
    }

    if (reloadStream) {
      void loadVersionStream(curVer.jobId, curVer.versionId);
    }

    const layout = el("div", "studio-grid");

    // Left: Player + Version Metadata + Approval Actions
    const left = el("div", "stack");
    const playerPanel = el("section", "panel");
    const ph = el("div", "panelhead");
    const curVerStatus = curVer.approvalStatus || "pending_review";
    ph.append(
      el("h2", "", `${proj.title} · Version ${curVer.versionNumber}`),
      badge(curVerStatus.replace("_", " "), statusTone(curVerStatus))
    );
    playerPanel.append(ph, player.root);

    const verMeta = el("div", "inline-info");
    verMeta.append(
      el(
        "span",
        "small muted",
        `Job: ${curVer.jobId} · ${curVer.aspectRatio || proj.targetAspectRatio} · ${curVer.revisionNotes || "Cut ready for review"}`
      ),
      btn("↓ Download MP4", "mini", () => void ctx.downloadJobOutput(curVer.jobId, `${proj.title}_v${curVer.versionNumber}.mp4`))
    );
    playerPanel.append(verMeta);

    // Fresh Approval Box
    if (state.rejectOpen) {
      const rejBox = el("div", "subpanel");
      rejBox.append(
        inputField("Rejection Reason", state.rejectNote, (v) => (state.rejectNote = v), {
          placeholder: "Describe why this cut was rejected…",
          wide: true,
          disabled: state.approvalBusy,
        }).wrap
      );
      const rejActs = el("div", "actions");
      rejActs.append(
        btn(
          state.approvalBusy ? "Saving…" : "Confirm Reject",
          "btn btn-danger",
          async () => {
            if (state.approvalBusy) return;
            state.approvalBusy = true;
            draw(false);
            try {
              await reviewVideoVersion({
                project: proj,
                version: curVer,
                decision: "rejected",
                note: state.rejectNote.trim() || "Rejected during review",
              });
              await ctx.refreshSnapshot();
              state.rejectOpen = false;
              state.rejectNote = "";
              showToast(`Version ${curVer.versionNumber} marked rejected.`, "info");
            } catch (e) {
              showToast(formatUserError(e, "Action failed."), "err");
            } finally {
              state.approvalBusy = false;
              draw(false);
            }
          },
          state.approvalBusy
        ),
        btn(
          "Cancel",
          "mini",
          () => {
            state.rejectOpen = false;
            state.rejectNote = "";
            draw(false);
          },
          state.approvalBusy
        )
      );
      rejBox.append(rejActs);
      playerPanel.append(rejBox);
    }

    const approveBar = el("div", "actions");
    approveBar.append(
      btn(
        state.approvalBusy ? "Processing…" : `✓ Approve Version ${curVer.versionNumber}`,
        "btn primary",
        async () => {
          if (state.approvalBusy) return;
          state.approvalBusy = true;
          draw(false);
          try {
            await reviewVideoVersion({
              project: proj,
              version: curVer,
              decision: "approved",
              note: `Approved Version ${curVer.versionNumber}`,
            });
            await ctx.refreshSnapshot();
            state.rejectOpen = false;
            showToast(`Version ${curVer.versionNumber} approved! Ready for scheduling.`, "ok");
          } catch (e) {
            showToast(formatUserError(e, "Approval failed."), "err");
          } finally {
            state.approvalBusy = false;
            draw(false);
          }
        },
        curVer.approvalStatus === "approved" || state.revisionBusy || state.approvalBusy
      ),
      btn(
        `✕ Reject Version ${curVer.versionNumber}`,
        "btn btn-danger",
        () => {
          state.rejectOpen = !state.rejectOpen;
          draw(false);
        },
        state.revisionBusy || state.approvalBusy
      )
    );
    playerPanel.append(approveBar);

    // Version comparison summary
    if (versions.length > 1) {
      const cmp = el("section", "panel");
      cmp.append(el("div", "panelhead", "Version Comparison"));
      const cmpList = el("div", "list-stack");
      for (const v of versions) {
        const row = el("div", "list-row");
        const m = el("div", "list-meta");
        m.append(
          el("div", "list-title", `Version ${v.versionNumber} (${v.jobId})`),
          el(
            "div",
            "list-sub",
            `${v.revisionNotes || "Cut"} · ${Array.isArray(v.instructions?.operations) ? v.instructions.operations.length : 0} operations · ${formatIsoShort(v.createdAt)}`
          )
        );
        const r = el("div", "row-actions");
        const vStatus = v.approvalStatus || "pending_review";
        r.append(
          badge(vStatus.replace("_", " "), statusTone(vStatus)),
          btn(v.versionId === curVer.versionId ? "Viewing" : "Switch", "mini", () => {
            state.versionId = v.versionId;
            state.loadedStreamVersionId = "";
            draw(true);
          }, v.versionId === curVer.versionId)
        );
        row.append(m, r);
        cmpList.append(row);
      }
      cmp.append(cmpList);
      left.append(playerPanel, cmp);
    } else {
      left.append(playerPanel);
    }

    // Right: Automatic Revision Feedback + History of feedback for project
    const right = el("div", "stack");
    const revPanel = el("section", "panel");
    revPanel.append(
      el("div", "panelhead", "Request Automatic Revision"),
      el(
        "p",
        "small muted",
        'Enter natural commands such as: "Cut the intro to two seconds.", "Make the caption smaller.", "Move the caption to the bottom.", "Remove the section between 00:10 and 00:15.", or "Add a blurred background."'
      )
    );

    const tsRow = el("div", "inline-info");
    tsRow.append(
      el(
        "span",
        "small",
        state.capturedTimestampS !== null
          ? `Attached timestamp: ${formatTimeClock(state.capturedTimestampS)} (${state.capturedTimestampS}s)`
          : "Timestamp: Not pinned (click Capture time on the player while paused)"
      ),
      btn("Capture Current Time", "mini", () => {
        state.capturedTimestampS = Number(player.getCurrentTime().toFixed(2));
        draw(false);
      })
    );
    if (state.capturedTimestampS !== null) {
      tsRow.append(
        btn("Clear", "mini", () => {
          state.capturedTimestampS = null;
          draw(false);
        })
      );
    }
    revPanel.append(tsRow);

    const fbArea = textareaField(
      "Client Revision Instructions",
      state.feedbackText,
      (v) => {
        state.feedbackText = v;
        state.parsePreview = null;
      },
      { placeholder: "e.g. Cut the intro to two seconds and make the caption smaller.", rows: 3, wide: true }
    );
    revPanel.append(fbArea.wrap);

    if (state.parsePreview) {
      const pBox = el("div", "subpanel");
      const matchedRules = Array.isArray(state.parsePreview.matchedRules)
        ? state.parsePreview.matchedRules
        : [];
      if (state.parsePreview.clarificationNeeded) {
        pBox.append(
          badge("Clarification Needed", "amber"),
          el("div", "notice", state.parsePreview.clarificationPrompt || "Please clarify your edit.")
        );
      } else if (matchedRules.length > 0) {
        pBox.append(badge("Supported Operations Matched", "green"));
        const ul = el("ul", "script-points");
        for (const mr of matchedRules) ul.append(el("li", "small", mr));
        pBox.append(ul);
      } else {
        pBox.append(badge("No Supported Rules Matched", "amber"));
      }
      revPanel.append(pBox);
    }

    if (state.revisionStatus) {
      revPanel.append(el("div", "small", state.revisionStatus));
    }

    const revBtns = el("div", "actions");
    revBtns.append(
      btn("Preview Interpreted Edits", "btn", () => void previewParsedEdits(curVer.instructions), state.revisionBusy),
      btn(
        state.revisionBusy ? "Rendering Revision…" : "Submit Feedback & Auto-Revise",
        "btn primary",
        async () => {
          try {
            const parsed = await previewParsedEdits(curVer.instructions);
            if (!parsed) return;
            const matchedRules = Array.isArray(parsed.matchedRules) ? parsed.matchedRules : [];
            if (parsed.clarificationNeeded) {
              await saveFeedbackRecord({
                project: proj,
                version: curVer,
                comment: state.feedbackText,
                timestampS: state.capturedTimestampS,
                matchedRules,
                clarificationNeeded: true,
                status: "needs_clarification",
              });
              await ctx.refreshSnapshot();
              showToast("Clarification needed before rendering — feedback saved.", "info");
              draw(false);
              return;
            }

            if (!proj.sourceAssetId) {
              showToast("Source footage is missing. Re-upload source footage in Content Projects first.", "err");
              return;
            }

            state.revisionBusy = true;
            state.revisionStatus = "Submitting automatic revision render job…";
            draw(false);

            const nextVerNum = (proj.latestVersionNumber || curVer.versionNumber) + 1;
            const r = await ctx.apiFetch(`/v1/projects/${proj.projectId}/render`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                source_asset_id: proj.sourceAssetId,
                instructions: parsed.updatedInstructions,
                version_number: nextVerNum,
                client_uid: proj.clientUid,
                client_email: proj.clientEmail,
              }),
            });
            const jr = (await r.json()) as { job_id: string };
            await saveFeedbackRecord({
              project: proj,
              version: curVer,
              comment: state.feedbackText,
              timestampS: state.capturedTimestampS,
              matchedRules,
              clarificationNeeded: false,
              triggeredRevisionJobId: jr.job_id,
              status: "applied",
            });
            await upsertRenderJobRecord({
              jobId: jr.job_id,
              project: proj,
              versionNumber: nextVerNum,
              status: "queued",
              progress: 0,
              resolutionPreset: parsed.updatedInstructions?.resolution_preset || "export_1080p",
              isCreate: true,
            });
            const ops = Array.isArray(parsed.updatedInstructions?.operations)
              ? parsed.updatedInstructions.operations
              : [];
            const reframeOp = ops.find((o) => o.op === "reframe");
            const nextVerId = await createVideoVersionRecord({
              project: proj,
              versionNumber: nextVerNum,
              jobId: jr.job_id,
              instructions: parsed.updatedInstructions || {
                schema_version: "1.0",
                resolution_preset: "export_1080p",
                operations: [],
              },
              revisionNotes: matchedRules.join(" · ").slice(0, 900) || state.feedbackText.slice(0, 900),
              aspectRatio: ((reframeOp?.aspect as AspectRatio) || proj.targetAspectRatio || "9:16"),
              resolutionPreset: parsed.updatedInstructions?.resolution_preset || "export_1080p",
            });
            await ctx.refreshSnapshot();
            state.feedbackText = "";
            state.capturedTimestampS = null;
            state.parsePreview = null;
            await pollRevisionJob(jr.job_id, nextVerId, proj.projectId);
          } catch (e) {
            state.revisionBusy = false;
            state.revisionStatus = formatUserError(e, "Automatic revision failed.");
            showToast(state.revisionStatus, "err");
            draw(false);
          }
        },
        state.revisionBusy
      )
    );
    revPanel.append(revBtns);

    // Feedback history for this project
    const projFeedback = curSnap.feedback.filter((f) => f.projectId === proj.projectId);
    const fbPanel = el("section", "panel");
    fbPanel.append(el("div", "panelhead", `Feedback Log (${projFeedback.length})`));
    if (projFeedback.length === 0) {
      fbPanel.append(el("div", "empty small", "No feedback submitted for this project yet."));
    } else {
      const fl = el("div", "list-stack");
      for (const f of projFeedback) {
        const matched = Array.isArray(f.matchedRules) ? f.matchedRules : [];
        const row = el("div", "activity-item");
        row.append(
          el(
            "div",
            "activity-summary",
            `${f.versionNumber ? `[v${f.versionNumber}] ` : ""}${f.timestampS !== undefined ? `@ ${formatTimeClock(f.timestampS)} · ` : ""}${f.comment}`
          ),
          el(
            "div",
            "activity-meta",
            `${f.status}${matched.length ? ` · Applied: ${matched.join(", ")}` : ""}${f.triggeredRevisionJobId ? ` · Job ${f.triggeredRevisionJobId}` : ""}`
          )
        );
        fl.append(row);
      }
      fbPanel.append(fl);
    }

    right.append(revPanel, fbPanel);
    layout.append(left, right);
    container.append(layout);
  };

  draw(true);
}

export function renderHistoryView(container: HTMLElement, ctx: AppContext): void {
  const state = {
    projectId: ctx.getSelectedProjectId() || "",
    jobAvail: new Map<string, boolean>(),
  };

  const checkLive = async (jid: string) => {
    try {
      const r = await ctx.apiFetch(`/v1/render-jobs/${jid}`);
      const d = (await r.json()) as { output_available?: boolean };
      const avail = Boolean(d.output_available);
      state.jobAvail.set(jid, avail);
      showToast(avail ? "Output verified ready on storage." : "Output file no longer present on temporary storage.", avail ? "ok" : "info");
      draw();
    } catch (e) {
      showToast(formatUserError(e, "Failed to verify storage status."), "err");
    }
  };

  const draw = () => {
    const snap = ctx.getSnapshot();
    container.replaceChildren();
    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Audit Trail"),
      el("h1", "", "Revision History & Version Log"),
      el("div", "muted", "Immutable version snapshots, revision notes, feedback history, and output availability.")
    );
    const hr = el("div", "row-actions");
    hr.append(
      selectField(
        "Filter by Project",
        state.projectId,
        [["", "All Projects"], ...snap.projects.map((p): [string, string] => [p.projectId, p.title])],
        (v) => {
          state.projectId = v;
          draw();
        }
      ).wrap
    );
    head.append(hl, hr);
    container.append(head);

    const versions = state.projectId
      ? snap.videoVersions.filter((v) => v.projectId === state.projectId)
      : snap.videoVersions;

    if (versions.length === 0) {
      const empty = el("section", "panel");
      empty.append(el("div", "empty", "No video versions rendered yet."));
      container.append(empty);
      return;
    }

    const stack = el("div", "stack");
    for (const v of versions) {
      const proj = snap.projects.find((p) => p.projectId === v.projectId);
      const liveKnown = state.jobAvail.has(v.jobId) ? state.jobAvail.get(v.jobId) : v.outputAvailable;
      const approvalStatus = v.approvalStatus || "pending_review";

      const card = el("section", "panel");
      const ch = el("div", "panelhead");
      const tl = el("div");
      tl.append(
        el("h2", "", `${proj?.title || v.projectId} — Version ${v.versionNumber}`),
        el(
          "div",
          "small muted",
          `Job ${v.jobId} · ${v.aspectRatio || "9:16"} · ${v.resolutionPreset || "export_1080p"} · ${formatIsoShort(v.createdAt)}`
        )
      );
      const tr = el("div", "row-actions");
      tr.append(
        badge(approvalStatus.replace("_", " "), statusTone(approvalStatus)),
        badge(liveKnown ? "Output Ready" : "Temporary File Expired", liveKnown ? "green" : "red")
      );
      ch.append(tl, tr);
      card.append(ch);

      if (v.revisionNotes) card.append(el("div", "small", `Notes: ${v.revisionNotes}`));
      if (v.approvedBy) card.append(el("div", "small muted", `Reviewed by: ${v.approvedBy}`));

      const act = el("div", "actions");
      act.append(
        btn("Review Cut", "btn", () => ctx.openProjectInReview(v.projectId, v.versionId)),
        btn("Verify Storage", "mini", () => void checkLive(v.jobId)),
        btn(
          "↓ Download MP4",
          "btn primary",
          () => void ctx.downloadJobOutput(v.jobId, `${proj?.title || v.projectId}_v${v.versionNumber}.mp4`),
          !liveKnown
        )
      );
      card.append(act);
      stack.append(card);
    }
    container.append(stack);
  };

  draw();
}

export function renderCalendarView(container: HTMLElement, ctx: AppContext): void {
  const initialSnap = ctx.getSnapshot();
  const now = new Date();
  const state = {
    viewMode: "month" as "month" | "week",
    year: now.getFullYear(),
    month: now.getMonth(),
    showForm: false,
    saving: false,
    busyRecordIds: new Set<string>(),
  };

  const initialApproved = initialSnap.videoVersions.filter((v) => v.approvalStatus === "approved");
  const draft = {
    versionId: initialApproved[0]?.versionId || "",
    platform: "instagram" as "instagram" | "tiktok",
    plannedDate: now.toISOString().slice(0, 10),
    templateKey: "value_hook",
    title: "",
    caption: CAPTION_TEMPLATES.value_hook.text,
    hashtags: CAPTION_TEMPLATES.value_hook.tags,
  };

  const draw = () => {
    const snap = ctx.getSnapshot();
    const approvedVersions = snap.videoVersions.filter((v) => v.approvalStatus === "approved");
    if (approvedVersions.length > 0 && !approvedVersions.some((v) => v.versionId === draft.versionId)) {
      draft.versionId = approvedVersions[0].versionId;
    }
    container.replaceChildren();
    const head = el("div", "view-header");
    const hl = el("div");
    hl.append(
      el("div", "eyebrow", "Content Calendar"),
      el("h1", "", "Publishing Schedule"),
      el("div", "muted", "Schedule approved video versions across Monthly & Weekly calendar views.")
    );
    const hr = el("div", "row-actions");
    hr.append(
      btn(state.viewMode === "month" ? "Switch to Week View" : "Switch to Month View", "btn", () => {
        state.viewMode = state.viewMode === "month" ? "week" : "month";
        draw();
      }),
      btn(state.showForm ? "Close Schedule Form" : "+ Schedule Approved Video", "btn primary", () => {
        state.showForm = !state.showForm;
        draw();
      })
    );
    head.append(hl, hr);
    container.append(head);

    if (state.showForm) {
      const form = el("section", "panel");
      form.append(el("div", "panelhead", "Schedule Approved Version"));
      if (approvedVersions.length === 0) {
        form.append(
          el(
            "div",
            "notice",
            "No approved video versions yet. Approve a rendered cut in Review & Approvals first."
          )
        );
      } else {
        const grid = el("div", "fields");
        grid.append(
          selectField(
            "Approved Video Version *",
            draft.versionId,
            approvedVersions.map((v): [string, string] => {
              const p = snap.projects.find((x) => x.projectId === v.projectId);
              return [v.versionId, `${p?.title || v.projectId} · v${v.versionNumber}`];
            }),
            (v) => (draft.versionId = v)
          ).wrap,
          selectField(
            "Platform",
            draft.platform,
            [
              ["instagram", "Instagram Reels"],
              ["tiktok", "TikTok"],
            ],
            (v) => (draft.platform = v === "tiktok" ? "tiktok" : "instagram")
          ).wrap,
          inputField("Planned Date *", draft.plannedDate, (v) => (draft.plannedDate = v), { type: "date" }).wrap,
          selectField(
            "Caption Template",
            draft.templateKey,
            Object.entries(CAPTION_TEMPLATES).map(([k, val]): [string, string] => [k, val.label]),
            (k) => {
              draft.templateKey = k;
              const tpl = CAPTION_TEMPLATES[k];
              if (tpl) {
                draft.caption = tpl.text;
                draft.hashtags = tpl.tags;
                draw();
              }
            }
          ).wrap,
          inputField("Schedule Title (optional)", draft.title, (v) => (draft.title = v), { wide: true }).wrap,
          textareaField("Social Post Caption", draft.caption, (v) => (draft.caption = v), { wide: true, rows: 3 }).wrap,
          inputField("Hashtags", draft.hashtags, (v) => (draft.hashtags = v), { wide: true }).wrap
        );
        const act = el("div", "actions");
        act.append(
          btn(
            "Cancel",
            "btn",
            () => {
              state.showForm = false;
              draw();
            },
            state.saving
          ),
          btn(
            state.saving ? "Scheduling…" : "Add to Calendar",
            "btn primary",
            async () => {
              if (state.saving) return;
              const ver = approvedVersions.find((v) => v.versionId === draft.versionId);
              const proj = ver ? snap.projects.find((p) => p.projectId === ver.projectId) : undefined;
              if (!ver || !proj) {
                showToast("Select an approved video version.", "err");
                return;
              }
              state.saving = true;
              draw();
              try {
                const integ = ctx.getIntegrations();
                const pubList = Array.isArray(integ?.publishing_integrations)
                  ? integ.publishing_integrations
                  : [];
                const platStatus = pubList.find((x) => x.platform === draft.platform);
                const isConn = Boolean(platStatus?.connected);
                await savePublishingRecord({
                  project: proj,
                  version: ver,
                  title: draft.title.trim() || `${proj.title} v${ver.versionNumber}`,
                  platform: draft.platform,
                  caption: draft.caption,
                  hashtags: draft.hashtags.split(/\s+/).filter(Boolean),
                  templateName: CAPTION_TEMPLATES[draft.templateKey]?.label,
                  plannedDate: draft.plannedDate || now.toISOString().slice(0, 10),
                  readiness: isConn ? "scheduled" : "not_connected",
                  integrationStatus: isConn ? "connected" : "not_connected",
                });
                await ctx.refreshSnapshot();
                state.showForm = false;
                showToast("Scheduled onto Content Calendar.", "ok");
              } catch (e) {
                showToast(formatUserError(e, "Failed to save schedule entry."), "err");
              } finally {
                state.saving = false;
                draw();
              }
            },
            state.saving
          )
        );
        form.append(grid, act);
      }
      container.append(form);
    }

    // Calendar Grid
    const calPanel = el("section", "panel");
    const monthName = new Date(state.year, state.month, 1).toLocaleString(undefined, {
      month: "long",
      year: "numeric",
    });
    const nav = el("div", "panelhead");
    nav.append(
      el("h2", "", state.viewMode === "month" ? monthName : `Week of ${now.toISOString().slice(0, 10)}`),
      (() => {
        const b = el("div", "row-actions");
        b.append(
          btn("◀ Prev", "mini", () => {
            if (state.month === 0) {
              state.month = 11;
              state.year--;
            } else state.month--;
            draw();
          }),
          btn("Next ▶", "mini", () => {
            if (state.month === 11) {
              state.month = 0;
              state.year++;
            } else state.month++;
            draw();
          })
        );
        return b;
      })()
    );
    calPanel.append(nav);

    const grid = el("div", "calendar-grid");
    for (const dow of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      grid.append(el("div", "cal-dow", dow));
    }

    const datesToRender: Date[] = [];
    if (state.viewMode === "month") {
      const firstDay = new Date(state.year, state.month, 1);
      const startPad = firstDay.getDay();
      const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
      for (let i = 0; i < startPad; i++) datesToRender.push(new Date(state.year, state.month, 1 - (startPad - i)));
      for (let d = 1; d <= daysInMonth; d++) datesToRender.push(new Date(state.year, state.month, d));
    } else {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      for (let i = 0; i < 7; i++) {
        const dt = new Date(startOfWeek);
        dt.setDate(startOfWeek.getDate() + i);
        datesToRender.push(dt);
      }
    }

    for (const dt of datesToRender) {
      const iso = dt.toISOString().slice(0, 10);
      const inCurMonth = dt.getMonth() === state.month || state.viewMode === "week";
      const cell = el("div", `cal-cell${inCurMonth ? "" : " cal-dim"}`);
      cell.append(el("div", "cal-date mono", String(dt.getDate())));

      const dayRecs = snap.publishingRecords.filter((r) => r.plannedDate === iso);
      const dayDeadlines = snap.projects.filter((p) => p.deadline === iso);
      for (const r of dayRecs) {
        cell.append(el("div", "cal-item cal-pub", `${r.platform === "instagram" ? "IG" : "TT"}: ${r.title}`));
      }
      for (const p of dayDeadlines) {
        cell.append(el("div", "cal-item cal-due", `Due: ${p.title}`));
      }
      grid.append(cell);
    }

    calPanel.append(grid);
    container.append(calPanel);

    // Scheduled items export & copy list
    if (snap.publishingRecords.length > 0) {
      const listPanel = el("section", "panel");
      listPanel.append(el("div", "panelhead", "Scheduled Export Packages"));
      const stack = el("div", "list-stack");
      for (const r of snap.publishingRecords) {
        const ver = snap.videoVersions.find((v) => v.versionId === r.versionId);
        const hashtags = Array.isArray(r.hashtags) ? r.hashtags : [];
        const platLabel = (r.platform || "instagram").toUpperCase();
        const row = el("div", "list-row");
        const m = el("div", "list-meta");
        m.append(
          el("div", "list-title", `${r.plannedDate || "Unscheduled"} · ${r.title || "Untitled Cut"} (${platLabel})`),
          el(
            "div",
            "list-sub",
            `${r.caption || ""} ${hashtags.join(" ")}`.trim()
          )
        );
        const right = el("div", "row-actions");
        right.append(
          badge(r.integrationStatus === "connected" ? "Connected" : "Manual Export Only", r.integrationStatus === "connected" ? "green" : "amber"),
          btn("Copy Caption", "mini", () => {
            const full = [r.caption || "", hashtags.join(" ")].filter(Boolean).join("\n\n");
            navigator.clipboard
              ?.writeText(full)
              .then(() => showToast("Caption copied.", "ok"))
              .catch(() => showToast("Clipboard access unavailable.", "err"));
          })
        );
        if (ver) {
          right.append(
            btn("↓ MP4", "mini", () => void ctx.downloadJobOutput(ver.jobId, `${r.title || "export"}.mp4`))
          );
        }
        const recBusy = state.busyRecordIds.has(r.recordId);
        right.append(
          btn(
            recBusy ? "Removing…" : "Remove",
            "mini btn-danger",
            async () => {
              if (state.busyRecordIds.has(r.recordId)) return;
              state.busyRecordIds.add(r.recordId);
              draw();
              try {
                await deletePublishingRecord(r.recordId);
                await ctx.refreshSnapshot();
                showToast("Removed scheduled item.", "ok");
              } catch (e) {
                showToast(formatUserError(e, "Failed to remove item."), "err");
              } finally {
                state.busyRecordIds.delete(r.recordId);
                draw();
              }
            },
            recBusy
          )
        );
        row.append(m, right);
        stack.append(row);
      }
      listPanel.append(stack);
      container.append(listPanel);
    }
  };

  draw();
}

export function renderPublishingView(container: HTMLElement, ctx: AppContext): void {
  const snap = ctx.getSnapshot();
  const integ = ctx.getIntegrations();
  const integLoading = ctx.isIntegrationsLoading();
  const integError = ctx.getIntegrationsError();

  const head = el("div", "view-header");
  const hl = el("div");
  hl.append(
    el("div", "eyebrow", "Distribution"),
    el("h1", "", "Publishing Preparation & Platform Integrations"),
    el(
      "div",
      "muted",
      "Real platform API connection status and ready-to-download approved video packages. No fake publishing simulation."
    )
  );
  head.append(
    hl,
    btn(
      integLoading ? "Refreshing…" : "Refresh Integration Status",
      "btn",
      () => void ctx.refreshIntegrations(),
      integLoading
    )
  );
  container.append(head);

  if (integError) {
    container.append(el("div", "notice", `Integration diagnostics error: ${integError}`));
  }

  const pubList = Array.isArray(integ?.publishing_integrations) ? integ.publishing_integrations : [];
  if (integLoading && !integ) {
    const lp = el("section", "panel");
    lp.append(el("div", "empty small", "Loading social platform connection status…"));
    container.append(lp);
  } else if (pubList.length === 0) {
    const ep = el("section", "panel");
    ep.append(
      el(
        "div",
        "empty small",
        integError
          ? "Unable to load publishing integration status."
          : "No publishing integrations reported by backend."
      )
    );
    container.append(ep);
  } else {
    const cards = el("div", "crm-two-col");
    for (const plat of pubList) {
      const missingCreds = Array.isArray(plat.missingCredentials) ? plat.missingCredentials : [];
      const card = el("section", "panel");
      const ch = el("div", "panelhead");
      ch.append(
        el("h2", "", plat.displayName || plat.platform),
        badge(plat.statusLabel || (plat.connected ? "Connected" : "Not Connected"), plat.connected ? "green" : "red")
      );
      card.append(ch, el("p", "small muted", plat.note || ""));
      if (missingCreds.length > 0) {
        card.append(
          el("div", "small", `Missing server env vars: ${missingCreds.join(", ")}`)
        );
      }
      cards.append(card);
    }
    container.append(cards);
  }

  const readyPanel = el("section", "panel");
  readyPanel.append(el("div", "panelhead", "Approved Videos Ready for Publishing"));
  const approved = snap.videoVersions.filter((v) => v.approvalStatus === "approved");
  if (approved.length === 0) {
    readyPanel.append(
      el("div", "empty small", "No approved video versions ready yet. Approve a cut in Review & Approvals.")
    );
  } else {
    const list = el("div", "list-stack");
    for (const v of approved) {
      const proj = snap.projects.find((p) => p.projectId === v.projectId);
      const scr = proj?.scriptId ? snap.scripts.find((s) => s.scriptId === proj.scriptId) : undefined;
      const row = el("div", "list-row");
      const m = el("div", "list-meta");
      m.append(
        el("div", "list-title", `${proj?.title || v.projectId} · Version ${v.versionNumber}`),
        el(
          "div",
          "list-sub",
          `Approved by ${v.approvedBy || "Reviewer"} · ${v.aspectRatio || "9:16"} · Caption: ${scr?.captionText || "Prepare on Content Calendar"}`
        )
      );
      const right = el("div", "row-actions");
      if (scr?.captionText) {
        right.append(
          btn("Copy Script Caption", "mini", () => {
            navigator.clipboard
              ?.writeText(scr.captionText || "")
              .then(() => showToast("Copied.", "ok"))
              .catch(() => showToast("Clipboard access unavailable.", "err"));
          })
        );
      }
      right.append(
        btn("Schedule on Calendar", "mini", () => ctx.navigate("calendar")),
        btn("↓ Download Final MP4", "btn primary", () =>
          void ctx.downloadJobOutput(v.jobId, `${proj?.title || v.projectId}_final_v${v.versionNumber}.mp4`)
        )
      );
      row.append(m, right);
      list.append(row);
    }
    readyPanel.append(list);
  }
  container.append(readyPanel);
}

export function renderSettingsView(
  container: HTMLElement,
  ctx: AppContext,
  actions: { reconnect(): void; disconnect(): void; signOut(): void }
): void {
  const session = ctx.getSession();
  const integ = ctx.getIntegrations();
  const integLoading = ctx.isIntegrationsLoading();
  const integError = ctx.getIntegrationsError();
  const diag = getConnectionDiagnostics();

  const head = el("div", "view-header");
  const hl = el("div");
  hl.append(
    el("div", "eyebrow", "Workspace Settings"),
    el("h1", "", "Backend, Storage & Role Diagnostics"),
    el("div", "muted", "Live FFmpeg worker state, storage adapter configuration, and research/publishing connections.")
  );
  head.append(
    hl,
    btn(
      integLoading ? "Refreshing…" : "Refresh Diagnostics",
      "btn",
      () => void ctx.refreshIntegrations(),
      integLoading
    )
  );
  container.append(head);

  if (integError) {
    container.append(el("div", "notice", `Diagnostics error: ${integError}`));
  }

  const grid = el("div", "crm-two-col");

  // Account & Auth card
  const acc = el("section", "panel");
  acc.append(
    el("div", "panelhead", "Account & Security"),
    el("div", "small", `Email: ${session?.email || "Local Studio Session"}`),
    el("div", "small", `Role: ${session?.role === "admin" ? "Admin (Full Workspace Access)" : "Client (Isolated Portal Access)"}`),
    el("div", "small muted", `UID: ${session?.uid || "—"}`),
    el("div", "small muted", `Firestore Connection: ${diag.verified ? "Verified" : diag.warning || "Checking…"}`)
  );
  if (diag.warning) {
    acc.append(el("div", "notice", diag.warning));
  }
  const accBtns = el("div", "actions");
  accBtns.append(
    btn("Reconnect Renderer", "btn", actions.reconnect),
    btn("Disconnect", "btn", actions.disconnect),
    btn("Sign Out", "btn btn-danger", actions.signOut)
  );
  acc.append(accBtns);

  // Worker & FFmpeg card
  const wrk = el("section", "panel");
  wrk.append(el("div", "panelhead", "FFmpeg Render Worker"));
  const rw = integ?.render_worker;
  if (integ && rw) {
    wrk.append(
      el("div", "small", `FFmpeg Version: ${integ.ffmpeg_version || "Unavailable"}`),
      el("div", "small muted", `Workers: ${rw.active ?? 0} active / ${rw.max_workers ?? 0} max · Queued: ${rw.queued ?? 0}`),
      el("div", "small muted", `Limits: Max upload ${rw.max_upload_mb ?? 0} MB · Max duration ${rw.max_duration_s ?? 0}s · Timeout ${rw.ffmpeg_timeout_s ?? 0}s`)
    );
  } else if (integError) {
    wrk.append(el("div", "notice", "Unable to retrieve FFmpeg worker diagnostics."));
  } else {
    wrk.append(el("div", "small muted", integLoading ? "Loading worker diagnostics…" : "Connecting to render worker…"));
  }

  // Storage card
  const sto = el("section", "panel");
  const st = integ?.storage;
  const r2Configured = st?.r2Status === "configured" || Boolean(st?.r2Configured);
  const sh = el("div", "panelhead");
  sh.append(
    el("h2", "", "Media Storage Adapter"),
    badge(
      st ? (r2Configured ? "R2 Ready" : "Local Temp Storage") : integError ? "Unavailable" : "Checking",
      st ? (r2Configured ? "green" : "amber") : integError ? "red" : "neutral"
    )
  );
  sto.append(sh);
  if (st) {
    const ttlHours = st.tempTtlHours ?? st.ttlHours ?? 24;
    const warningMsg =
      st.ephemeralWarning ||
      st.warning ||
      `Temporary server storage is active (TTL ${ttlHours}h).`;
    const missingR2 = Array.isArray(st.missingR2EnvVars) ? st.missingR2EnvVars : [];
    sto.append(
      el("div", "small", `Active adapter: ${st.activeProvider || "local_temp"} (TTL ${ttlHours}h)`),
      el("div", "small muted", warningMsg),
      el(
        "div",
        "small muted",
        r2Configured
          ? "Cloudflare R2 credentials configured."
          : missingR2.length > 0
            ? `Cloudflare R2 not connected — missing: ${missingR2.join(", ")}`
            : "Cloudflare R2 is not connected."
      )
    );
  } else if (integError) {
    sto.append(el("div", "notice", "Unable to retrieve storage adapter status."));
  } else {
    sto.append(el("div", "small muted", integLoading ? "Loading storage diagnostics…" : "Connecting to storage status…"));
  }

  // Research Providers card
  const resCard = el("section", "panel");
  resCard.append(el("div", "panelhead", "Content Research & Discovery Modules"));
  const providers = Array.isArray(integ?.research_providers) ? integ.research_providers : [];
  if (providers.length === 0) {
    resCard.append(
      el(
        "div",
        "small muted",
        integError
          ? "Unable to load research provider status."
          : integLoading
            ? "Loading research modules…"
            : "No research providers reported."
      )
    );
  } else {
    for (const rp of providers) {
      const row = el("div", "list-row");
      const m = el("div", "list-meta");
      m.append(el("div", "list-title", rp.name || rp.id), el("div", "list-sub", rp.description || ""));
      row.append(m, badge(rp.statusLabel || (rp.connected ? "Connected" : "Not Connected"), rp.connected ? "green" : "red"));
      resCard.append(row);
    }
  }

  grid.append(acc, wrk, sto, resCard);
  container.append(grid);
}
