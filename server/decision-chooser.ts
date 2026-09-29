// The chooser half of the opt-in decision model (issue #1630). On an
// eligible computer-use step — the agent asking for a fresh screenshot —
// this module builds a bounded choice request from the accessibility
// state of the active window, asks the calibrated decision model, and
// performs the click itself when the model clears the confidence
// threshold. Every other outcome (abstain, reobserve, low confidence,
// any error) falls back to the ordinary screenshot + LLM loop, silently:
// a chooser failure must never break a run.
//
// The request contract is ported from the upstream validated example
// (cua-driver examples/jev-use/typescript/choose_action.ts, MIT):
// 2-32 candidates, at most 100 regions, at most 16 history entries, a
// 64 KiB wire cap, strict candidate IDs, and mandatory reobserve/abstain.
import type { DecisionModelClient } from "./decision-model.ts";

export const REQUEST_SCHEMA = "cua.jev_choice_request_v1";
export const RESPONSE_SCHEMA = "cua.jev_choice_v1";
export const MAX_CHOICE_BYTES = 65_536;
const MAX_CANDIDATES = 32;
const MAX_REGIONS = 100;
const MAX_HISTORY = 16;
const MAX_CLICK_CANDIDATES = 30;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DECIDE_TIMEOUT_MS = 12_000;
const CHOOSER_ERROR_BUDGET = 3;

type JsonRecord = Record<string, unknown>;

export type ValidatedRequest = {
  goal: string;
  capture_id: string;
  regions: JsonRecord[];
  history: Array<{ selected_id?: string; outcome?: string }>;
  candidates: Array<{ id: string; description: string }>;
};

function record(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as JsonRecord;
}

