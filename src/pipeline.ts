import fs from "node:fs";
import path from "node:path";
import { Settings } from "./config.js";
import { MediaError, ProbeInfo, detectScenes, probe, runFfmpeg } from "./media.js";
import {
  AspectRatio,
  AudioAdjustOp,
  Captions,
  CutRange,
  FadeOp,
  Instructions,
  MergeClipsOp,
  Operation,
  OverlayText,
  Reframe,
  ResolutionPreset,
  ShortenSegment,
  SpeedOp,
  TrimRange,
} from "./schemas.js";
import {
  LayoutRegion,
  PlacedTextBlock,
  TextInputItem,
  TextLayoutResult,
  layoutTextBlocks,
} from "./textLayout.js";

const ENC = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "160k",
  "-movflags",
  "+faststart",
];

const t3 = (x: number): string => x.toFixed(3);

export type AssetPathResolver = (assetId: string) => string | null;

const DIMS: Record<ResolutionPreset, Record<AspectRatio, [number, number]>> = {
  export_1080p: {
    "9:16": [1080, 1920],
    "16:9": [1920, 1080],
    "1:1": [1080, 1080],
    "4:5": [1080, 1350],
  },
  preview_720p: {
    "9:16": [720, 1280],
    "16:9": [1280, 720],
    "1:1": [720, 720],
    "4:5": [720, 900],
  },
};

export function targetDimensions(
  aspect: AspectRatio,
  preset: ResolutionPreset = "export_1080p"
): [number, number] {
  return DIMS[preset]?.[aspect] || DIMS.export_1080p["9:16"];
}

class Step {
  constructor(
    readonly s: Settings,
    readonly cb: (fraction: number) => void,
    readonly cwd: string
  ) {}

  async run(args: string[], expected: number): Promise<void> {
    await runFfmpeg(args, expected, this.cb, this.s.ffmpegTimeoutS, this.cwd);
  }
}

