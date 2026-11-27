import { z } from "zod";

export const SUPPORTED_OPS = new Set([
  "shorten_segment",
  "cut_range",
  "trim_range",
  "reframe",
  "speed",
  "audio_adjust",
  "fade",
  "merge_clips",
  "overlay_text",
  "captions",
]);

export class InstructionError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message || body.error || "InstructionError"));
    this.status = status;
    this.body = body;
  }
}

const StyleSchema = z.enum(["bold-yellow", "white-box", "plain"]);
const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1", "4:5"]);
const ReframeModeSchema = z.enum(["crop", "pad", "blur", "manual_crop"]);
const ResolutionPresetSchema = z.enum(["export_1080p", "preview_720p"]);
const FontFamilySchema = z.enum(["sans", "serif", "mono"]);
const FontWeightSchema = z.enum(["regular", "bold"]);
const TextAlignSchema = z.enum(["left", "center", "right"]);
const PositionPresetSchema = z.enum(["auto", "top", "middle", "bottom", "custom"]);
const ColorStringSchema = z
  .string()
  .min(1)
  .max(24)
  .regex(/^(#[0-9a-fA-F]{6}|[a-zA-Z]{3,16})$/, "Use a color name or #RRGGBB hex");

const ShortenSegmentSchema = z
  .object({
    op: z.literal("shorten_segment"),
    segment: z.enum(["intro", "outro"]),
    target_duration_s: z.number().gt(0).lte(3600),
    segment_end_s: z.number().gte(0).nullable().optional(),
    segment_start_s: z.number().gte(0).nullable().optional(),
    detect: z.literal("scene_change").default("scene_change"),
    keep: z.enum(["first", "last"]).nullable().optional(),
    scene_threshold: z.number().gte(0.05).lte(0.95).default(0.4),
  })
  .strict();

const CutRangeSchema = z
  .object({
    op: z.literal("cut_range"),
    start: z.number().gte(0),
    end: z.number().gt(0),
  })
  .strict();

const TrimRangeSchema = z
  .object({
    op: z.literal("trim_range"),
    start: z.number().gte(0),
    end: z.number().gt(0),
  })
  .strict();

const ReframeSchema = z
  .object({
    op: z.literal("reframe"),
    aspect: AspectRatioSchema.default("9:16"),
    mode: ReframeModeSchema.default("crop"),
    crop_x: z.number().gte(0).lte(1).optional(),
    crop_y: z.number().gte(0).lte(1).optional(),
    resolution_preset: ResolutionPresetSchema.optional(),
  })
  .strict();

const SpeedSchema = z
  .object({
    op: z.literal("speed"),
    factor: z.number().gte(0.25).lte(4.0),
  })
  .strict();

const AudioAdjustSchema = z
  .object({
    op: z.literal("audio_adjust"),
    volume: z.number().gte(0).lte(3.0).default(1.0),
    mute: z.boolean().default(false),
  })
  .strict();

const FadeSchema = z
  .object({
    op: z.literal("fade"),
    fade_in_s: z.number().gte(0).lte(10).default(0),
    fade_out_s: z.number().gte(0).lte(10).default(0),
  })
  .strict();

const MergeClipsSchema = z
  .object({
    op: z.literal("merge_clips"),
    asset_ids: z
      .array(z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/))
      .min(1)
      .max(5),
  })
  .strict();

const TextStyleFields = {
  style: StyleSchema.default("bold-yellow"),
  max_words_per_line: z.number().int().gte(1).lte(12).default(4),
  font_family: FontFamilySchema.optional(),
  font_weight: FontWeightSchema.optional(),
  font_size_scale: z.number().gte(0.5).lte(2.0).optional(),
  text_color: ColorStringSchema.optional(),
  bg_color: ColorStringSchema.optional(),
  bg_opacity: z.number().gte(0).lte(1).optional(),
  outline_width: z.number().int().gte(0).lte(12).optional(),
  shadow: z.boolean().optional(),
  align: TextAlignSchema.optional(),
  line_spacing: z.number().gte(1.0).lte(2.0).optional(),
  position_preset: PositionPresetSchema.optional(),
  x_pct: z.number().gte(0.05).lte(0.95).optional(),
  y_pct: z.number().gte(0.08).lte(0.92).optional(),
};

const OverlayTextSchema = z
  .object({
    op: z.literal("overlay_text"),
    text: z.string().min(1).max(200),
    at: z.number().gte(0),
    duration: z.number().gt(0).lte(60),
    ...TextStyleFields,
  })
  .strict();

const CaptionSegmentSchema = z
  .object({
    start: z.number().gte(0),
    end: z.number().gt(0),
    text: z.string().min(1).max(200),
  })
  .strict();

const CaptionsSchema = z
  .object({
    op: z.literal("captions"),
    source: z.enum(["manual", "auto_transcribe"]),
    ...TextStyleFields,
    segments: z.array(CaptionSegmentSchema).max(200).nullable().optional(),
  })
  .strict();

const OperationSchema = z.discriminatedUnion("op", [
  ShortenSegmentSchema,
  CutRangeSchema,
  TrimRangeSchema,
  ReframeSchema,
  SpeedSchema,
  AudioAdjustSchema,
  FadeSchema,
  MergeClipsSchema,
  OverlayTextSchema,
  CaptionsSchema,
]);

const InstructionsSchema = z
  .object({
    schema_version: z.literal("1.0"),
    video_id: z.string().max(100).nullable().optional(),
    base_version: z.string().max(100).nullable().optional(),
    reviewer_comment: z.string().max(2000).nullable().optional(),
    comment_timestamp_s: z.number().gte(0).nullable().optional(),
    resolution_preset: ResolutionPresetSchema.optional(),
    operations: z.array(OperationSchema).min(1).max(20),
  })
  .strict()
  .superRefine((val, ctx) => {
    val.operations.forEach((op, idx) => {
      if (op.op === "shorten_segment") {
        if (op.segment === "intro" && op.segment_start_s != null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", idx, "segment_start_s"],
            message: "segment_start_s is only valid for segment='outro'",
          });
        }
        if (op.segment === "outro" && op.segment_end_s != null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", idx, "segment_end_s"],
            message: "segment_end_s is only valid for segment='intro'; use segment_start_s for the outro",
          });
        }
      } else if (op.op === "cut_range" || op.op === "trim_range") {
        if (op.end <= op.start) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", idx, "end"],
            message: "end must be greater than start",
          });
        }
      } else if (op.op === "fade") {
        if ((op.fade_in_s || 0) <= 0 && (op.fade_out_s || 0) <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", idx, "fade_in_s"],
            message: "Provide fade_in_s or fade_out_s greater than 0",
          });
        }
      } else if (op.op === "captions") {
        if (op.source === "manual" && (!op.segments || op.segments.length === 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", idx, "segments"],
            message: "source='manual' requires a non-empty 'segments' list",
          });
        }
        if (op.segments) {
          op.segments.forEach((seg, sIdx) => {
            if (seg.end <= seg.start) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["operations", idx, "segments", sIdx, "end"],
                message: "caption end must be greater than start",
              });
            }
          });
        }
      }
    });
  });

