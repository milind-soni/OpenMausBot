import { t } from "./i18n";

const TYPED_MAX = 28;

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** One short line for a step a bot takes on its computer ("Opening en.wikipedia.org", "Typing “Lisbon”"); null when the
 * tool is not a computer step, so the caller keeps its usual label. */
export function computerStepLine(tool: { name: string; input?: unknown }): string | null {
  const step = /(?:^|__)computer__(\w+)$/.exec(tool.name)?.[1] ?? null;
  if (!step) return null;
  const input = inputOf(tool.input);
  if (step === "open_url") {
    try { return t("mapComputer.step.open", { site: new URL(String(input.url)).hostname.replace(/^www\./, "") }); } catch { return t("mapComputer.step.openPage"); }
  }
  if (step === "type_text" && typeof input.text === "string" && input.text.trim()) {
    const text = input.text.replace(/\s+/g, " ").trim();
    return t("mapComputer.step.type", { text: text.length > TYPED_MAX ? `${text.slice(0, TYPED_MAX)}…` : text });
  }
  if (step === "key_press") {
    const keys = [input.keys, input.key, input.combo].find((value) => typeof value === "string" || Array.isArray(value));
    const label = Array.isArray(keys) ? keys.join("+") : typeof keys === "string" ? keys : "";
    return label ? t("mapComputer.step.key", { keys: label.slice(0, 24) }) : t("mapComputer.step.keyAny");
  }
  if (step === "click" || step === "double_click" || step === "right_click") return t("mapComputer.step.click");
  if (step === "scroll") return t("mapComputer.step.scroll");
  if (step === "screenshot") return t("mapComputer.step.look");
  if (step === "drag") return t("mapComputer.step.drag");
  return null;
}
