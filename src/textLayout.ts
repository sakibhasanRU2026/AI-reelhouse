import fs from "node:fs";
import path from "node:path";
import opentype from "opentype.js";
import {
  FontFamilyChoice,
  FontWeightChoice,
  PositionPreset,
  Style,
  TextAlignChoice,
} from "./schemas.js";

export interface TextInputItem {
  id: string;
  kind: "captions" | "overlay_text";
  orderIndex: number;
  text: string;
  start: number;
  end: number;
  style: Style;
  maxWordsPerLine: number;
  fontFamily?: FontFamilyChoice;
  fontWeight?: FontWeightChoice;
  fontSizeScale?: number;
  textColor?: string;
  bgColor?: string;
  bgOpacity?: number;
  outlineWidth?: number;
  shadow?: boolean;
  align?: TextAlignChoice;
  lineSpacing?: number;
  positionPreset?: PositionPreset;
  xPct?: number;
  yPct?: number;
}

export interface PlacedLine {
  text: string;
  width: number;
  x: number;
  baselineY: number;
}

export interface PlacedTextBlock {
  id: string;
  kind: "captions" | "overlay_text";
  start: number;
  end: number;
  style: Style;
  fontFamily: FontFamilyChoice;
  fontWeight: FontWeightChoice;
  fontPath: string;
  fontSize: number;
  textColor: string;
  bgColor: string;
  bgOpacity: number;
  borderW: number;
  boxBorderW: number;
  shadow: boolean;
  align: TextAlignChoice;
  positionPreset: PositionPreset;
  lineStep: number;
  blockTopY: number;
  blockHeight: number;
  maxWidthUsed: number;
  lines: PlacedLine[];
}

export interface LayoutRegion {
  xOffset: number;
  yOffset: number;
  width: number;
  height: number;
  referenceWidth: number;
  referenceHeight: number;
}

export interface SafeZoneGuide {
  topPct: number;
  bottomPct: number;
  leftPct: number;
  rightPct: number;
  label: string;
}

export interface TextLayoutResult {
  targetWidth: number;
  targetHeight: number;
  safeTop: number;
  safeBottom: number;
  maxTextWidth: number;
  safeZone: SafeZoneGuide;
  blocks: PlacedTextBlock[];
}

const FONT_DIR = "/usr/share/fonts/truetype/dejavu";
const FONT_FILES: Record<FontFamilyChoice, Record<FontWeightChoice, string>> = {
  sans: {
    regular: "DejaVuSans.ttf",
    bold: "DejaVuSans-Bold.ttf",
  },
  serif: {
    regular: "DejaVuSerif.ttf",
    bold: "DejaVuSerif-Bold.ttf",
  },
  mono: {
    regular: "DejaVuSansMono.ttf",
    bold: "DejaVuSansMono-Bold.ttf",
  },
};

