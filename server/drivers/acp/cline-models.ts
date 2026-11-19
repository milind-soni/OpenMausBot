// Cline's free and ClinePass models, which `cline --acp` does not list: its ACP agent lists only the models of the
// session's provider, yet takes a model it did not list. Cline's recommended-models list is public; the CLI reads it
// without the account.
import type { ModelCatalog } from "../../contracts.ts";

export const CLINE_RECOMMENDED_MODELS_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const FETCH_TIMEOUT_MS = 3_000;

type Entry = { id: string; name?: string };
type Option = ModelCatalog["options"][number];

const FREE_FALLBACK: Entry[] = [
  { id: "cline-free/minimax-m3.1-flash", name: "Minimax M3.1 Flash" },
  { id: "cline-free/nemotron-3.5-super-vl", name: "Nemotron 3.5 Super VL" },
  { id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash" },
  { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
  { id: "cline-free/solar-mini4", name: "Solar Mini 4" },
];

const PASS_FALLBACK: Entry[] = [
  "cline-pass/deepseek-v4.1-flash-1017",
  "cline-pass/deepseek-v4-pro",
  "cline-pass/glm-5.3",
  "cline-pass/glm-5.3-flash",
  "cline-pass/kimi-k3.1-pro",
  "cline-pass/muse-spark-1.3-contributor",
  "cline-pass/kimi-k3",
  "cline-pass/qwen3.8-max",
  "cline-pass/minimax-m3.1-flash",
].map((id) => ({ id }));

/** The Cline provider a tier model runs on: ClinePass on the subscription, the free tier on Cline's own account. */
export function clineTierProvider(model: string | undefined): "cline-pass" | "cline" | undefined {
  return model?.startsWith("cline-pass/") ? "cline-pass" : model?.startsWith("cline-free/") ? "cline" : undefined;
}

function option(entry: Entry, tier: string): Option {
  const given = entry.name?.trim();
  const name = given && given !== entry.id ? given : entry.id.slice(entry.id.indexOf("/") + 1);
  return { id: entry.id, label: name.toLowerCase().endsWith(`(${tier.toLowerCase()})`) ? name : `${name} (${tier})` };
}

function tierOptions(pass: Entry[], free: Entry[]): Option[] {
  return [
    ...pass.filter((entry) => clineTierProvider(entry.id) === "cline-pass").map((entry) => option(entry, "ClinePass")),
    ...free.filter((entry) => clineTierProvider(entry.id) === "cline").map((entry) => option(entry, "free")),
  ];
}

function entries(value: unknown): Entry[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry): entry is Entry => typeof entry?.id === "string" && (entry.name === undefined || typeof entry.name === "string"));
  return list.length === value.length ? list : null;
}

let last: Option[] = tierOptions(PASS_FALLBACK, FREE_FALLBACK);

/** The ClinePass models of the last list read, which share one allowance. */
export function clinePassModels(): string[] {
  return last.flatMap((entry) => clineTierProvider(entry.id) === "cline-pass" ? [entry.id] : []);
}

/** The free and ClinePass models, ClinePass first. A list that cannot be read gives the last one that could, then the
 * bundled one; never throws. */
export async function clineTierModels(fetchImpl: typeof fetch = fetch): Promise<Option[]> {
  try {
    const response = await fetchImpl(CLINE_RECOMMENDED_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return last;
    const body = await response.json() as { free?: unknown; clinePass?: unknown };
    const free = entries(body?.free);
    const pass = body?.clinePass === undefined ? [] : entries(body.clinePass);
    if (!free || !pass) return last;
    // An empty tier is an answer: Cline can end one, and the picker must not keep the old list.
    last = tierOptions(pass, free);
  } catch {}
  return last;
}
