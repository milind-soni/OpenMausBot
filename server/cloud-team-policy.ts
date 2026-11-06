// A Team Cloud's rules: one document the team's Owner and Admins keep on the Admin (openmaus-cloud docs/team-cloud.md
// "Rules"). The Cloud fetches it signed with its bootstrap secret at boot, on a timer and when the Admin nudges it,
// keeps the last valid one on its volume, and feeds the one enforcement every caller already passes (managed-policy.ts).
// Security invariants: the rules only restrict, and a change applies without a restart. Kept rules never lapse: an Admin
// that can't be reached leaves them in force. A document this version can't read leaves the last good one in force.
// The cache is 0600, no backup carries it, it is bound to this team and ignored unless it validates, and it holds nothing
// that could redirect a fetch.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { CloudHomeConfig } from "./cloud-home.ts";
import type { CloudTeam } from "./cloud-team.ts";
import type { ManagedDesktopPolicy, ManagedPolicy } from "./managed-policy.ts";
import { TEAM_PHONE_PAIRING_PATH } from "./routes/team-phone.ts";
import type { SessionRegistry } from "./sessions.ts";

export const TEAM_POLICY_SCHEMA = 1;
/** On the Admin; must match openmaus-cloud's TEAM_POLICY_MACHINE_PATH. */
export const TEAM_POLICY_ADMIN_PATH = "/api/cloud/machines/team-policy";
/** The Admin's signed word that the rules changed: `{}`, fetched at once rather than at the next timer. */
export const CLOUD_TEAM_POLICY_CHANGED_PATH = "/api/cloud/team/policy-changed";
/** In the data folder; excluded from backups (workspace-backup-policy.ts): a restored Cloud asks the Admin. */
export const TEAM_POLICY_FILE = "team-policy.json";
export const TEAM_POLICY_REFRESH_MS = 5 * 60_000;
/** A team that requires fresh rules refuses new turns once the last good fetch is this old: three missed refreshes. */
export const TEAM_POLICY_FRESH_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 15_000, KICK_GAP_MS = 30_000, ANSWER_MAX_BYTES = 256 * 1024;

const allowed = <T extends z.ZodType>(entry: T, max: number) => z.union([z.literal("all"), z.array(entry).max(max)]);
/** Omitted, or a permissive value: allowed. Only an explicit restriction restricts, and nothing can force anything on. */
const limitsSchema = z.object({
  allowedEngines: allowed(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), 64).optional(),
  allowedApps: allowed(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), 200).optional(),
  /** `"team"`: only what the team's admins add; a list: only those, whoever adds them. */
  allowedMcpServers: z.union([z.literal("team"), allowed(z.string().trim().min(1).max(200), 100)]).optional(),
  allowedComputers: allowed(z.enum(["cloudDesktop", "vps", "memberComputer"]), 3).optional(),
  remoteAccess: z.enum(["allowed", "off"]).optional(),
  requireFreshPolicy: z.boolean().optional(),
}).strict();
/** Unknown keys are refused here too: a key this version can't enforce must not look enforced. */
export const teamPolicyDocumentSchema = z.object({ schema: z.literal(TEAM_POLICY_SCHEMA), limits: limitsSchema }).strict();
export type TeamPolicyDocument = z.infer<typeof teamPolicyDocumentSchema>;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);
const answerSchema = z.object({
  policy: z.object({ version: z.number().int().min(0).max(2_147_483_647), fingerprint: fingerprintSchema, document: z.unknown() }).nullable(),
});
const storedSchema = z.object({ v: z.literal(1), teamId: z.string(), version: z.number().int().min(0).max(2_147_483_647), fingerprint: fingerprintSchema, document: teamPolicyDocumentSchema, fetchedAt: z.number() });
type Stored = z.infer<typeof storedSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
/** Must match openmaus-cloud's teamPolicyFingerprint: its keys sorted, sixteen hex digits of its SHA-256. */
export function teamPolicyFingerprint(document: unknown): string {
  return createHash("sha256").update(canonical(document)).digest("hex").slice(0, 16);
}
/** Must match openmaus-cloud's teamPolicySignature. */
export function teamPolicySignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`omb-team-policy-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

/** The document in the one shape every refusal site reads. Null when it restricts nothing, as with no document at all. */
export function teamManagedPolicy(document: TeamPolicyDocument, team: Pick<CloudTeam, "id" | "name">, version: number): ManagedPolicy | null {
  const { allowedEngines = "all", allowedApps = "all", allowedMcpServers = "all", allowedComputers = "all", remoteAccess = "allowed", requireFreshPolicy = false } = document.limits;
  if (allowedEngines === "all" && allowedApps === "all" && allowedMcpServers === "all" && allowedComputers === "all" && remoteAccess === "allowed" && !requireFreshPolicy) return null;
  const computer = (kind: "cloudDesktop" | "vps" | "memberComputer") => allowedComputers === "all" || allowedComputers.includes(kind);
  return {
    organizationId: team.id, organizationName: team.name, expiresAt: null, version, companyModelsOnly: false,
    allowedEngines,
    mcp: allowedMcpServers === "all" || allowedMcpServers === "team" ? { allowCustom: true, allowlist: [] } : { allowCustom: false, allowlist: allowedMcpServers },
    apps: allowedApps === "all" ? { allowAll: true, allowlist: [] } : { allowAll: false, allowlist: allowedApps },
    computers: { thisComputer: computer("memberComputer"), localVm: computer("memberComputer"), box: computer("cloudDesktop"), vps: computer("vps") },
    remoteAccess: remoteAccess !== "off",
    team: { requireFresh: requireFreshPolicy, ownMcpOnly: allowedMcpServers === "team" },
  };
}

/** The POST paths the remote-access limit refuses. On a Team Cloud the Admin-signed pairing is how every member's app, and
 * the Admin itself, reach it, so refusing `/api/auth/pair` would lock the whole team out: there, only what a member's own
 * code opens counts as remote access (the sessions of those codes end when the limit lands: `closeMemberPhones`). */
export function remoteAccessPaths(team: boolean): readonly string[] {
  return team ? ["/api/auth/pairing", TEAM_PHONE_PAIRING_PATH] : ["/api/auth/pair", "/api/pair", "/api/auth/pairing", "/api/auth/email/start", "/api/auth/email/verify"];
}

/** What a document's refusal says of itself, for the Rules page: which key, never a value. */
function documentProblem(document: unknown): string {
  const parsed = teamPolicyDocumentSchema.safeParse(document);
  if (parsed.success) return "";
  const schema = (document as { schema?: unknown } | null)?.schema;
  if (schema !== TEAM_POLICY_SCHEMA) return `rules of a newer kind (schema ${typeof schema === "number" ? schema : "unknown"})`;
  const issue = parsed.error.issues[0], keys = (issue as { keys?: string[] } | undefined)?.keys;
  return `${[...(issue?.path ?? []).map(String), ...(keys?.length ? [keys[0]] : [])].join(".") || "the document"} can't be read`;
}