export function resolveFontPath(
  defaultFontPath: string,
  family: FontFamilyChoice = "sans",
  weight: FontWeightChoice = "bold"
): string {
  const fileName = FONT_FILES[family]?.[weight];
  if (fileName) {
    const candidate = path.join(FONT_DIR, fileName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return defaultFontPath;
}

const fontCache = new Map<string, opentype.Font | null>();

export function loadFont(fontPath: string): opentype.Font | null {
  if (fontCache.has(fontPath)) {
    return fontCache.get(fontPath) ?? null;
  }
  try {
    if (fs.existsSync(fontPath) && fs.statSync(fontPath).isFile()) {
      const buf = fs.readFileSync(fontPath);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const font = opentype.parse(ab);
      fontCache.set(fontPath, font);
      return font;
    }
  } catch (err) {
    console.warn("[reelhouse] Failed to parse font via opentype.js:", err);
  }
  fontCache.set(fontPath, null);
  return null;
}

export function measureTextWidth(
  font: opentype.Font | null,
  text: string,
  fontSize: number
): number {
  if (!text) return 0;
  if (font) {
    const scale = fontSize / (font.unitsPerEm || 2048);
    let total = 0;
    for (const ch of Array.from(text)) {
      const g = font.charToGlyph(ch);
      const adv =
        g && typeof g.advanceWidth === "number" && g.advanceWidth > 0
          ? g.advanceWidth
          : (font.unitsPerEm || 2048) * 0.65;
      total += adv * scale;
    }
    return total * 1.04 + text.length * 0.4;
  }
  return text.length * fontSize * 0.72;
}

function splitOversizedToken(
  token: string,
  font: opentype.Font | null,
  fontSize: number,
  maxWidth: number
): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const ch of Array.from(token)) {
    const next = cur + ch;
    if (cur && measureTextWidth(font, next, fontSize) > maxWidth) {
      chunks.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [token];
}

function balanceParagraphLines(
  words: string[],
  targetLineCount: number,
  font: opentype.Font | null,
  fontSize: number,
  maxContentWidth: number,
  maxWordsPerLine: number
): string[] | null {
  const n = words.length;
  if (targetLineCount <= 1 || n <= targetLineCount || n > 80) {
    return null;
  }

  const lineWidth: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n + 1).fill(-1)
  );
  let totalWidth = 0;
  for (let i = 0; i < n; i++) {
    totalWidth += measureTextWidth(font, words[i], fontSize);
  }
  const spaceW = measureTextWidth(font, " ", fontSize);
  const idealWidth = Math.min(
    maxContentWidth,
    (totalWidth + spaceW * Math.max(0, n - targetLineCount)) / targetLineCount
  );

  for (let i = 0; i < n; i++) {
    const endLimit = Math.min(n, i + maxWordsPerLine);
    for (let j = i + 1; j <= endLimit; j++) {
      const candidate = words.slice(i, j).join(" ");
      const w = measureTextWidth(font, candidate, fontSize);
      if (w > maxContentWidth) break;
      lineWidth[i][j] = w;
    }
  }

  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: targetLineCount + 1 }, () =>
    new Array<number>(n + 1).fill(INF)
  );
  const parent: number[][] = Array.from({ length: targetLineCount + 1 }, () =>
    new Array<number>(n + 1).fill(-1)
  );
  dp[0][0] = 0;

  for (let k = 1; k <= targetLineCount; k++) {
    for (let j = k; j <= n; j++) {
      const startMin = Math.max(k - 1, j - maxWordsPerLine);
      for (let i = startMin; i < j; i++) {
        if (dp[k - 1][i] === INF) continue;
        const w = lineWidth[i][j];
        if (w < 0) continue;
        const diff = w - idealWidth;
        const cost = dp[k - 1][i] + diff * diff;
        if (cost < dp[k][j]) {
          dp[k][j] = cost;
          parent[k][j] = i;
        }
      }
    }
  }

  if (dp[targetLineCount][n] === INF) {
    return null;
  }

  const result: string[] = [];
  let idx = n;
  for (let k = targetLineCount; k >= 1; k--) {
    const prev = parent[k][idx];
    result.unshift(words.slice(prev, idx).join(" "));
    idx = prev;
  }
  return result;
}

interface WrapResult {
  lines: string[];
  hasOversizedWord: boolean;
}

function wrapAndBalanceText(
  text: string,
  font: opentype.Font | null,
  fontSize: number,
  maxContentWidth: number,
  maxWordsPerLine: number,
  allowCharBreak: boolean
): WrapResult {
  const paragraphs = text
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const allLines: string[] = [];

  for (const para of paragraphs) {
    const rawWords = para.split(/\s+/).filter(Boolean);
    const words: string[] = [];

    for (const w of rawWords) {
      if (measureTextWidth(font, w, fontSize) > maxContentWidth) {
        if (!allowCharBreak) {
          return { lines: [], hasOversizedWord: true };
        }
        words.push(...splitOversizedToken(w, font, fontSize, maxContentWidth));
      } else {
        words.push(w);
      }
    }

    const greedyLines: string[] = [];
    let current: string[] = [];
    for (const word of words) {
      const candidateWords = [...current, word];
      const candidateText = candidateWords.join(" ");
      if (
        current.length > 0 &&
        (candidateWords.length > maxWordsPerLine ||
          measureTextWidth(font, candidateText, fontSize) > maxContentWidth)
      ) {
        greedyLines.push(current.join(" "));
        current = [word];
      } else {
        current = candidateWords;
      }
    }
    if (current.length > 0) {
      greedyLines.push(current.join(" "));
    }

    const balanced =
      !allowCharBreak && greedyLines.length >= 2
        ? balanceParagraphLines(
            words,
            greedyLines.length,
            font,
            fontSize,
            maxContentWidth,
            maxWordsPerLine
          )
        : null;

    allLines.push(...(balanced || greedyLines));
  }

  return { lines: allLines, hasOversizedWord: false };
}