async function removeRange(
  step: Step,
  src: string,
  dst: string,
  a: number,
  b: number,
  info: ProbeInfo
): Promise<void> {
  const total = info.duration;
  if (a >= total - 0.01) {
    throw new MediaError(
      `Range start ${a.toFixed(2)}s is at or beyond the video duration ${total.toFixed(2)}s`
    );
  }
  const endB = Math.min(b, total);
  const keeps: Array<[number, number]> = [];
  if (a > 0.01) {
    keeps.push([0.0, a]);
  }
  if (endB < total - 0.01) {
    keeps.push([endB, total]);
  }
  if (keeps.length === 0) {
    throw new MediaError("That cut would remove the entire video");
  }

  const audio = info.has_audio;
  const parts: string[] = [];
  keeps.forEach(([s, e], i) => {
    parts.push(`[0:v]trim=start=${t3(s)}:end=${t3(e)},setpts=PTS-STARTPTS[v${i}]`);
    if (audio) {
      parts.push(`[0:a]atrim=start=${t3(s)}:end=${t3(e)},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });

  let vl: string;
  let al: string;
  if (keeps.length === 1) {
    vl = "[v0]";
    al = "[a0]";
  } else {
    const ins = keeps
      .map((_, i) => (audio ? `[v${i}][a${i}]` : `[v${i}]`))
      .join("");
    parts.push(
      `${ins}concat=n=${keeps.length}:v=1:a=${audio ? 1 : 0}[v]` +
        (audio ? "[a]" : "")
    );
    vl = "[v]";
    al = "[a]";
  }

  const maps = ["-map", vl, ...(audio ? ["-map", al] : [])];
  const expected = keeps.reduce((acc, [s, e]) => acc + (e - s), 0);
  await step.run(
    ["-i", src, "-filter_complex", parts.join(";"), ...maps, ...ENC, dst],
    expected
  );
}

async function trimRange(
  step: Step,
  op: TrimRange,
  src: string,
  dst: string,
  info: ProbeInfo
): Promise<void> {
  const total = info.duration;
  const start = Math.max(0, Math.min(op.start, total - 0.05));
  const end = Math.min(op.end, total);
  if (end <= start + 0.02) {
    throw new MediaError("Trim range results in an empty video.");
  }
  const audio = info.has_audio;
  const parts = [`[0:v]trim=start=${t3(start)}:end=${t3(end)},setpts=PTS-STARTPTS[v]`];
  if (audio) {
    parts.push(`[0:a]atrim=start=${t3(start)}:end=${t3(end)},asetpts=PTS-STARTPTS[a]`);
  }
  const maps = ["-map", "[v]", ...(audio ? ["-map", "[a]"] : [])];
  await step.run(
    ["-i", src, "-filter_complex", parts.join(";"), ...maps, ...ENC, dst],
    end - start
  );
}

async function shorten(
  step: Step,
  op: ShortenSegment,
  src: string,
  dst: string,
  info: ProbeInfo
): Promise<void> {
  const total = info.duration;
  const tgt = op.target_duration_s;
  const keep = op.keep || (op.segment === "intro" ? "last" : "first");
  let a: number;
  let b: number;

  if (op.segment === "intro") {
    let end = op.segment_end_s;
    if (end == null) {
      const scenes = (
        await detectScenes(src, op.scene_threshold, step.s.ffmpegTimeoutS)
      ).filter((t) => t >= 0.2);
      if (scenes.length === 0) {
        throw new MediaError(
          "Could not detect where the intro ends (no scene change found). Provide segment_end_s."
        );
      }
      end = scenes[0];
    }
    end = Math.min(end, total);
    if (end <= tgt + 0.01) {
      throw new MediaError(
        `The intro is ${end.toFixed(2)}s, which is not longer than the target ${tgt.toFixed(2)}s; nothing to trim`
      );
    }
    [a, b] = keep === "last" ? [0.0, end - tgt] : [tgt, end];
  } else {
    let start = op.segment_start_s;
    if (start == null) {
      const scenes = await detectScenes(
        src,
        op.scene_threshold,
        step.s.ffmpegTimeoutS
      );
      if (scenes.length === 0) {
        throw new MediaError(
          "Could not detect where the outro starts (no scene change found). Provide segment_start_s."
        );
      }
      start = scenes[scenes.length - 1];
    }
    if (total - start <= tgt + 0.01) {
      throw new MediaError(
        `The outro is ${(total - start).toFixed(2)}s, which is not longer than the target ${tgt.toFixed(2)}s; nothing to trim`
      );
    }
    [a, b] = keep === "first" ? [start + tgt, total] : [start, total - tgt];
  }

  await removeRange(step, src, dst, a, b, info);
}

async function reframe(
  step: Step,
  op: Reframe,
  src: string,
  dst: string,
  info: ProbeInfo,
  defaultPreset: ResolutionPreset
): Promise<void> {
  const preset = op.resolution_preset || defaultPreset;
  const [tw, th] = targetDimensions(op.aspect, preset);
  const audioMaps = info.has_audio ? ["-map", "0:a:0"] : [];

  if (op.mode === "blur") {
    const fc =
      `[0:v:0]split=2[bg][fg];` +
      `[bg]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},boxblur=luma_radius=24:luma_power=2,setsar=1[bgblur];` +
      `[fg]scale=${tw}:${th}:force_original_aspect_ratio=decrease,setsar=1[fgscaled];` +
      `[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout]`;
    await step.run(
      ["-i", src, "-filter_complex", fc, "-map", "[vout]", ...audioMaps, ...ENC, dst],
      info.duration
    );
    return;
  }

  if (op.mode === "manual_crop") {
    const cx = typeof op.crop_x === "number" ? op.crop_x : 0.5;
    const cy = typeof op.crop_y === "number" ? op.crop_y : 0.5;
    const vf = `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th}:x='(iw-ow)*${cx.toFixed(
      4
    )}':y='(ih-oh)*${cy.toFixed(4)}',setsar=1`;
    await step.run(
      ["-i", src, "-vf", vf, "-map", "0:v:0", ...audioMaps, ...ENC, dst],
      info.duration
    );
    return;
  }

  const vf =
    op.mode === "crop"
      ? `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},setsar=1`
      : `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  await step.run(
    ["-i", src, "-vf", vf, "-map", "0:v:0", ...audioMaps, ...ENC, dst],
    info.duration
  );
}

function buildAtempoChain(factor: number): string {
  const filters: string[] = [];
  let rem = factor;
  while (rem > 2.0) {
    filters.push("atempo=2.0");
    rem /= 2.0;
  }
  while (rem < 0.5) {
    filters.push("atempo=0.5");
    rem /= 0.5;
  }
  filters.push(`atempo=${rem.toFixed(4)}`);
  return filters.join(",");
}

async function applySpeed(
  step: Step,
  op: SpeedOp,
  src: string,
  dst: string,
  info: ProbeInfo
): Promise<void> {
  const f = op.factor;
  const vf = `[0:v:0]setpts=PTS/${f.toFixed(4)}[vout]`;
  if (info.has_audio) {
    const af = `[0:a:0]${buildAtempoChain(f)}[aout]`;
    await step.run(
      ["-i", src, "-filter_complex", `${vf};${af}`, "-map", "[vout]", "-map", "[aout]", ...ENC, dst],
      info.duration / f
    );
  } else {
    await step.run(
      ["-i", src, "-filter_complex", vf, "-map", "[vout]", ...ENC, dst],
      info.duration / f
    );
  }
}

async function applyAudioAdjust(
  step: Step,
  op: AudioAdjustOp,
  src: string,
  dst: string,
  info: ProbeInfo
): Promise<void> {
  if (!info.has_audio) {
    await step.run(["-i", src, "-map", "0:v:0", ...ENC, dst], info.duration);
    return;
  }
  if (op.mute || op.volume === 0) {
    await step.run(["-i", src, "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", dst], info.duration);
    return;
  }
  await step.run(
    [
      "-i",
      src,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-af",
      `volume=${op.volume.toFixed(3)}`,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      dst,
    ],
    info.duration
  );
}

async function applyFade(
  step: Step,
  op: FadeOp,
  src: string,
  dst: string,
  info: ProbeInfo
): Promise<void> {
  const vFilters: string[] = [];
  const aFilters: string[] = [];
  if (op.fade_in_s > 0) {
    const d = Math.min(op.fade_in_s, Math.max(0.1, info.duration / 2));
    vFilters.push(`fade=t=in:st=0:d=${t3(d)}`);
    aFilters.push(`afade=t=in:st=0:d=${t3(d)}`);
  }
  if (op.fade_out_s > 0) {
    const d = Math.min(op.fade_out_s, Math.max(0.1, info.duration / 2));
    const st = Math.max(0, info.duration - d);
    vFilters.push(`fade=t=out:st=${t3(st)}:d=${t3(d)}`);
    aFilters.push(`afade=t=out:st=${t3(st)}:d=${t3(d)}`);
  }
  const fcParts = [`[0:v:0]${vFilters.join(",")}[vout]`];
  if (info.has_audio && aFilters.length > 0) {
    fcParts.push(`[0:a:0]${aFilters.join(",")}[aout]`);
  }
  const maps = ["-map", "[vout]", ...(info.has_audio ? ["-map", "[aout]"] : [])];
  await step.run(
    ["-i", src, "-filter_complex", fcParts.join(";"), ...maps, ...ENC, dst],
    info.duration
  );
}

async function mergeClips(
  step: Step,
  op: MergeClipsOp,
  src: string,
  dst: string,
  info: ProbeInfo,
  resolveAsset?: AssetPathResolver
): Promise<void> {
  if (!resolveAsset) {
    throw new MediaError("Asset resolver is required for merge_clips.");
  }
  const extraPaths: string[] = [];
  for (const id of op.asset_ids) {
    const p = resolveAsset(id);
    if (!p || !fs.existsSync(p)) {
      throw new MediaError(
        `Clip asset "${id}" is not available on temporary storage. Please re-upload it.`
      );
    }
    extraPaths.push(p);
  }

  const allInputs = [src, ...extraPaths];
  const probes = [info, ...(await Promise.all(extraPaths.map((p) => probe(p))))];
  const totalDur = probes.reduce((acc, p) => acc + p.duration, 0);
  if (totalDur > step.s.maxDurationS) {
    throw new MediaError(
      `Combined merged duration (${totalDur.toFixed(1)}s) exceeds server limit (${step.s.maxDurationS}s).`
    );
  }
  const anyAudio = probes.some((p) => p.has_audio);
  const w = Math.max(16, info.width || 1080);
  const h = Math.max(16, info.height || 1920);
  const parts: string[] = [];
  const inputsArgs: string[] = [];

  allInputs.forEach((p, idx) => {
    inputsArgs.push("-i", p);
    parts.push(
      `[${idx}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p[v${idx}]`
    );
    if (anyAudio) {
      if (probes[idx].has_audio) {
        parts.push(`[${idx}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${idx}]`);
      } else {
        parts.push(
          `anullsrc=r=48000:cl=stereo:d=${t3(probes[idx].duration)}[a${idx}]`
        );
      }
    }
  });

  const concatIn = allInputs
    .map((_, i) => (anyAudio ? `[v${i}][a${i}]` : `[v${i}]`))
    .join("");
  parts.push(
    `${concatIn}concat=n=${allInputs.length}:v=1:a=${anyAudio ? 1 : 0}[vout]` +
      (anyAudio ? "[aout]" : "")
  );

  const maps = ["-map", "[vout]", ...(anyAudio ? ["-map", "[aout]"] : [])];
  await step.run(
    [...inputsArgs, "-filter_complex", parts.join(";"), ...maps, ...ENC, dst],
    totalDur
  );
}

function collectTextItems(ops: Array<OverlayText | Captions>): TextInputItem[] {
  const items: TextInputItem[] = [];
  let order = 0;
  for (let opIdx = 0; opIdx < ops.length; opIdx++) {
    const op = ops[opIdx];
    if (op.op === "overlay_text") {
      items.push({
        id: `op_${opIdx}_0`,
        kind: "overlay_text",
        orderIndex: order++,
        text: op.text,
        start: op.at,
        end: op.at + op.duration,
        style: op.style,
        maxWordsPerLine: op.max_words_per_line,
        fontFamily: op.font_family,
        fontWeight: op.font_weight,
        fontSizeScale: op.font_size_scale,
        textColor: op.text_color,
        bgColor: op.bg_color,
        bgOpacity: op.bg_opacity,
        outlineWidth: op.outline_width,
        shadow: op.shadow,
        align: op.align,
        lineSpacing: op.line_spacing,
        positionPreset: op.position_preset,
        xPct: op.x_pct,
        yPct: op.y_pct,
      });
    } else {
      for (let segIdx = 0; segIdx < (op.segments || []).length; segIdx++) {
        const seg = op.segments![segIdx];
        items.push({
          id: `op_${opIdx}_${segIdx}`,
          kind: "captions",
          orderIndex: order++,
          text: seg.text,
          start: seg.start,
          end: seg.end,
          style: op.style,
          maxWordsPerLine: op.max_words_per_line,
          fontFamily: op.font_family,
          fontWeight: op.font_weight,
          fontSizeScale: op.font_size_scale,
          textColor: op.text_color,
          bgColor: op.bg_color,
          bgOpacity: op.bg_opacity,
          outlineWidth: op.outline_width,
          shadow: op.shadow,
          align: op.align,
          lineSpacing: op.line_spacing,
          positionPreset: op.position_preset,
          xPct: op.x_pct,
          yPct: op.y_pct,
        });
      }
    }
  }
  return items;
}

function drawtextLineFilter(
  textfile: string,
  block: PlacedTextBlock,
  xPos: number,
  baselineY: number
): string {
  const parts: string[] = [
    `fontfile=${block.fontPath}`,
    `textfile=${textfile}`,
    "expansion=none",
    `fontsize=${block.fontSize}`,
    `fontcolor=${block.textColor}`,
  ];

  if (block.bgOpacity > 0.01) {
    parts.push("box=1");
    parts.push(`boxcolor=${block.bgColor}@${block.bgOpacity.toFixed(2)}`);
    parts.push(`boxborderw=${block.boxBorderW}`);
  } else if (block.borderW > 0) {
    parts.push(`borderw=${block.borderW}`);
    parts.push("bordercolor=black");
  }

  if (block.shadow) {
    parts.push("shadowcolor=black@0.75");
    parts.push("shadowx=2");
    parts.push("shadowy=2");
  }

  parts.push(`x=${xPos}`);
  parts.push(`y=${baselineY}-max_glyph_a`);
  parts.push(`enable='gte(t,${t3(block.start)})*lt(t,${t3(block.end)})'`);
  return `drawtext=${parts.join(":")}`;
}

function computeFutureReframeRegion(
  curW: number,
  curH: number,
  remainingOps: Operation[],
  defaultPreset: ResolutionPreset
): LayoutRegion | undefined {
  const nextReframe = remainingOps.find((o): o is Reframe => o.op === "reframe");
  if (!nextReframe) return undefined;

  const [tw, th] = targetDimensions(
    nextReframe.aspect,
    nextReframe.resolution_preset || defaultPreset
  );
  const targetAspect = tw / th;
  const curAspect = curW / curH;

  if (nextReframe.mode === "crop" || nextReframe.mode === "manual_crop") {
    const cx = typeof nextReframe.crop_x === "number" ? nextReframe.crop_x : 0.5;
    const cy = typeof nextReframe.crop_y === "number" ? nextReframe.crop_y : 0.5;
    if (curAspect > targetAspect) {
      const survivingW = Math.floor(curH * targetAspect);
      return {
        xOffset: Math.floor((curW - survivingW) * cx),
        yOffset: 0,
        width: survivingW,
        height: curH,
        referenceWidth: tw,
        referenceHeight: th,
      };
    }
    const survivingH = Math.floor(curW / targetAspect);
    return {
      xOffset: 0,
      yOffset: Math.floor((curH - survivingH) * cy),
      width: curW,
      height: survivingH,
      referenceWidth: tw,
      referenceHeight: th,
    };
  }

  return {
    xOffset: 0,
    yOffset: 0,
    width: curW,
    height: curH,
    referenceWidth: tw,
    referenceHeight: th,
  };
}

async function renderTextBatch(
  step: Step,
  ops: Array<OverlayText | Captions>,
  src: string,
  dst: string,
  info: ProbeInfo,
  batchIdx: number,
  region?: LayoutRegion
): Promise<void> {
  const font = step.s.fontPath;
  if (!/^[\w./-]+$/.test(font) || !fs.existsSync(font) || !fs.statSync(font).isFile()) {
    throw new MediaError(
      `Caption font not found or has unsupported characters in its path: ${font}. Set FONT_PATH.`
    );
  }

  const items = collectTextItems(ops);
  for (const item of items) {
    if (item.start >= info.duration) {
      throw new MediaError(
        `A caption starts at ${item.start.toFixed(2)}s but the video is only ${info.duration.toFixed(2)}s long`
      );
    }
  }

  const layout = layoutTextBlocks(items, font, info.width, info.height, region);
  const filters: string[] = [];

  layout.blocks.forEach((block, bIdx) => {
    block.lines.forEach((line, lIdx) => {
      const name = `cap_${batchIdx}_${bIdx}_${lIdx}.txt`;
      fs.writeFileSync(path.join(step.cwd, name), line.text, "utf-8");
      filters.push(drawtextLineFilter(name, block, line.x, line.baselineY));
    });
  });

  if (filters.length === 0) {
    const maps = ["-map", "0:v:0", ...(info.has_audio ? ["-map", "0:a:0"] : [])];
    await step.run(["-i", src, ...maps, ...ENC, dst], info.duration);
    return;
  }

  const filterScriptName = `filter_${batchIdx}.txt`;
  fs.writeFileSync(path.join(step.cwd, filterScriptName), filters.join(","), "utf-8");
  const maps = ["-map", "0:v:0", ...(info.has_audio ? ["-map", "0:a:0"] : [])];
  await step.run(
    ["-i", src, "-filter_script:v", filterScriptName, ...maps, ...ENC, dst],
    info.duration
  );
}

function isTextOp(op: Operation): op is OverlayText | Captions {
  return op.op === "overlay_text" || op.op === "captions";
}

type SingleOp =
  | ShortenSegment
  | CutRange
  | TrimRange
  | Reframe
  | SpeedOp
  | AudioAdjustOp
  | FadeOp
  | MergeClipsOp;

type PlannedStep =
  | { kind: "single"; op: SingleOp }
  | { kind: "text_batch"; ops: Array<OverlayText | Captions>; remainingAfter: Operation[] };

function buildExecutionPlan(operations: Operation[]): PlannedStep[] {
  const normalized: Operation[] = [];
  let i = 0;
  while (i < operations.length) {
    const op = operations[i];
    if (isTextOp(op)) {
      const textBuffer: Array<OverlayText | Captions> = [];
      const reframeBuffer: Reframe[] = [];
      let j = i;
      while (j < operations.length && (isTextOp(operations[j]) || operations[j].op === "reframe")) {
        const cur = operations[j];
        if (cur.op === "reframe") {
          reframeBuffer.push(cur);
        } else if (isTextOp(cur)) {
          textBuffer.push(cur);
        }
        j++;
      }
      if (reframeBuffer.length > 0) {
        normalized.push(...reframeBuffer, ...textBuffer);
      } else {
        normalized.push(...textBuffer);
      }
      i = j;
    } else {
      normalized.push(op);
      i++;
    }
  }

  const steps: PlannedStep[] = [];
  let k = 0;
  while (k < normalized.length) {
    const cur = normalized[k];
    if (isTextOp(cur)) {
      const batch: Array<OverlayText | Captions> = [cur];
      k++;
      while (k < normalized.length && isTextOp(normalized[k])) {
        batch.push(normalized[k] as OverlayText | Captions);
        k++;
      }
      steps.push({
        kind: "text_batch",
        ops: batch,
        remainingAfter: normalized.slice(k),
      });
    } else {
      steps.push({ kind: "single", op: cur as SingleOp });
      k++;
    }
  }

  return steps;
}

export async function render(
  src: string,
  jobDir: string,
  ins: Instructions,
  settings: Settings,
  progress: (fraction: number) => void,
  resolveAsset?: AssetPathResolver
): Promise<string> {
  const defaultPreset: ResolutionPreset = ins.resolution_preset || "export_1080p";
  const steps = buildExecutionPlan(ins.operations);
  const n = steps.length;
  let cur = src;
  let info = await probe(src);

  for (let i = 0; i < n; i++) {
    const planStep = steps[i];
    const dst = path.join(jobDir, `step${i}.mp4`);
    const step = new Step(
      settings,
      (f) => progress(((i + f) / n) * 0.97),
      jobDir
    );

    if (planStep.kind === "single") {
      const op = planStep.op;
      if (op.op === "shorten_segment") {
        await shorten(step, op, cur, dst, info);
      } else if (op.op === "cut_range") {
        await removeRange(step, cur, dst, op.start, op.end, info);
      } else if (op.op === "trim_range") {
        await trimRange(step, op, cur, dst, info);
      } else if (op.op === "reframe") {
        await reframe(step, op, cur, dst, info, defaultPreset);
      } else if (op.op === "speed") {
        await applySpeed(step, op, cur, dst, info);
      } else if (op.op === "audio_adjust") {
        await applyAudioAdjust(step, op, cur, dst, info);
      } else if (op.op === "fade") {
        await applyFade(step, op, cur, dst, info);
      } else if (op.op === "merge_clips") {
        await mergeClips(step, op, cur, dst, info, resolveAsset);
      }
    } else {
      const region = computeFutureReframeRegion(
        info.width,
        info.height,
        planStep.remainingAfter,
        defaultPreset
      );
      await renderTextBatch(step, planStep.ops, cur, dst, info, i, region);
    }

    info = await probe(dst);
    if (cur !== src) {
      fs.rmSync(cur, { force: true });
    }
    cur = dst;
  }

  const finalPath = path.join(jobDir, "output.mp4");
  fs.renameSync(cur, finalPath);
  for (const entry of fs.readdirSync(jobDir)) {
    if ((entry.startsWith("cap_") || entry.startsWith("filter_")) && entry.endsWith(".txt")) {
      fs.rmSync(path.join(jobDir, entry), { force: true });
    }
  }
  return finalPath;
}

export interface PreviewLayoutResponse {
  targetWidth: number;
  targetHeight: number;
  reframeMode: "none" | "crop" | "pad" | "blur" | "manual_crop";
  aspect: AspectRatio;
  layout: TextLayoutResult;
}

export function computePreviewLayout(
  srcWidth: number,
  srcHeight: number,
  operations: Operation[],
  fontPath: string,
  defaultPreset: ResolutionPreset = "export_1080p"
): PreviewLayoutResponse {
  const steps = buildExecutionPlan(operations);
  let curW = Math.max(16, Math.round(srcWidth || 1080));
  let curH = Math.max(16, Math.round(srcHeight || 1920));
  let reframeMode: PreviewLayoutResponse["reframeMode"] = "none";
  let aspect: AspectRatio = curH >= curW ? "9:16" : "16:9";

  let lastLayout: TextLayoutResult | null = null;
  let lastRegion: LayoutRegion | undefined;

  for (const st of steps) {
    if (st.kind === "single") {
      if (st.op.op === "reframe") {
        const [tw, th] = targetDimensions(
          st.op.aspect,
          st.op.resolution_preset || defaultPreset
        );
        curW = tw;
        curH = th;
        reframeMode = st.op.mode;
        aspect = st.op.aspect;
      }
    } else {
      const items = collectTextItems(st.ops);
      lastRegion = computeFutureReframeRegion(
        curW,
        curH,
        st.remainingAfter,
        defaultPreset
      );
      lastLayout = layoutTextBlocks(items, fontPath, curW, curH, lastRegion);
    }
  }

  if (!lastLayout) {
    lastLayout = layoutTextBlocks([], fontPath, curW, curH);
  }

  return {
    targetWidth: curW,
    targetHeight: curH,
    reframeMode,
    aspect,
    layout: lastLayout,
  };
}