export type Style = z.infer<typeof StyleSchema>;
export type AspectRatio = z.infer<typeof AspectRatioSchema>;
export type ReframeMode = z.infer<typeof ReframeModeSchema>;
export type ResolutionPreset = z.infer<typeof ResolutionPresetSchema>;
export type FontFamilyChoice = z.infer<typeof FontFamilySchema>;
export type FontWeightChoice = z.infer<typeof FontWeightSchema>;
export type TextAlignChoice = z.infer<typeof TextAlignSchema>;
export type PositionPreset = z.infer<typeof PositionPresetSchema>;
export type ShortenSegment = z.infer<typeof ShortenSegmentSchema>;
export type CutRange = z.infer<typeof CutRangeSchema>;
export type TrimRange = z.infer<typeof TrimRangeSchema>;
export type Reframe = z.infer<typeof ReframeSchema>;
export type SpeedOp = z.infer<typeof SpeedSchema>;
export type AudioAdjustOp = z.infer<typeof AudioAdjustSchema>;
export type FadeOp = z.infer<typeof FadeSchema>;
export type MergeClipsOp = z.infer<typeof MergeClipsSchema>;
export type OverlayText = z.infer<typeof OverlayTextSchema>;
export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type Instructions = z.infer<typeof InstructionsSchema>;

export function parseInstructions(raw: string): Instructions {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid JSON";
    throw new InstructionError(422, {
      error: "invalid_json",
      message: `instructions is not valid JSON: ${msg}`,
    });
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new InstructionError(422, {
      error: "invalid_instructions",
      message: "instructions must be a JSON object",
    });
  }

  const record = data as Record<string, unknown>;
  if (Array.isArray(record.operations)) {
    const bad: string[] = [];
    for (const o of record.operations) {
      const name = typeof o === "object" && o !== null ? (o as Record<string, unknown>).op : null;
      if (typeof name === "string" && !SUPPORTED_OPS.has(name) && !bad.includes(name)) {
        bad.push(name);
      }
    }
    if (bad.length > 0) {
      throw new InstructionError(422, {
        error: "unsupported_operation",
        operations: bad,
        message: "Supported operations: " + Array.from(SUPPORTED_OPS).sort().join(", "),
      });
    }
  }

  const parsed = InstructionsSchema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues.map((err) => ({
      loc: err.path.join("."),
      msg: err.message,
    }));
    throw new InstructionError(422, {
      error: "invalid_instructions",
      details,
    });
  }

  const ins = parsed.data;
  if (ins.operations.some((o) => o.op === "captions" && o.source === "auto_transcribe")) {
    throw new InstructionError(422, {
      error: "unsupported_operation",
      operations: ["captions"],
      message:
        "captions with source='auto_transcribe' is not supported (no speech-to-text in this service). Use source='manual' with segments, or overlay_text.",
    });
  }

  return ins;
}

function parseSrtTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, "0"), 10);
  return Number((h * 3600 + min * 60 + sec + ms / 1000).toFixed(3));
}

export function parseSrtToSegments(srtContent: string): CaptionSegment[] {
  const blocks = srtContent
    .replace(/\r\n/g, "\n")
    .replace(/^\uFEFF/, "")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const segments: CaptionSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const timingLineIdx = lines[0].includes("-->") ? 0 : lines[1].includes("-->") ? 1 : -1;
    if (timingLineIdx < 0) continue;
    const parts = lines[timingLineIdx].split("-->");
    if (parts.length !== 2) continue;
    const start = parseSrtTimestamp(parts[0]);
    const end = parseSrtTimestamp(parts[1]);
    if (start === null || end === null || end <= start) continue;
    const text = lines
      .slice(timingLineIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim()
      .slice(0, 200);
    if (!text) continue;
    segments.push({ start, end, text });
    if (segments.length >= 200) break;
  }
  return segments;
}