interface FittedBlock {
  item: TextInputItem;
  fontPath: string;
  fontFamily: FontFamilyChoice;
  fontWeight: FontWeightChoice;
  textColor: string;
  bgColor: string;
  bgOpacity: number;
  shadow: boolean;
  align: TextAlignChoice;
  positionPreset: PositionPreset;
  fontSize: number;
  borderW: number;
  boxBorderW: number;
  lineStep: number;
  blockAscent: number;
  blockHeight: number;
  maxWidthUsed: number;
  lines: Array<{ text: string; contentWidth: number; width: number }>;
}

function getDecoration(item: TextInputItem, fontSize: number) {
  const borderW =
    typeof item.outlineWidth === "number"
      ? item.outlineWidth
      : Math.max(2, Math.round(fontSize / 20));
  const bgOpacity =
    typeof item.bgOpacity === "number"
      ? item.bgOpacity
      : item.style === "white-box"
        ? 0.6
        : 0;
  const hasBox = item.style === "white-box" || bgOpacity > 0.01;
  const boxBorderW = hasBox ? Math.max(4, Math.round(fontSize * 0.14)) : 0;
  const horizPad = hasBox ? boxBorderW : borderW;
  const ascentPx = Math.round(fontSize * 0.9);
  const descentPx = Math.round(fontSize * 0.26);
  const glyphSpan = ascentPx + descentPx;
  const spacingMult = typeof item.lineSpacing === "number" ? item.lineSpacing : 1.32;
  const lineStep = hasBox
    ? Math.max(Math.round(fontSize * (spacingMult + 0.04)), glyphSpan + 2 * boxBorderW + 4)
    : Math.round(fontSize * spacingMult);
  const blockAscent = ascentPx + horizPad;
  const blockDescent = descentPx + horizPad;
  return { borderW, boxBorderW, horizPad, lineStep, blockAscent, blockDescent, bgOpacity };
}

