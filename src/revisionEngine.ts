import { AspectRatio, Instructions, Operation, parseInstructions } from "./schemas.js";

export interface RevisionParseResult {
  supported: boolean;
  clarificationNeeded: boolean;
  clarificationPrompt: string | null;
  matchedRules: string[];
  unsupportedPhrases: string[];
  updatedInstructions: Instructions;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  half: 0.5,
};

function parseDurationToken(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const clockMatch = s.match(/^(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
  if (clockMatch) {
    const mins = parseInt(clockMatch[1], 10);
    const secs = parseFloat(`${clockMatch[2]}.${clockMatch[3] || "0"}`);
    return mins * 60 + secs;
  }
  const numMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?$/);
  if (numMatch) {
    return parseFloat(numMatch[1]);
  }
  const wordVal = NUMBER_WORDS[s.replace(/\s*(?:s|sec|secs|second|seconds)$/i, "").trim()];
  return typeof wordVal === "number" ? wordVal : null;
}

const COLOR_MAP: Record<string, string> = {
  yellow: "yellow",
  white: "white",
  black: "black",
  purple: "#b4a2ff",
  violet: "#b4a2ff",
  indigo: "#635bff",
  cyan: "#38bdf8",
  blue: "#60a5fa",
  red: "#ff6b6b",
  green: "#76e4ad",
  gold: "#f5c542",
  amber: "#f5c542",
};

function cloneInstructions(base?: Instructions | null): Instructions {
  if (base && Array.isArray(base.operations) && base.operations.length > 0) {
    return JSON.parse(JSON.stringify(base)) as Instructions;
  }
  return {
    schema_version: "1.0",
    operations: [{ op: "reframe", aspect: "9:16", mode: "crop" }],
  };
}

function splitClauses(input: string): string[] {
  return input
    .split(/(?:\r?\n|[.;]+|\band then\b|\balso\b)/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

export function parseRevisionFeedback(
  feedbackText: string,
  timestampS: number | null | undefined,
  currentInstructions?: Instructions | null
): RevisionParseResult {
  const raw = (feedbackText || "").trim();
  const next = cloneInstructions(currentInstructions);
  if (raw) {
    next.reviewer_comment = raw.slice(0, 2000);
  }
  if (typeof timestampS === "number" && Number.isFinite(timestampS) && timestampS >= 0) {
    next.comment_timestamp_s = timestampS;
  }

  if (!raw) {
    return {
      supported: false,
      clarificationNeeded: true,
      clarificationPrompt:
        "Enter revision instructions such as \"Cut the intro to two seconds.\" or \"Make the caption smaller.\"",
      matchedRules: [],
      unsupportedPhrases: [],
      updatedInstructions: next,
    };
  }

  const clauses = splitClauses(raw);
  const matchedRules: string[] = [];
  const unsupportedPhrases: string[] = [];
  const clarifiers: string[] = [];

  for (const clause of clauses) {
    const low = clause.toLowerCase();
    let handled = false;

    // 1. Cut/shorten the intro to X seconds
    const introToMatch = low.match(
      /(?:cut|shorten|trim|reduce)\s+(?:the\s+)?intro(?:\s+(?:down\s+)?to|\s+at)?\s+([a-z0-9:.]+(?:\s*(?:s|sec|secs|second|seconds))?)/i
    );
    if (introToMatch) {
      const target = parseDurationToken(introToMatch[1]);
      if (target !== null && target > 0 && target <= 600) {
        const existingIdx = next.operations.findIndex(
          (o) => o.op === "shorten_segment" && o.segment === "intro"
        );
        const op: Operation = {
          op: "shorten_segment",
          segment: "intro",
          target_duration_s: target,
          detect: "scene_change",
          scene_threshold: 0.4,
          ...(typeof timestampS === "number" && timestampS > target
            ? { segment_end_s: timestampS }
            : {}),
        };
        if (existingIdx >= 0) {
          next.operations[existingIdx] = op;
        } else {
          next.operations.unshift(op);
        }
        matchedRules.push(`Shorten intro to ${target}s`);
        handled = true;
      }
    }

    // 2. Remove the first X seconds
    if (!handled) {
      const firstSecMatch = low.match(
        /(?:remove|cut|trim|delete)\s+(?:the\s+)?first\s+([a-z0-9:.]+(?:\s*(?:s|sec|secs|second|seconds))?)/i
      );
      if (firstSecMatch) {
        const dur = parseDurationToken(firstSecMatch[1]);
        if (dur !== null && dur > 0) {
          next.operations.unshift({ op: "cut_range", start: 0, end: dur });
          matchedRules.push(`Remove 0.00s – ${dur.toFixed(2)}s`);
          handled = true;
        }
      }
    }

    // 3. Remove section between A and B / from A to B
    if (!handled) {
      const rangeMatch = low.match(
        /(?:remove|cut|delete|trim)\s+(?:the\s+section\s+)?(?:between|from)\s+(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?(?:\s*(?:s|sec|secs|second|seconds))?)\s+(?:and|to|-)\s+(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?(?:\s*(?:s|sec|secs|second|seconds))?)/i
      );
      if (rangeMatch) {
        const start = parseDurationToken(rangeMatch[1]);
        const end = parseDurationToken(rangeMatch[2]);
        if (start !== null && end !== null && end > start) {
          next.operations.unshift({ op: "cut_range", start, end });
          matchedRules.push(`Cut range ${start.toFixed(2)}s – ${end.toFixed(2)}s`);
          handled = true;
        } else {
          clarifiers.push(
            `In "${clause}", the end timestamp must be greater than the start timestamp.`
          );
          handled = true;
        }
      }
    }

    // 4. Shorten the ending / outro
    if (!handled && /(?:shorten|cut|trim|reduce)\s+(?:the\s+)?(?:ending|outro)/i.test(low)) {
      const durMatch = low.match(
        /(?:to)\s+([a-z0-9:.]+(?:\s*(?:s|sec|secs|second|seconds))?)/i
      );
      const target = durMatch ? parseDurationToken(durMatch[1]) : 2;
      if (target !== null && target > 0) {
        const existingIdx = next.operations.findIndex(
          (o) => o.op === "shorten_segment" && o.segment === "outro"
        );
        const op: Operation = {
          op: "shorten_segment",
          segment: "outro",
          target_duration_s: target,
          detect: "scene_change",
          scene_threshold: 0.4,
          ...(typeof timestampS === "number" && timestampS > 0
            ? { segment_start_s: timestampS }
            : {}),
        };
        if (existingIdx >= 0) next.operations[existingIdx] = op;
        else next.operations.unshift(op);
        matchedRules.push(`Shorten outro to ${target}s`);
        handled = true;
      }
    }

    // 5. Make caption/text smaller or larger
    if (
      !handled &&
      /(?:make|set)\s+(?:the\s+)?(?:caption|captions|subtitle|subtitles|text)(?:\s+size)?\s+(smaller|larger|bigger)/i.test(
        low
      )
    ) {
      const dir = low.includes("smaller") ? "smaller" : "larger";
      const factor = dir === "smaller" ? 0.78 : 1.24;
      let count = 0;
      for (const op of next.operations) {
        if (op.op === "captions" || op.op === "overlay_text") {
          const cur = typeof op.font_size_scale === "number" ? op.font_size_scale : 1;
          op.font_size_scale = Math.max(0.5, Math.min(2.0, Number((cur * factor).toFixed(2))));
          count++;
        }
      }
      if (count === 0) {
        clarifiers.push(
          `Found "${clause}", but this project has no caption or text overlay operation yet.`
        );
      } else {
        matchedRules.push(`Made captions/text ${dir}`);
      }
      handled = true;
    }

    // 6. Change caption/text color
    if (!handled) {
      const colorMatch = low.match(
        /(?:change|make|set)\s+(?:the\s+)?(?:caption|captions|text|overlay)\s+(?:color\s+)?(?:to\s+)?(#?[a-z0-9]{3,16})/i
      );
      if (colorMatch) {
        const rawCol = colorMatch[1].toLowerCase();
        const mapped = COLOR_MAP[rawCol] || (/^#[0-9a-f]{6}$/i.test(rawCol) ? rawCol : null);
        if (mapped) {
          let count = 0;
          for (const op of next.operations) {
            if (op.op === "captions" || op.op === "overlay_text") {
              op.text_color = mapped;
              count++;
            }
          }
          if (count === 0) {
            clarifiers.push(
              `Found "${clause}", but there are no caption or text overlay operations to recolor.`
            );
          } else {
            matchedRules.push(`Changed caption text color to ${rawCol}`);
          }
          handled = true;
        }
      }
    }

    // 7. Move caption position (top / middle / bottom)
    if (!handled) {
      const posMatch = low.match(
        /(?:move|place|put|align)\s+(?:the\s+)?(?:caption|captions|subtitle|subtitles|text)\s+(?:to\s+(?:the\s+)?)?(top|middle|center|bottom)/i
      );
      if (posMatch) {
        const rawPos = posMatch[1].toLowerCase();
        const pos = rawPos === "center" ? "middle" : (rawPos as "top" | "middle" | "bottom");
        let count = 0;
        for (const op of next.operations) {
          if (op.op === "captions" || op.op === "overlay_text") {
            op.position_preset = pos;
            count++;
          }
        }
        if (count === 0) {
          clarifiers.push(`Found "${clause}", but no caption/text layer exists yet.`);
        } else {
          matchedRules.push(`Moved captions to ${pos}`);
        }
        handled = true;
      }
    }

    // 8. Reduce / mute / adjust audio volume
    if (
      !handled &&
      /(?:reduce|lower|decrease|mute|silence|quiet)\s+(?:the\s+)?(?:background\s+)?audio|volume/i.test(
        low
      )
    ) {
      const mute = /\bmute\b|\bsilence\b/i.test(low);
      const pctMatch = low.match(/(\d{1,3})\s*%/);
      const volume = mute
        ? 0
        : pctMatch
          ? Math.max(0, Math.min(3, parseInt(pctMatch[1], 10) / 100))
          : 0.45;
      const idx = next.operations.findIndex((o) => o.op === "audio_adjust");
      const op: Operation = { op: "audio_adjust", volume, mute };
      if (idx >= 0) next.operations[idx] = op;
      else next.operations.push(op);
      matchedRules.push(mute ? "Muted audio" : `Adjusted audio volume to ${Math.round(volume * 100)}%`);
      handled = true;
    }

    // 9. Aspect ratio conversion (9:16, 16:9, 1:1, 4:5)
    if (!handled) {
      const aspectMatch = low.match(/\b(9:16|16:9|1:1|4:5)\b/);
      if (aspectMatch && /(?:convert|change|reframe|export|make|resize|set)/i.test(low)) {
        const aspect = aspectMatch[1] as AspectRatio;
        const idx = next.operations.findIndex((o) => o.op === "reframe");
        if (idx >= 0 && next.operations[idx].op === "reframe") {
          (next.operations[idx] as Extract<Operation, { op: "reframe" }>).aspect = aspect;
        } else {
          next.operations.unshift({ op: "reframe", aspect, mode: "crop" });
        }
        matchedRules.push(`Reframe output aspect ratio to ${aspect}`);
        handled = true;
      }
    }

    // 10. Add blurred background
    if (!handled && /blur(?:red)?\s+background/i.test(low)) {
      const idx = next.operations.findIndex((o) => o.op === "reframe");
      if (idx >= 0 && next.operations[idx].op === "reframe") {
        (next.operations[idx] as Extract<Operation, { op: "reframe" }>).mode = "blur";
      } else {
        next.operations.unshift({ op: "reframe", aspect: "9:16", mode: "blur" });
      }
      matchedRules.push("Enabled blurred background reframing");
      handled = true;
    }

    // 11. Remove a specific text overlay (or matching text)
    if (
      !handled &&
      /(?:remove|delete)\s+(?:the\s+)?(?:specific\s+)?text\s+overlay/i.test(low)
    ) {
      const quoted = clause.match(/["']([^"']+)["']/);
      const overlayIndices = next.operations
        .map((o, idx) => ({ o, idx }))
        .filter((x) => x.o.op === "overlay_text");

      if (overlayIndices.length === 0) {
        clarifiers.push(`No text overlays exist in the current instructions to remove.`);
      } else if (quoted) {
        const needle = quoted[1].toLowerCase();
        const match = overlayIndices.find(
          (x) => x.o.op === "overlay_text" && x.o.text.toLowerCase().includes(needle)
        );
        if (match) {
          next.operations.splice(match.idx, 1);
          matchedRules.push(`Removed text overlay "${quoted[1]}"`);
        } else {
          clarifiers.push(`Could not find a text overlay matching "${quoted[1]}".`);
        }
      } else if (overlayIndices.length === 1) {
        next.operations.splice(overlayIndices[0].idx, 1);
        matchedRules.push("Removed text overlay");
      } else {
        clarifiers.push(
          `Multiple text overlays exist. Quote the text to remove (for example: Remove text overlay "Stop scrolling").`
        );
      }
      handled = true;
    }

    // 12. Ambiguous section removal ("Remove this section" without end time)
    if (!handled && /(?:remove|cut|delete)\s+(?:this|that)\s+(?:section|part|clip)/i.test(low)) {
      const atHint =
        typeof timestampS === "number" ? timestampS : 0;
      clarifiers.push(
        `Specify the exact range to remove (for example: "Remove the section between ${Math.floor(
          atHint
        )}s and ${Math.floor(atHint) + 4}s").`
      );
      handled = true;
    }

    if (!handled) {
      unsupportedPhrases.push(clause);
    }
  }

  // Ensure at least one operation remains valid if everything was removed
  if (next.operations.length === 0) {
    next.operations.push({ op: "reframe", aspect: "9:16", mode: "crop" });
  }

  let validated: Instructions = next;
  try {
    validated = parseInstructions(JSON.stringify(next));
  } catch (err) {
    clarifiers.push(err instanceof Error ? err.message : "Invalid generated edit instructions.");
  }

  const clarificationNeeded =
    clarifiers.length > 0 || (matchedRules.length === 0 && unsupportedPhrases.length > 0);
  const clarificationParts: string[] = [...clarifiers];
  if (unsupportedPhrases.length > 0) {
    clarificationParts.push(
      `Unsupported or unclear instruction(s): "${unsupportedPhrases.join('"; "')}". ` +
        'Supported commands include: "Cut the intro to two seconds", "Remove the first five seconds", ' +
        '"Remove the section between 00:10 and 00:15", "Shorten the ending", "Make the caption smaller", ' +
        '"Change the caption color to yellow", "Move the caption to the bottom", "Reduce background audio volume", ' +
        '"Convert the video to 9:16", "Add a blurred background", and "Remove text overlay \'...\'".'
    );
  }

  return {
    supported: matchedRules.length > 0 && !clarificationNeeded,
    clarificationNeeded,
    clarificationPrompt: clarificationNeeded ? clarificationParts.join(" ") : null,
    matchedRules,
    unsupportedPhrases,
    updatedInstructions: validated,
  };
}