interface Timer { unref?(): unknown }

export interface TeamPolicyClientOptions {
  team: Pick<CloudTeam, "id" | "name">;
  machineId: string;
  adminOrigin: string;
  secret: string;
  dataDir: string;
  apply(policy: ManagedPolicy | null): void;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export interface TeamPolicyClient {
  /** Fetch now, at once if none is in flight, else right after it. */
  nudge(): void;
  /** Whether the Admin confirmed the rules recently. */
  fresh(): boolean;
  /** The fetch in flight or last finished; it never rejects. */
  settled(): Promise<void>;
  status(): { fingerprint: string | null; version: number | null; problem: string | null; fetchedAt: number | null };
  stop(): void;
}

export function startTeamPolicyClient(options: TeamPolicyClientOptions): TeamPolicyClient {
  const file = join(options.dataDir, TEAM_POLICY_FILE);
  const now = options.now ?? Date.now, log = options.log ?? (() => {}), random = options.random ?? Math.random;
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let held: Stored | null = null, problem: string | null = null, fetchedAt: number | null = null;
  let timer: Timer | null = null, stopped = false, running = false, again = false, lastKick = 0;
  let current: Promise<void> = Promise.resolve();

  /** False when the rules could not be put in force: the last good ones stay, and the Admin hears why. */
  const putInForce = (next: Stored | null): boolean => {
    try {
      options.apply(next ? teamManagedPolicy(next.document, options.team, next.version) : null);
      return true;
    } catch (error) {
      log(`team rules: could not apply them: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const save = (stored: Stored) => {
    try { writeFileAtomic(file, `${JSON.stringify(stored)}\n`, { mode: 0o600 }); } catch (error) {
      log(`team rules: could not keep them on this Cloud: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  };

  const read = (): Stored | null => {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { return null; }
    let parsed: z.ZodSafeParseResult<Stored>;
    try { parsed = storedSchema.safeParse(JSON.parse(raw)); } catch { log("team rules: the kept copy can't be read; asking the Admin"); return null; }
    if (!parsed.success || parsed.data.teamId !== options.team.id || teamPolicyFingerprint(parsed.data.document) !== parsed.data.fingerprint) {
      log("team rules: the kept copy can't be used; asking the Admin");
      return null;
    }
    return parsed.data;
  };

  const lift = () => {
    if (held || problem) log("team rules: the Admin holds none now; nothing is restricted");
    if (putInForce(null)) { held = null; problem = null; }
    rmSync(file, { force: true });
  };

  /** One signed ask, which also reports what is in force here. A failure changes nothing: what is held stays. */
  const ask = async (): Promise<void> => {
    const body = JSON.stringify({ v: 1, loaded: held ? { fingerprint: held.fingerprint, version: held.version } : null, problem });
    const timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(18).toString("base64url");
    let response: Response;
    try {
      response = await fetcher(`${options.adminOrigin}${TEAM_POLICY_ADMIN_PATH}`, { method: "POST", redirect: "error", cache: "no-store", body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: {
        accept: "application/json", "content-type": "application/json", "x-omb-cloud-machine": options.machineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${teamPolicySignature(options.secret, options.machineId, timestamp, nonce, body)}`,
      } });
    } catch (error) {
      log(`team rules: the Admin can't be reached (${error instanceof Error ? error.name : "error"}); keeping the last rules`);
      return;
    }
    // An older Admin, or the Admin's own switch off, says so in JSON; anything else in the way is not its word.
    const json = /^application\/json\b/i.test(response.headers.get("content-type") ?? "");
    if (response.status === 404 && json) { await response.body?.cancel().catch(() => {}); fetchedAt = now(); lift(); return; }
    if (response.status !== 200 || !json) {
      await response.body?.cancel().catch(() => {});
      log(`team rules: the Admin answered HTTP ${response.status}; keeping the last rules`);
      return;
    }
    const text = await response.text().catch(() => "");
    let parsed: z.ZodSafeParseResult<z.infer<typeof answerSchema>>;
    try { parsed = text.length > ANSWER_MAX_BYTES ? answerSchema.safeParse(null) : answerSchema.safeParse(JSON.parse(text)); } catch { parsed = answerSchema.safeParse(null); }
    if (!parsed.success) { log("team rules: the Admin's answer can't be read; keeping the last rules"); return; }
    const policy = parsed.data.policy;
    if (!policy) { fetchedAt = now(); lift(); return; }
    const document = teamPolicyDocumentSchema.safeParse(policy.document);
    if (!document.success || teamPolicyFingerprint(policy.document) !== policy.fingerprint) {
      const why = document.success ? "they don't match their fingerprint" : documentProblem(policy.document);
      if (problem !== why) log(`team rules: ${why}; keeping the last rules`);
      problem = why;
      return;
    }
    fetchedAt = now();
    const next: Stored = { v: 1, teamId: options.team.id, version: policy.version, fingerprint: policy.fingerprint, document: document.data, fetchedAt };
    if (held?.fingerprint === next.fingerprint) {
      problem = null;
      if (held.version !== next.version || next.document.limits.requireFreshPolicy) { held = next; save(next); }
      return;
    }
    if (!putInForce(next)) { problem = "they could not be applied"; return; }
    held = next; problem = null;
    save(next);
    log(`team rules: version ${next.version} (${next.fingerprint}) in force`);
  };

  const told = () => `${held?.fingerprint ?? ""}\n${problem ?? ""}`;
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; run(); }, Math.round(TEAM_POLICY_REFRESH_MS * (1 + 0.2 * random())));
    timer.unref?.();
  };
  const fetchRound = async (): Promise<void> => {
    try {
      // A change is reported at once, so the Rules page can say it is in force without waiting for the next refresh.
      for (let round = 0; round < 2 && !stopped; round++) {
        const before = told();
        await ask();
        if (told() === before) break;
      }
    } catch (error) {
      log(`team rules: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const run = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    current = (async () => {
      do { again = false; await fetchRound(); } while (again && !stopped);
      running = false;
      schedule();
    })();
  };

  const kept = read();
  if (kept && putInForce(kept)) { held = kept; fetchedAt = kept.fetchedAt; }
  run();

  return {
    nudge: run,
    fresh() {
      const isFresh = fetchedAt !== null && now() - fetchedAt <= TEAM_POLICY_FRESH_MS;
      // A Cloud that was asleep past its timer asks now, so the person's next try can pass.
      if (!isFresh && now() - lastKick >= KICK_GAP_MS) { lastKick = now(); run(); }
      return isFresh;
    },
    settled: () => current,
    status: () => ({ fingerprint: held?.fingerprint ?? null, version: held?.version ?? null, problem, fetchedAt }),
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

let cloudTeam: TeamPolicyClient | null = null;

/** A Team Cloud only; a My Cloud has no team, no rules and no fetch. */
export function startCloudTeamPolicy(input: { cloudHome: CloudHomeConfig | null; dataDir: string; managed: ManagedDesktopPolicy; sessions: Pick<SessionRegistry, "closeMemberPhones"> }): void {
  const { cloudHome, managed, sessions } = input;
  if (!cloudHome?.team || cloudTeam) return;
  cloudTeam = startTeamPolicyClient({
    team: cloudHome.team, machineId: cloudHome.machineId, adminOrigin: cloudHome.adminOrigin, secret: cloudHome.bootstrapSecret, dataDir: input.dataDir,
    log: (line) => console.log(`team cloud: ${line}`),
    apply: (policy) => {
      managed.apply(policy);
      if (policy && !policy.remoteAccess) sessions.closeMemberPhones();
    },
  });
  const client = cloudTeam;
  managed.setFreshness(() => client.fresh());
}

export function nudgeCloudTeamPolicy(): void { cloudTeam?.nudge(); }

export function stopCloudTeamPolicy(): void {
  cloudTeam?.stop();
  cloudTeam = null;
}
