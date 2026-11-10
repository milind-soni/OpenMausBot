// A Team Cloud's roster check: every few minutes it asks the Admin, signed with its bootstrap secret, whether the people
// whose sessions are in use and about to end are still in the team, and at which role (openmaus-cloud docs/team-cloud.md "A
// session that lives without a desktop"). A member found at their role keeps their sessions another hour, so a browser or a
// phone stays signed in with no desktop re-pairing for it; anyone the Admin no longer lists is signed out at once.
// Security invariants: membership is the Admin's word only, read fresh, about this Cloud's own team. No answer changes
// nothing, so a session still ends within the hour of the last word, as every team session did before.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { CloudHomeConfig } from "./cloud-home.ts";
import { isTeamRole } from "./cloud-team.ts";
import type { SessionRegistry } from "./sessions.ts";

/** On the Admin; must match openmaus-cloud's TEAM_ROSTER_MACHINE_PATH. */
export const TEAM_ROSTER_ADMIN_PATH = "/api/cloud/machines/team-member";
export const TEAM_ROSTER_EVERY_MS = 5 * 60_000;
/** Sessions ending within this long are asked about: two checks before the end, so one missed answer costs nothing. */
export const TEAM_ROSTER_SOON_MS = 20 * 60_000;
/** The Admin's own limit on one ask. */
export const TEAM_ROSTER_MAX = 50;
const FETCH_TIMEOUT_MS = 15_000, ANSWER_MAX_BYTES = 64 * 1024;

/** Must match openmaus-cloud's teamRosterSignature: a context of its own, so no other signed request reads as one. */
export function teamRosterSignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`omb-team-roster-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

const answerSchema = z.object({ members: z.record(z.string(), z.unknown()) });

interface Timer { unref?(): unknown }

export interface TeamRosterOptions {
  machineId: string;
  adminOrigin: string;
  secret: string;
  sessions: Pick<SessionRegistry, "membersToVouch" | "vouchMember" | "revokeMember">;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export interface TeamRoster {
  /** One check now; it never rejects. */
  check(): Promise<void>;
  stop(): void;
}

export function startTeamRoster(options: TeamRosterOptions): TeamRoster {
  const now = options.now ?? Date.now, log = options.log ?? (() => {}), random = options.random ?? Math.random;
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: Timer | null = null, stopped = false, running: Promise<void> | null = null;

  const ask = async (): Promise<void> => {
    const emails = options.sessions.membersToVouch(TEAM_ROSTER_SOON_MS, TEAM_ROSTER_MAX);
    if (!emails.length) return;
    const body = JSON.stringify({ v: 1, emails });
    const timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(18).toString("base64url");
    let response: Response;
    try {
      response = await fetcher(`${options.adminOrigin}${TEAM_ROSTER_ADMIN_PATH}`, { method: "POST", redirect: "error", cache: "no-store", body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: {
        accept: "application/json", "content-type": "application/json", "x-omb-cloud-machine": options.machineId, "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${teamRosterSignature(options.secret, options.machineId, timestamp, nonce, body)}`,
      } });
    } catch (error) {
      log(`team roster: the Admin can't be reached (${error instanceof Error ? error.name : "error"}); sessions end at their hour`);
      return;
    }
    const json = /^application\/json\b/i.test(response.headers.get("content-type") ?? "");
    if (response.status !== 200 || !json) {
      await response.body?.cancel().catch(() => {});
      // 404: an Admin from before the roster check. Sessions end at their hour, as they always did.
      if (response.status !== 404) log(`team roster: the Admin answered HTTP ${response.status}; sessions end at their hour`);
      return;
    }
    const text = await response.text().catch(() => "");
    let parsed: z.ZodSafeParseResult<z.infer<typeof answerSchema>>;
    try { parsed = text.length > ANSWER_MAX_BYTES ? answerSchema.safeParse(null) : answerSchema.safeParse(JSON.parse(text)); } catch { parsed = answerSchema.safeParse(null); }
    if (!parsed.success) { log("team roster: the Admin's answer can't be read"); return; }
    let left = 0;
    for (const email of emails) {
      if (!Object.hasOwn(parsed.data.members, email)) continue;
      const role = parsed.data.members[email];
      if (role === null) left += options.sessions.revokeMember(email);
      else if (isTeamRole(role)) options.sessions.vouchMember(email, role);
    }
    if (left) log(`team roster: ${left} session(s) ended for people no longer in the team`);
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => { timer = null; void check().finally(schedule); }, Math.round(TEAM_ROSTER_EVERY_MS * (1 + 0.2 * random())));
    timer.unref?.();
  };
  const check = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= ask().catch((error: unknown) => log(`team roster: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = null; });
    return running;
  };
  schedule();
  return {
    check,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

let cloudTeam: TeamRoster | null = null;

/** A Team Cloud only: a My Cloud is one person's, and its sessions are its owner's. */
export function startCloudTeamRoster(input: { cloudHome: CloudHomeConfig | null; sessions: TeamRosterOptions["sessions"] }): void {
  const { cloudHome } = input;
  if (!cloudHome?.team || cloudTeam) return;
  cloudTeam = startTeamRoster({ machineId: cloudHome.machineId, adminOrigin: cloudHome.adminOrigin, secret: cloudHome.bootstrapSecret, sessions: input.sessions,
    log: (line) => console.log(`team cloud: ${line}`) });
}

export function stopCloudTeamRoster(): void {
  cloudTeam?.stop();
  cloudTeam = null;
}
