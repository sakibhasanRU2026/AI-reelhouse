import { btn, el, formatTimeClock } from "./dom.js";

export interface PreviewBlockLine {
  text: string;
  width: number;
  x: number;
  baselineY: number;
}

export interface PreviewPlacedBlock {
  id: string;
  kind: "captions" | "overlay_text";
  start: number;
  end: number;
  style: string;
  fontFamily?: string;
  fontWeight?: string;
  fontSize: number;
  textColor?: string;
  bgColor?: string;
  bgOpacity?: number;
  borderW: number;
  boxBorderW: number;
  shadow?: boolean;
  align?: string;
  lines: PreviewBlockLine[];
}

export interface PreviewLayoutPayload {
  targetWidth: number;
  targetHeight: number;
  reframeMode: "none" | "crop" | "pad" | "blur" | "manual_crop";
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  layout: {
    targetWidth: number;
    targetHeight: number;
    safeZone?: {
      topPct: number;
      bottomPct: number;
      leftPct: number;
      rightPct: number;
      label: string;
    };
    blocks: PreviewPlacedBlock[];
  };
}

export interface ManagedVideoPlayer {
  root: HTMLDivElement;
  getCurrentTime(): number;
  setStreamUrl(url: string | null, opts?: { autoplay?: boolean; resumeTime?: number; showTextOverlay?: boolean }): void;
  setLocalSourceUrl(url: string | null): void;
  setStatusOverlay(show: boolean, loading: boolean, text: string, onRetry?: () => void): void;
  setLayoutData(layout: PreviewLayoutPayload | null, showSafeZone: boolean, cropMode?: boolean): void;
  setAspectHint(w: number, h: number): void;
  destroy(): void;
}

function strokeShadow(bw: number, dropShadow?: boolean): string {
  const parts: string[] = [];
  if (bw > 0) {
    const d = Math.max(1, bw);
    parts.push(
      `${-d}px ${-d}px 0 #000`,
      `${d}px ${-d}px 0 #000`,
      `${-d}px ${d}px 0 #000`,
      `${d}px ${d}px 0 #000`,
      `0 ${-d}px 0 #000`,
      `0 ${d}px 0 #000`,
      `${-d}px 0 0 #000`,
      `${d}px 0 0 #000`
    );
  }
  if (dropShadow) {
    parts.push("2px 2px 4px rgba(0,0,0,0.75)");
  }
  return parts.length ? parts.join(",") : "none";
}

function fontFamilyCss(family?: string): string {
  if (family === "serif") return "'ReelhouseDejaVuSerif', Georgia, serif";
  if (family === "mono") return "'ReelhouseDejaVuMono', 'JetBrains Mono', monospace";
  return "'ReelhouseDejaVu', 'Plus Jakarta Sans', sans-serif";
}