function fitSingleBlock(
  item: TextInputItem,
  defaultFontPath: string,
  maxBoxWidth: number,
  availHeight: number,
  baseFontSize: number,
  minFontSize: number,
  maxFontSizeCap?: number
): FittedBlock {
  const fontFamily: FontFamilyChoice = item.fontFamily || "sans";
  const fontWeight: FontWeightChoice = item.fontWeight || "bold";
  const fontPath = resolveFontPath(defaultFontPath, fontFamily, fontWeight);
  const font = loadFont(fontPath);
  const sizeScale = typeof item.fontSizeScale === "number" ? item.fontSizeScale : 1.0;
  const scaledBase = Math.max(minFontSize, Math.round(baseFontSize * sizeScale));
  const startFs = maxFontSizeCap
    ? Math.max(minFontSize, Math.min(scaledBase, Math.floor(maxFontSizeCap)))
    : scaledBase;
  const comfortableMinFs = Math.max(minFontSize, Math.round(scaledBase * 0.56));
  const preferredMaxH = Math.round(availHeight * 0.46);

  const textColor = item.textColor || (item.style === "bold-yellow" ? "yellow" : "white");
  const bgColor = item.bgColor || "black";
  const align: TextAlignChoice = item.align || "center";
  const shadow = item.shadow ?? false;
  const positionPreset: PositionPreset = item.positionPreset || "auto";

  const tryFitAt = (fs: number, allowCharBreak: boolean): FittedBlock | null => {
    const dec = getDecoration(item, fs);
    const maxContentWidth = Math.max(16, maxBoxWidth - 2 * dec.horizPad);
    const wrapped = wrapAndBalanceText(
      item.text,
      font,
      fs,
      maxContentWidth,
      item.maxWordsPerLine,
      allowCharBreak
    );
    if (wrapped.hasOversizedWord || wrapped.lines.length === 0) {
      return null;
    }
    const blockHeight =
      dec.blockAscent + (wrapped.lines.length - 1) * dec.lineStep + dec.blockDescent;
    const measuredLines = wrapped.lines.map((lineText) => {
      const cw = measureTextWidth(font, lineText, fs);
      return {
        text: lineText,
        contentWidth: cw,
        width: cw + 2 * dec.horizPad,
      };
    });
    const maxWidthUsed = measuredLines.reduce((m, l) => Math.max(m, l.width), 0);
    return {
      item,
      fontPath,
      fontFamily,
      fontWeight,
      textColor,
      bgColor,
      bgOpacity: dec.bgOpacity,
      shadow,
      align,
      positionPreset,
      fontSize: fs,
      borderW: dec.borderW,
      boxBorderW: dec.boxBorderW,
      lineStep: dec.lineStep,
      blockAscent: dec.blockAscent,
      blockHeight,
      maxWidthUsed,
      lines: measuredLines,
    };
  };

  let fs = startFs;
  let lastValidAtHeight: FittedBlock | null = null;

  while (fs >= minFontSize) {
    const candidate = tryFitAt(fs, false);
    if (candidate) {
      if (candidate.blockHeight <= availHeight) {
        lastValidAtHeight = candidate;
      }
      const heightLimit = fs > comfortableMinFs ? preferredMaxH : availHeight;
      if (candidate.blockHeight <= heightLimit) {
        return candidate;
      }
    }
    if (fs === minFontSize) break;
    const step = Math.max(1, Math.round(fs * 0.08));
    fs = Math.max(minFontSize, fs - step);
  }

  if (lastValidAtHeight) {
    return lastValidAtHeight;
  }

  for (let fallbackFs = minFontSize; fallbackFs >= 10; fallbackFs -= 2) {
    const candidate = tryFitAt(fallbackFs, true);
    if (candidate && (candidate.blockHeight <= availHeight || fallbackFs <= 11)) {
      return candidate;
    }
  }

  return tryFitAt(10, true)!;
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - 0.0005 && bStart < aEnd - 0.0005;
}

function boxesCollide(
  topA: number,
  heightA: number,
  topB: number,
  heightB: number,
  gap: number
): boolean {
  return topA < topB + heightB + gap && topB < topA + heightA + gap;
}

function computeLineX(
  reg: LayoutRegion,
  marginX: number,
  align: TextAlignChoice,
  contentWidth: number,
  xPct?: number
): number {
  if (typeof xPct === "number" && Number.isFinite(xPct)) {
    const anchorX = reg.xOffset + Math.round(reg.width * xPct);
    if (align === "left") {
      return Math.max(reg.xOffset + marginX, Math.min(reg.xOffset + reg.width - marginX - contentWidth, anchorX));
    }
    if (align === "right") {
      return Math.max(reg.xOffset + marginX, Math.min(reg.xOffset + reg.width - marginX - contentWidth, anchorX - contentWidth));
    }
    return Math.max(
      reg.xOffset + marginX,
      Math.min(reg.xOffset + reg.width - marginX - contentWidth, Math.round(anchorX - contentWidth / 2))
    );
  }
  if (align === "left") {
    return reg.xOffset + marginX;
  }
  if (align === "right") {
    return Math.max(reg.xOffset + marginX, Math.round(reg.xOffset + reg.width - marginX - contentWidth));
  }
  return Math.max(reg.xOffset + marginX, Math.round(reg.xOffset + (reg.width - contentWidth) / 2));
}

function computeIdealTop(
  item: TextInputItem,
  reg: LayoutRegion,
  safeTop: number,
  safeBottomEdge: number,
  blockHeight: number
): number {
  let frac = 0.72;
  if (item.positionPreset === "top") frac = 0.10;
  else if (item.positionPreset === "middle") frac = 0.44;
  else if (item.positionPreset === "bottom") frac = 0.78;
  else if (item.positionPreset === "custom" && typeof item.yPct === "number") {
    frac = item.yPct;
  } else if (item.kind === "overlay_text") {
    frac = 0.16;
  }

  return Math.max(
    safeTop,
    Math.min(safeBottomEdge - blockHeight, reg.yOffset + Math.round(reg.height * frac))
  );
}

