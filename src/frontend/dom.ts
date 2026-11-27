import { ProjectStatus } from "./types.js";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function btn(
  text: string,
  cls = "btn",
  onClick?: (e: MouseEvent) => void,
  disabled = false
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.disabled = disabled;
  if (onClick) b.onclick = onClick;
  return b;
}

export function badge(text: string, tone: "neutral" | "purple" | "green" | "amber" | "red" = "neutral"): HTMLSpanElement {
  return el("span", `badge badge-${tone}`, text);
}

export function statusTone(status: string): "neutral" | "purple" | "green" | "amber" | "red" {
  const s = status.toLowerCase();
  if (
    s.includes("approved") ||
    s === "completed" ||
    s === "ready for publishing" ||
    s === "published" ||
    s === "connected" ||
    s === "active" ||
    s === "applied" ||
    s === "resolved"
  ) {
    return "green";
  }
  if (
    s.includes("rejected") ||
    s === "failed" ||
    s === "expired" ||
    s.includes("not connected")
  ) {
    return "red";
  }
  if (
    s.includes("revision") ||
    s.includes("changes") ||
    s.includes("awaiting") ||
    s.includes("pending") ||
    s.includes("clarification")
  ) {
    return "amber";
  }
  if (
    s.includes("render") ||
    s.includes("editing") ||
    s === "scheduled" ||
    s === "queued"
  ) {
    return "purple";
  }
  return "neutral";
}

export function projectTone(status: ProjectStatus): "neutral" | "purple" | "green" | "amber" | "red" {
  return statusTone(status);
}

export function formatTimeClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h > 0 ? `${h}:${String(m).padStart(2, "0")}:` : `${m}:`) + String(r).padStart(2, "0");
}

export function formatIsoShort(iso?: string): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function inputField(
  labelText: string,
  value: string,
  onInput: (val: string) => void,
  opts: {
    type?: "text" | "email" | "number" | "date" | "url";
    placeholder?: string;
    wide?: boolean;
    min?: string;
    max?: string;
    step?: string;
    disabled?: boolean;
  } = {}
): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const wrap = el("div", opts.wide ? "field wide" : "field");
  const lab = el("label", "", labelText);
  const inp = document.createElement("input");
  inp.type = opts.type || "text";
  inp.value = value;
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (opts.min !== undefined) inp.min = opts.min;
  if (opts.max !== undefined) inp.max = opts.max;
  if (opts.step !== undefined) inp.step = opts.step;
  if (opts.disabled) inp.disabled = true;
  inp.setAttribute("aria-label", labelText);
  inp.oninput = () => onInput(inp.value);
  wrap.append(lab, inp);
  return { wrap, input: inp };
}

export function textareaField(
  labelText: string,
  value: string,
  onInput: (val: string) => void,
  opts: { placeholder?: string; rows?: number; wide?: boolean; disabled?: boolean } = {}
): { wrap: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const wrap = el("div", opts.wide ? "field wide" : "field");
  const lab = el("label", "", labelText);
  const ta = document.createElement("textarea");
  ta.rows = opts.rows || 3;
  ta.value = value;
  if (opts.placeholder) ta.placeholder = opts.placeholder;
  if (opts.disabled) ta.disabled = true;
  ta.setAttribute("aria-label", labelText);
  ta.oninput = () => onInput(ta.value);
  wrap.append(lab, ta);
  return { wrap, textarea: ta };
}

export function selectField(
  labelText: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (val: string) => void,
  opts: { wide?: boolean; disabled?: boolean } = {}
): { wrap: HTMLDivElement; select: HTMLSelectElement } {
  const wrap = el("div", opts.wide ? "field wide" : "field");
  const lab = el("label", "", labelText);
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", labelText);
  if (opts.disabled) sel.disabled = true;
  for (const [val, label] of options) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    sel.append(o);
  }
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
  wrap.append(lab, sel);
  return { wrap, select: sel };
}

let toastContainer: HTMLDivElement | null = null;

export function showToast(msg: string, tone: "ok" | "err" | "info" = "info"): void {
  if (!toastContainer) {
    toastContainer = el("div", "toast-stack");
    toastContainer.setAttribute("aria-live", "polite");
    document.body.append(toastContainer);
  }
  const item = el("div", `toast toast-${tone}`, msg);
  toastContainer.append(item);
  setTimeout(() => {
    item.classList.add("toast-hide");
    setTimeout(() => item.remove(), 250);
  }, 4200);
}

export function formatUserError(err: unknown, fallback = "Operation failed. Please try again."): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return fallback;

  let msg = raw;
  if (raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        error?: unknown;
        operationType?: unknown;
        path?: unknown;
      };
      if (typeof parsed.error === "string" && parsed.error) {
        const op = typeof parsed.operationType === "string" ? parsed.operationType : "update";
        const col = typeof parsed.path === "string" ? parsed.path.split("/")[0] : "";
        const errLower = parsed.error.toLowerCase();
        if (errLower.includes("missing or insufficient permissions")) {
          msg = col
            ? `Permission denied while attempting to ${op} ${col}. Verify your workspace access.`
            : "Permission denied for this workspace action.";
        } else if (errLower.includes("invalid data") || errLower.includes("unsupported field value")) {
          msg = col
            ? `Invalid record data rejected for ${col}. Please verify your fields and retry.`
            : "Invalid record data. Please verify your fields and retry.";
        } else if (errLower.includes("not-found") || errLower.includes("no document to update")) {
          msg = col
            ? `Target record in ${col} was not found or has been removed. Refresh and try again.`
            : "Target record was not found. Refresh and try again.";
        } else if (errLower.includes("client is offline") || errLower.includes("unavailable")) {
          msg = "Database temporarily unreachable. Check your connection and try again.";
        } else {
          msg = parsed.error;
        }
      }
    } catch {
      // keep raw message
    }
  }

  msg = msg
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\b(uid|userId|providerId|emailVerified)\s*[:=]\s*["']?[^"'\s,}]+["']?/gi, "$1:[redacted]");
  return msg.trim() || fallback;
}