function boundedString(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`${name} must be a nonempty string of at most ${limit} characters`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = boundedString(value, name, 64);
  if (!ID_PATTERN.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function validateRequest(value: unknown): ValidatedRequest {
  const root = record(value, "request must be a JSON object");
  const rootKeys = ["candidates", "capture_id", "goal", "history", "regions", "schema"];
  if (!exactKeys(root, rootKeys) || root.schema !== REQUEST_SCHEMA) {
    throw new Error(`request must match ${REQUEST_SCHEMA}`);
  }
  const goal = boundedString(root.goal, "goal", 4_000);
  const captureId = boundedString(root.capture_id, "capture_id", 256);

  if (!Array.isArray(root.regions) || root.regions.length > MAX_REGIONS) {
    throw new Error(`regions must be an array of at most ${MAX_REGIONS} items`);
  }
  const regionIds = new Set<string>();
  const regions = root.regions.map((item) => {
    const raw = record(item, "region must be an object");
    const allowed = new Set(["id", "kind", "bounds", "text", "label", "confidence", "interactive"]);
    if (
      Object.keys(raw).some((key) => !allowed.has(key)) ||
      !["id", "kind", "bounds", "confidence", "interactive"].every((key) => key in raw)
    ) {
      throw new Error("region has unsupported or missing fields");
    }
    const id = boundedString(raw.id, "region id", 256);
    if (regionIds.has(id)) throw new Error("region IDs must be unique");
    regionIds.add(id);
    if (raw.kind !== "text" && raw.kind !== "icon") {
      throw new Error("region kind must be text or icon");
    }
    const bounds = record(raw.bounds, "region bounds must be an object");
    if (!exactKeys(bounds, ["height", "width", "x", "y"])) {
      throw new Error("region bounds have unsupported or missing fields");
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      const number = bounds[key];
      const minimum = key === "x" || key === "y" ? 0 : 1;
      if (!Number.isInteger(number) || Number(number) < minimum) {
        throw new Error("region bounds must contain valid integers");
      }
    }
    const text = raw.text === undefined || raw.text === null ? null : boundedString(raw.text, "region text", 1_000);
    const label = raw.label === undefined || raw.label === null ? null : boundedString(raw.label, "region label", 1_000);
    if ((raw.kind === "text" && text === null) || (raw.kind === "icon" && label === null)) {
      throw new Error("region is missing content required by its kind");
    }
    if (
      typeof raw.confidence !== "number" ||
      !Number.isFinite(raw.confidence) ||
      raw.confidence < 0 ||
      raw.confidence > 1
    ) {
      throw new Error("region confidence must be between zero and one");
    }
    if (typeof raw.interactive !== "boolean") {
      throw new Error("region interactive must be boolean");
    }
    return {
      id,
      kind: raw.kind,
      bounds: { ...bounds },
      text,
      label,
      confidence: raw.confidence,
      interactive: raw.interactive,
    };
  });

  if (!Array.isArray(root.history) || root.history.length > MAX_HISTORY) {
    throw new Error(`history must be an array of at most ${MAX_HISTORY} items`);
  }
  const history = root.history.map((item) => {
    const raw = record(item, "history item must be an object");
    if (Object.keys(raw).length === 0 || Object.keys(raw).some((key) => key !== "selected_id" && key !== "outcome")) {
      throw new Error("history contains a forbidden field");
    }
    return {
      ...("selected_id" in raw ? { selected_id: identifier(raw.selected_id, "history selected_id") } : {}),
      ...("outcome" in raw ? { outcome: boundedString(raw.outcome, "history outcome", 128) } : {}),
    };
  });

  if (!Array.isArray(root.candidates) || root.candidates.length < 2 || root.candidates.length > MAX_CANDIDATES) {
    throw new Error(`candidates must contain between 2 and ${MAX_CANDIDATES} items`);
  }
  const candidateIds = new Set<string>();
  const candidates = root.candidates.map((item) => {
    const raw = record(item, "candidate must be an object");
    if (!exactKeys(raw, ["description", "id"])) {
      throw new Error("candidate may contain only id and description");
    }
    const id = identifier(raw.id, "candidate id");
    if (candidateIds.has(id)) throw new Error("candidate IDs must be unique");
    candidateIds.add(id);
    return { id, description: boundedString(raw.description, "description", 1_000) };
  });
  if (!candidateIds.has("reobserve") || !candidateIds.has("abstain")) {
    throw new Error("candidates must include reobserve and abstain");
  }
  return { goal, capture_id: captureId, regions, history, candidates };
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function asElements(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .slice(0, 512);
}

/** Where the interactive elements live in a get_window_state answer. The
 * driver shape has drifted across versions, so every known spelling is
 * accepted — and an unknown shape yields no elements, which simply
 * forwards the screenshot. */
export function windowStateElements(payload: JsonRecord): JsonRecord[] {
  for (const key of ["elements", "accessibility_tree", "ax_tree", "tree"]) {
    const value = payload[key];
    if (Array.isArray(value)) return asElements(value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = asElements((value as JsonRecord).elements);
      if (nested.length) return nested;
    }
  }
  return [];
}

const ACTIVATION_ROLES = new Set([
  "button", "push button", "icon button", "link", "checkbox", "radio", "menuitem", "menu item",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "toggle", "option", "combobox",
  "listbox", "textbox", "text field", "searchbox", "slider", "spinbutton",
]);

function elementText(element: JsonRecord): string {
  for (const key of ["name", "label", "text", "title", "value"]) {
    const value = element[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function elementRole(element: JsonRecord): string {
  for (const key of ["role", "role_description", "kind", "type"]) {
    const value = element[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

function elementBounds(element: JsonRecord): { x: number; y: number; width: number; height: number } | null {
  for (const key of ["bounds", "frame", "rect", "position"]) {
    const value = element[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as JsonRecord;
    const x = raw.x ?? raw.left;
    const y = raw.y ?? raw.top;
    const { width, height } = raw;
    if ([x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) {
      const bounds = {
        x: Math.round(x as number),
        y: Math.round(y as number),
        width: Math.max(1, Math.round(width as number)),
        height: Math.max(1, Math.round(height as number)),
      };
      // The wire contract requires non-negative x/y, but a window on a
      // monitor left of or above the primary can still report global
      // coordinates. Skip such an element — the screenshot loop carries
      // it — instead of failing the whole request and burning the error
      // budget on a legal observation.
      if (bounds.x < 0 || bounds.y < 0) continue;
      return bounds;
    }
  }
  return null;
}

function elementActivatable(element: JsonRecord, role: string): boolean {
  if (element.interactive === true || element.clickable === true) return true;
  return ACTIVATION_ROLES.has(role);
}

export type ClickTarget = {
  x: number;
  y: number;
  description: string;
  captureId?: string;
  pid?: number;
  windowId?: number;
};

export type BuiltChoice = {
  request: {
    schema: string;
    goal: string;
    capture_id: string;
    regions: JsonRecord[];
    history: Array<{ selected_id?: string; outcome?: string }>;
    candidates: Array<{ id: string; description: string }>;
  };
  clicks: Map<string, ClickTarget>;
};

/** Candidates from an accessibility snapshot: one clickable region per
 * activatable element, deduplicated, capped at the contract bounds, plus
 * the mandatory reobserve and abstain escapes. Null means "nothing to
 * decide over" — the screenshot is forwarded untouched. */
export function buildChoice(options: {
  goal: string;
  captureId: string;
  elements: JsonRecord[];
  history: Array<{ selected_id?: string; outcome?: string }>;
  pid?: number;
  windowId?: number;
}): BuiltChoice | null {
  const regions: JsonRecord[] = [];
  const candidates: Array<{ id: string; description: string }> = [];
  const clicks = new Map<string, ClickTarget>();
  const seen = new Set<string>();
  for (const element of options.elements) {
    if (regions.length >= MAX_REGIONS || candidates.length >= MAX_CLICK_CANDIDATES) break;
    const bounds = elementBounds(element);
    const role = elementRole(element);
    if (!bounds || !elementActivatable(element, role)) continue;
    const label = elementText(element) || role || "control";
    const center = {
      x: bounds.x + Math.floor(bounds.width / 2),
      y: bounds.y + Math.floor(bounds.height / 2),
    };
    const signature = `${role}|${label}|${center.x},${center.y}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const regionId = `r${regions.length}`;
    regions.push({
      id: regionId,
      kind: "text",
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      text: label.slice(0, 1_000),
      label: (role || "control").slice(0, 1_000),
      confidence: 0.95,
      interactive: true,
    });
    const candidateId = `click:${candidates.length}`;
    const description = `Click ${label.slice(0, 140)} at ${center.x},${center.y}`.slice(0, 1_000);
    candidates.push({ id: candidateId, description });
    clicks.set(candidateId, {
      x: center.x,
      y: center.y,
      description,
      captureId: options.captureId,
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
    });
  }
  if (!candidates.length) return null;
  candidates.push({ id: "reobserve", description: "Look again before deciding; the screen may have changed." });
  candidates.push({ id: "abstain", description: "Decline to answer; let the main model decide." });
  return {
    request: {
      schema: REQUEST_SCHEMA,
      goal: options.goal.slice(0, 4_000),
      capture_id: options.captureId,
      regions,
      history: options.history.slice(-MAX_HISTORY),
      candidates,
    },
    clicks,
  };
}

/** Unwrap a driver answer: the MCP result envelope first (structured
 * content, then JSON/text content items), then the driver payload
 * itself. Unknown shapes yield null, which forwards the screenshot. */
export function decisionPayload(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as JsonRecord;
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as JsonRecord;
  }
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as JsonRecord;
      if (entry.type === "json" && entry.json && typeof entry.json === "object" && !Array.isArray(entry.json)) {
        return entry.json as JsonRecord;
      }
      if (entry.type === "text" && typeof entry.text === "string" && entry.text.trim().startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(entry.text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonRecord;
        } catch {
          // not JSON after all
        }
      }
    }
  }
  for (const key of ["capture_id", "elements", "accessibility_tree", "ax_tree", "tree", "pid", "window_id"]) {
    if (key in result) return result;
  }
  return null;
}

export type DecisionReport = {
  outcome: "acted" | "abstained" | "reobserve" | "below-threshold" | "superseded" | "error";
  selectedId?: string;
  confidence?: number;
  model?: string;
  detail?: string;
};

export interface InterceptedCall {
  id: number | string;
  name: string;
  arguments: unknown;
}

export type ChooserDecision = { handled: boolean; text?: string };

export interface DecisionChooser {
  /** handled=true answers the call with `text`; handled=false forwards
   * the original frame to the driver untouched. */
  intercept(call: InterceptedCall): Promise<ChooserDecision>;
}

export function createDecisionChooser(options: {
  client: DecisionModelClient;
  threshold: number;
  goal: () => Promise<string | null>;
  report: (report: DecisionReport) => void;
  callDriver: (name: string, args: JsonRecord) => Promise<unknown>;
  /** Re-checked immediately before a click. The gate cleared the frame
   * before the decision started, but a human can take control while the
   * model thinks; same contract as the gate's isHeld. */
  isHeld: () => Promise<boolean>;
}): DecisionChooser {
  const history: Array<{ selected_id?: string; outcome?: string }> = [];
  let consecutiveErrors = 0;
  let disabled = false;

  const fail = (detail: string): ChooserDecision => {
    consecutiveErrors += 1;
    if (consecutiveErrors >= CHOOSER_ERROR_BUDGET) {
      const first = !disabled;
      disabled = true;
      if (first) {
        options.report({
          outcome: "error",
          detail: `${detail}; chooser disabled for the rest of this run after repeated errors`,
        });
      }
      return { handled: false };
    }
    options.report({ outcome: "error", detail });
    return { handled: false };
  };

  return {
    async intercept(call) {
      if (call.name !== "screenshot") return { handled: false };
      if (disabled) return { handled: false };
      let goal: string | null = null;
      try {
        goal = await options.goal();
      } catch {
        goal = null;
      }
      if (!goal || !goal.trim()) return { handled: false };
      let state: unknown;
      try {
        state = await options.callDriver("get_window_state", { include_accessibility_tree: true });
      } catch (error) {
        return fail(`window state unavailable: ${messageOf(error)}`);
      }
      const payload = decisionPayload(state);
      const captureId =
        typeof payload?.capture_id === "string" && payload.capture_id.trim() ? payload.capture_id : null;
      if (!payload || !captureId) {
        // Nothing decision-shaped to reason over; the loop continues.
        return { handled: false };
      }
      const pid = typeof payload.pid === "number" && Number.isFinite(payload.pid) ? payload.pid : undefined;
      const windowId =
        typeof payload.window_id === "number" && Number.isFinite(payload.window_id) ? payload.window_id : undefined;
      const built = buildChoice({
        goal,
        captureId,
        elements: windowStateElements(payload),
        history: [...history],
        ...(pid !== undefined ? { pid } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
      });
      if (!built) return { handled: false };
      try {
        validateRequest(built.request);
      } catch (error) {
        return fail(`choice request invalid: ${messageOf(error)}`);
      }
      if (Buffer.byteLength(JSON.stringify(built.request), "utf8") > MAX_CHOICE_BYTES) {
        return fail("choice request exceeds the wire cap");
      }
      const criteria = Object.fromEntries(
        built.request.candidates.map((candidate) => [candidate.id, candidate.description]),
      );
      const observation = JSON.stringify({
        capture_id: built.request.capture_id,
        regions: built.request.regions,
        history: built.request.history,
      });
      let decision;
      let decisionTimeout: ReturnType<typeof setTimeout> | undefined;
      const decisionAbort = new AbortController();
      try {
        decision = await Promise.race([
          options.client.decide({
            state: { goal: built.request.goal, observation },
            criteria,
            instructions: "Select exactly one supplied candidate ID for the next computer action.",
            signal: decisionAbort.signal,
          }),
          new Promise<never>((_, reject) => {
            decisionTimeout = setTimeout(() => {
              decisionAbort.abort();
              reject(new Error("decision timed out"));
            }, DECIDE_TIMEOUT_MS);
            decisionTimeout.unref?.();
          }),
        ]);
      } catch (error) {
        return fail(`decision failed: ${messageOf(error)}`);
      } finally {
        if (decisionTimeout) clearTimeout(decisionTimeout);
      }
      const remember = (outcome: string) => {
        // Only a fully processed outcome clears the error budget: a
        // decision that resolves but cannot be honored (an unknown
        // candidate) is still a chooser malfunction and still counts.
        consecutiveErrors = 0;
        history.push({ selected_id: decision.selectedId, outcome });
        while (history.length > MAX_HISTORY) history.shift();
      };
      const model = typeof decision.model === "string" && decision.model ? decision.model : undefined;
      if (decision.selectedId === "abstain") {
        remember("abstained");
        options.report({
          outcome: "abstained",
          ...(model ? { model } : {}),
          ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        });
        return { handled: false };
      }
      if (decision.selectedId === "reobserve") {
        remember("reobserve");
        options.report({
          outcome: "reobserve",
          ...(model ? { model } : {}),
          ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        });
        return { handled: false };
      }
      const target = built.clicks.get(decision.selectedId);
      if (!target) return fail("decision selected an unknown candidate");
      if (decision.confidence < options.threshold) {
        remember("below-threshold");
        options.report({
          outcome: "below-threshold",
          selectedId: decision.selectedId,
          confidence: decision.confidence,
          ...(model ? { model } : {}),
        });
        return { handled: false };
      }
      // A hold acquired while the decision was in flight beats the
      // decision: ownership is re-checked immediately before the click,
      // and a check that cannot run is treated as a failure, never as
      // permission. Either way the screenshot falls back to the loop.
      let held = false;
      try {
        held = await options.isHeld();
      } catch (error) {
        return fail(`control ownership check failed: ${messageOf(error)}`);
      }
      if (held) {
        remember("superseded");
        options.report({
          outcome: "superseded",
          selectedId: decision.selectedId,
          confidence: decision.confidence,
          ...(model ? { model } : {}),
        });
        return { handled: false };
      }
      let clicked: unknown;
      try {
        clicked = await options.callDriver("click", {
          x: target.x,
          y: target.y,
          ...(target.captureId ? { capture_id: target.captureId } : {}),
          ...(target.pid !== undefined ? { pid: target.pid } : {}),
          ...(target.windowId !== undefined ? { window_id: target.windowId } : {}),
        });
      } catch (error) {
        return fail(`click failed: ${messageOf(error)}`);
      }
      if (!clicked || (typeof clicked === "object" && !Array.isArray(clicked) && (clicked as JsonRecord).isError === true)) {
        return fail("the click was not confirmed");
      }
      remember("acted");
      options.report({
        outcome: "acted",
        selectedId: decision.selectedId,
        confidence: decision.confidence,
        ...(model ? { model } : {}),
      });
      return {
        handled: true,
        text:
          `A decision model acted for this step (confidence ${Math.round(decision.confidence * 100)}%): ` +
          `${target.description}. No screenshot was taken. Verify the result with your next tool call if this step matters.`,
      };
    },
  };
}