function getSafeZoneGuide(w: number, h: number): SafeZoneGuide {
  if (h > w * 1.4) {
    // 9:16 Reels / Shorts / TikTok UI chrome safe zone
    return {
      topPct: 12,
      bottomPct: 22,
      leftPct: 6,
      rightPct: 14,
      label: "9:16 Reels / Shorts / TikTok safe zone",
    };
  }
  if (h > w) {
    return { topPct: 8, bottomPct: 12, leftPct: 6, rightPct: 6, label: "4:5 Social Feed safe zone" };
  }
  return { topPct: 6, bottomPct: 10, leftPct: 5, rightPct: 5, label: "Landscape / Square safe zone" };
}

export function layoutTextBlocks(
  items: TextInputItem[],
  fontPath: string,
  targetW: number,
  targetH: number,
  region?: LayoutRegion
): TextLayoutResult {
  const reg: LayoutRegion = region || {
    xOffset: 0,
    yOffset: 0,
    width: targetW,
    height: targetH,
    referenceWidth: targetW,
    referenceHeight: targetH,
  };

  const scaleToRegion = reg.width / reg.referenceWidth;
  const maxTextWidth = Math.floor(reg.width * 0.9);
  const marginX = Math.max(12, Math.floor((reg.width - maxTextWidth) / 2));
  const safeTop = reg.yOffset + Math.max(12, Math.round(reg.height * 0.06));
  const safeBottomMargin = Math.max(16, Math.round(reg.height * 0.08));
  const safeBottomEdge = reg.yOffset + reg.height - safeBottomMargin;
  const availHeight = Math.max(40, safeBottomEdge - safeTop);
  const blockGap = Math.max(10, Math.round(reg.height * 0.015));

  const refBaseFs = Math.max(
    18,
    Math.round(Math.min(reg.referenceHeight / 24, reg.referenceWidth / 16))
  );
  const baseFs = Math.max(12, Math.round(refBaseFs * scaleToRegion));
  const minFs = Math.max(10, Math.round(Math.min(reg.width, reg.height) * 0.018));

  const sorted = [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "captions" ? -1 : 1;
    }
    if (a.start !== b.start) return a.start - b.start;
    return a.orderIndex - b.orderIndex;
  });

  const maxFontCaps = new Map<string, number>();

  const buildPlacedLines = (fit: FittedBlock, topY: number): PlacedLine[] =>
    fit.lines.map((l, idx) => ({
      text: l.text,
      width: l.width,
      x: computeLineX(reg, marginX, fit.align, l.contentWidth, fit.item.positionPreset === "custom" ? fit.item.xPct : undefined),
      baselineY: Math.round(topY + fit.blockAscent + idx * fit.lineStep),
    }));

  const attemptLayout = (): {
    placed: PlacedTextBlock[];
    overflowClusterIds: Set<string> | null;
  } => {
    const placed: PlacedTextBlock[] = [];

    for (const item of sorted) {
      const cap = maxFontCaps.get(item.id);
      const fit = fitSingleBlock(
        item,
        fontPath,
        maxTextWidth,
        availHeight,
        baseFs,
        minFs,
        cap
      );

      const overlapping = placed.filter((p) =>
        intervalsOverlap(p.start, p.end, item.start, item.end)
      );

      const idealTop = computeIdealTop(item, reg, safeTop, safeBottomEdge, fit.blockHeight);

      const hasCollision = (candidateTop: number): boolean => {
        if (candidateTop < safeTop || candidateTop + fit.blockHeight > safeBottomEdge) {
          return true;
        }
        return overlapping.some((p) =>
          boxesCollide(candidateTop, fit.blockHeight, p.blockTopY, p.blockHeight, blockGap)
        );
      };

      let chosenTop: number | null = null;
      if (!hasCollision(idealTop)) {
        chosenTop = idealTop;
      } else {
        const candidates: number[] = [safeTop, safeBottomEdge - fit.blockHeight];
        for (const p of overlapping) {
          candidates.push(p.blockTopY - blockGap - fit.blockHeight);
          candidates.push(p.blockTopY + p.blockHeight + blockGap);
        }
        const valid = candidates.filter((y) => !hasCollision(y));
        if (valid.length > 0) {
          valid.sort((a, b) => {
            const aAbove = a <= idealTop ? 0 : 1;
            const bAbove = b <= idealTop ? 0 : 1;
            if (aAbove !== bAbove) return aAbove - bAbove;
            return Math.abs(idealTop - a) - Math.abs(idealTop - b);
          });
          chosenTop = valid[0];
        }
      }

      if (chosenTop === null) {
        const cluster = new Set<string>([item.id, ...overlapping.map((p) => p.id)]);
        return { placed: [], overflowClusterIds: cluster };
      }

      placed.push({
        id: item.id,
        kind: item.kind,
        start: item.start,
        end: item.end,
        style: item.style,
        fontFamily: fit.fontFamily,
        fontWeight: fit.fontWeight,
        fontPath: fit.fontPath,
        fontSize: fit.fontSize,
        textColor: fit.textColor,
        bgColor: fit.bgColor,
        bgOpacity: fit.bgOpacity,
        borderW: fit.borderW,
        boxBorderW: fit.boxBorderW,
        shadow: fit.shadow,
        align: fit.align,
        positionPreset: fit.positionPreset,
        lineStep: fit.lineStep,
        blockTopY: chosenTop,
        blockHeight: fit.blockHeight,
        maxWidthUsed: fit.maxWidthUsed,
        lines: buildPlacedLines(fit, chosenTop),
      });
    }

    return { placed, overflowClusterIds: null };
  };

  for (let round = 0; round < 8; round++) {
    const res = attemptLayout();
    if (!res.overflowClusterIds) {
      return {
        targetWidth: targetW,
        targetHeight: targetH,
        safeTop,
        safeBottom: safeBottomMargin,
        maxTextWidth,
        safeZone: getSafeZoneGuide(reg.width, reg.height),
        blocks: res.placed,
      };
    }

    let shrunkAny = false;
    for (const id of res.overflowClusterIds) {
      const currentCap = maxFontCaps.get(id) ?? baseFs;
      const nextCap = Math.max(minFs, Math.floor(currentCap * 0.82));
      if (nextCap < currentCap) {
        maxFontCaps.set(id, nextCap);
        shrunkAny = true;
      }
    }
    if (!shrunkAny) {
      break;
    }
  }

  const finalPlaced: PlacedTextBlock[] = [];
  for (const item of sorted) {
    const fit = fitSingleBlock(item, fontPath, maxTextWidth, availHeight, baseFs, minFs, minFs);
    const overlapping = finalPlaced.filter((p) =>
      intervalsOverlap(p.start, p.end, item.start, item.end)
    );
    let y = computeIdealTop(item, reg, safeTop, safeBottomEdge, fit.blockHeight);
    for (const p of overlapping) {
      if (boxesCollide(y, fit.blockHeight, p.blockTopY, p.blockHeight, blockGap)) {
        const tryAbove = p.blockTopY - blockGap - fit.blockHeight;
        if (tryAbove >= safeTop) y = tryAbove;
      }
    }
    finalPlaced.push({
      id: item.id,
      kind: item.kind,
      start: item.start,
      end: item.end,
      style: item.style,
      fontFamily: fit.fontFamily,
      fontWeight: fit.fontWeight,
      fontPath: fit.fontPath,
      fontSize: fit.fontSize,
      textColor: fit.textColor,
      bgColor: fit.bgColor,
      bgOpacity: fit.bgOpacity,
      borderW: fit.borderW,
      boxBorderW: fit.boxBorderW,
      shadow: fit.shadow,
      align: fit.align,
      positionPreset: fit.positionPreset,
      lineStep: fit.lineStep,
      blockTopY: y,
      blockHeight: fit.blockHeight,
      maxWidthUsed: fit.maxWidthUsed,
      lines: buildPlacedLines(fit, y),
    });
  }

  return {
    targetWidth: targetW,
    targetHeight: targetH,
    safeTop,
    safeBottom: safeBottomMargin,
    maxTextWidth,
    safeZone: getSafeZoneGuide(reg.width, reg.height),
    blocks: finalPlaced,
  };
}