export function createManagedVideoPlayer(opts: {
  emptyTitle?: string;
  emptySub?: string;
  onCaptureTimestamp?: (sec: number) => void;
  onStreamError?: () => void;
  maxPortraitWidth?: number;
}): ManagedVideoPlayer {
  const root = el("div", "player-wrap");
  const screen = el("div", "screen");
  const emptyBox = el("div", "empty");
  emptyBox.textContent = opts.emptyTitle || "No video selected";
  if (opts.emptySub) {
    emptyBox.append(document.createElement("br"), el("span", "small", opts.emptySub));
  }

  const stage = el("div", "preview-stage");
  stage.hidden = true;
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "metadata";

  const overlay = el("div", "preview-overlay");
  const safeZoneBox = el("div", "safe-zone-guide");
  safeZoneBox.hidden = true;
  stage.append(video, overlay, safeZoneBox);

  const statusOverlay = el("div", "preview-status");
  statusOverlay.hidden = true;
  const spinner = el("div", "pv-spinner");
  const statusText = el("div", "", "Loading video…");
  const retryBtn = btn("Retry stream", "btn");
  retryBtn.hidden = true;
  statusOverlay.append(spinner, statusText, retryBtn);

  screen.append(emptyBox, stage, statusOverlay);

  const bar = el("div", "player-bar");
  bar.hidden = true;
  const topRow = el("div", "player-top");
  const playBtn = btn("▶ Play", "mini vp-play");
  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "vp-seek";
  seek.min = "0";
  seek.max = "1000";
  seek.step = "1";
  seek.value = "0";
  seek.setAttribute("aria-label", "Seek video");
  const timeEl = el("span", "small muted vp-time", "0:00 / 0:00");
  topRow.append(playBtn, seek, timeEl);

  const bottomRow = el("div", "player-bottom");
  const volWrap = el("div", "vp-vol");
  const muteBtn = btn("🔊", "mini");
  muteBtn.setAttribute("aria-label", "Mute or unmute");
  const volRange = document.createElement("input");
  volRange.type = "range";
  volRange.min = "0";
  volRange.max = "1";
  volRange.step = "0.05";
  volRange.value = "1";
  volRange.setAttribute("aria-label", "Volume");
  volWrap.append(muteBtn, volRange);

  const rightWrap = el("div", "vp-right");
  let captureBtn: HTMLButtonElement | null = null;
  if (opts.onCaptureTimestamp) {
    captureBtn = btn("⏱ Capture time", "mini", () => {
      opts.onCaptureTimestamp?.(video.currentTime || 0);
    });
  }
  const speedSel = document.createElement("select");
  speedSel.className = "vp-speed";
  speedSel.setAttribute("aria-label", "Playback speed");
  for (const sp of ["0.5", "0.75", "1", "1.25", "1.5", "2"]) {
    const o = document.createElement("option");
    o.value = sp;
    o.textContent = `${sp}×`;
    if (sp === "1") o.selected = true;
    speedSel.append(o);
  }
  const fsBtn = btn("⛶ Fullscreen", "mini", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      root.requestFullscreen?.().catch(() => {});
    }
  });
  if (captureBtn) rightWrap.append(captureBtn);
  rightWrap.append(speedSel, fsBtn);
  bottomRow.append(volWrap, rightWrap);
  bar.append(topRow, bottomRow);
  root.append(screen, bar);

  let isSeeking = false;
  let lastVolume = 1;
  let lastSpeed = 1;
  let hasMedia = false;
  let mode: "local" | "stream" = "stream";
  let allowOverlay = false;
  let layoutData: PreviewLayoutPayload | null = null;
  let showSafeZone = false;
  let pendingResumeTime = 0;
  let pendingAutoplay = false;
  let retryHandler: (() => void) | undefined;

  const syncStageDims = (w: number, h: number) => {
    const maxW = opts.maxPortraitWidth || 440;
    screen.style.aspectRatio = `${w}/${h}`;
    if (h > w) {
      screen.style.maxWidth = `${Math.round((maxW * w) / h)}px`;
      screen.style.width = "100%";
    } else {
      screen.style.maxWidth = "100%";
      screen.style.width = "100%";
    }
  };

  const renderOverlay = () => {
    overlay.replaceChildren();
    safeZoneBox.replaceChildren();
    safeZoneBox.hidden = !showSafeZone || !hasMedia;

    if (showSafeZone && hasMedia) {
      const sz = layoutData?.layout?.safeZone || {
        topPct: 12,
        bottomPct: 22,
        leftPct: 6,
        rightPct: 14,
        label: "Social UI safe zone",
      };
      const inner = el("div", "safe-zone-inner");
      inner.style.top = `${sz.topPct}%`;
      inner.style.bottom = `${sz.bottomPct}%`;
      inner.style.left = `${sz.leftPct}%`;
      inner.style.right = `${sz.rightPct}%`;
      const tag = el("span", "safe-zone-label", sz.label);
      inner.append(tag);
      safeZoneBox.append(inner);
    }

    if (!allowOverlay || !hasMedia || !layoutData?.layout) return;
    const lay = layoutData.layout;
    const cw = overlay.clientWidth;
    if (!cw || !lay.targetWidth) return;
    const scale = cw / lay.targetWidth;
    const t = video.currentTime || 0;

    for (const b of lay.blocks) {
      if (t < b.start || t >= b.end) continue;
      for (const l of b.lines) {
        const lineEl = el("div", "pv-line", l.text);
        const fs = b.fontSize * scale;
        lineEl.style.fontSize = `${fs}px`;
        lineEl.style.fontFamily = fontFamilyCss(b.fontFamily);
        lineEl.style.fontWeight = b.fontWeight === "regular" ? "400" : "700";
        lineEl.style.color = b.textColor || (b.style === "bold-yellow" ? "#ffff00" : "#ffffff");
        const hasBox = (b.bgOpacity ?? 0) > 0.01 || b.style === "white-box";
        if (hasBox) {
          const pad = b.boxBorderW * scale;
          const alpha = typeof b.bgOpacity === "number" ? b.bgOpacity : 0.6;
          lineEl.style.backgroundColor = b.bgColor && b.bgColor !== "black"
            ? b.bgColor
            : `rgba(0,0,0,${alpha.toFixed(2)})`;
          lineEl.style.padding = `${pad}px ${pad}px`;
          lineEl.style.top = `${(l.baselineY - 0.928 * b.fontSize - b.boxBorderW) * scale}px`;
        } else {
          lineEl.style.textShadow = strokeShadow(b.borderW * scale, b.shadow);
          lineEl.style.top = `${(l.baselineY - 0.928 * b.fontSize) * scale}px`;
        }
        lineEl.style.left = `${l.x * scale}px`;
        lineEl.style.transform = "none";
        overlay.append(lineEl);
      }
    }
  };

  const syncBar = () => {
    bar.hidden = !hasMedia;
    if (!hasMedia) return;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const cur = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    playBtn.textContent = video.paused ? "▶ Play" : "⏸ Pause";
    if (!isSeeking) {
      seek.value = dur > 0 ? String(Math.round((cur / dur) * 1000)) : "0";
    }
    timeEl.textContent = `${formatTimeClock(cur)} / ${formatTimeClock(dur)}`;
    muteBtn.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
    volRange.value = String(video.muted ? 0 : video.volume);
    speedSel.value = String(video.playbackRate || lastSpeed);
  };

  const togglePlay = () => {
    if (!hasMedia) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  playBtn.onclick = togglePlay;
  video.onclick = togglePlay;
  seek.oninput = () => {
    isSeeking = true;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (dur > 0) {
      const target = (Number(seek.value) / 1000) * dur;
      video.currentTime = target;
      timeEl.textContent = `${formatTimeClock(target)} / ${formatTimeClock(dur)}`;
      renderOverlay();
    }
  };
  seek.onchange = () => {
    isSeeking = false;
    syncBar();
  };
  muteBtn.onclick = () => {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = lastVolume > 0 ? lastVolume : 1;
      lastVolume = video.volume;
    } else {
      video.muted = true;
    }
    syncBar();
  };
  volRange.oninput = () => {
    const val = Number(volRange.value);
    lastVolume = val;
    video.volume = val;
    video.muted = val === 0;
    syncBar();
  };
  speedSel.onchange = () => {
    lastSpeed = Number(speedSel.value) || 1;
    video.playbackRate = lastSpeed;
    syncBar();
  };

  video.onloadedmetadata = () => {
    if (pendingResumeTime > 0 && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(pendingResumeTime, Math.max(0, video.duration - 0.1));
      pendingResumeTime = 0;
    }
    if (!layoutData || !allowOverlay) {
      if (video.videoWidth && video.videoHeight) {
        syncStageDims(video.videoWidth, video.videoHeight);
      }
    }
    renderOverlay();
    syncBar();
  };
  video.onloadeddata = () => {
    statusOverlay.hidden = true;
    if (pendingAutoplay) {
      pendingAutoplay = false;
      video.play().catch(() => {});
    }
    syncBar();
  };
  video.oncanplay = () => {
    if (!video.error) statusOverlay.hidden = true;
    syncBar();
  };
  video.onwaiting = () => {
    if (hasMedia && mode === "stream") {
      spinner.hidden = false;
      retryBtn.hidden = true;
      statusText.textContent = "Buffering video…";
      statusOverlay.hidden = false;
    }
  };
  video.onplaying = () => {
    statusOverlay.hidden = true;
    syncBar();
  };
  video.onplay = syncBar;
  video.onpause = syncBar;
  video.onended = syncBar;
  video.onvolumechange = syncBar;
  video.onratechange = syncBar;
  video.ontimeupdate = () => {
    renderOverlay();
    syncBar();
  };
  video.onseeked = () => {
    renderOverlay();
    syncBar();
  };
  video.onerror = () => {
    if (!hasMedia) return;
    if (opts.onStreamError) {
      opts.onStreamError();
    } else {
      spinner.hidden = true;
      statusText.textContent = "Unable to play video stream.";
      retryBtn.hidden = !retryHandler;
      statusOverlay.hidden = false;
    }
  };
  retryBtn.onclick = () => retryHandler?.();

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(renderOverlay);
    ro.observe(overlay);
  }

  return {
    root,
    getCurrentTime: () => (Number.isFinite(video.currentTime) ? video.currentTime : 0),
    setStreamUrl(url, playOpts) {
      mode = "stream";
      allowOverlay = Boolean(playOpts?.showTextOverlay);
      if (!url) {
        hasMedia = false;
        video.pause();
        video.removeAttribute("src");
        video.load();
        stage.hidden = true;
        emptyBox.hidden = false;
        statusOverlay.hidden = true;
        syncBar();
        return;
      }
      hasMedia = true;
      emptyBox.hidden = true;
      stage.hidden = false;
      stage.classList.remove("crop");
      pendingResumeTime = Number(playOpts?.resumeTime) || 0;
      pendingAutoplay = Boolean(playOpts?.autoplay);
      video.preload = "auto";
      video.volume = lastVolume;
      video.muted = lastVolume === 0;
      video.playbackRate = lastSpeed;
      video.src = url;
      video.load();
      renderOverlay();
      syncBar();
    },
    setLocalSourceUrl(url) {
      mode = "local";
      allowOverlay = true;
      if (!url) {
        hasMedia = false;
        video.pause();
        video.removeAttribute("src");
        video.load();
        stage.hidden = true;
        emptyBox.hidden = false;
        statusOverlay.hidden = true;
        syncBar();
        return;
      }
      hasMedia = true;
      emptyBox.hidden = true;
      stage.hidden = false;
      statusOverlay.hidden = true;
      video.preload = "metadata";
      video.volume = lastVolume;
      video.muted = lastVolume === 0;
      video.playbackRate = lastSpeed;
      video.src = url;
      video.load();
      renderOverlay();
      syncBar();
    },
    setStatusOverlay(show, loading, text, onRetry) {
      statusOverlay.hidden = !show;
      spinner.hidden = !loading;
      statusText.textContent = text;
      retryHandler = onRetry;
      retryBtn.hidden = !onRetry;
    },
    setLayoutData(layout, safeZone, cropMode) {
      layoutData = layout;
      showSafeZone = safeZone;
      if (allowOverlay && layout) {
        syncStageDims(layout.targetWidth, layout.targetHeight);
        stage.classList.toggle("crop", Boolean(cropMode));
      }
      renderOverlay();
    },
    setAspectHint(w, h) {
      syncStageDims(w, h);
    },
    destroy() {
      ro?.disconnect();
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
}
