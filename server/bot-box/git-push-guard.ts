// The push guard of the broker's github grant (broker-github.ts): reads the command list at the head of a smart-HTTP
// receive-pack request (git's pkt-lines, before the pack) and decides before any byte reaches GitHub. A bot may create
// and update its own branches; it may not delete a ref or update the repository's default branch. It is a boundary
// against the bot, not only against git, so anything it cannot read (a signed push, an unknown line, a list too long)
// is refused. Force pushes to other branches are not looked at here.

/** A command list longer than this is refused rather than buffered. */
export const MAX_COMMAND_BYTES = 1024 * 1024;
const ZERO = /^0+$/;
const COMMAND = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^\0\s]+)$/;
const SHALLOW = /^shallow [0-9a-f]{40,64}$/;

export interface PushCommand { old: string; new: string; ref: string }

export type CommandList =
  | { state: "more" }
  | { state: "done"; commands: PushCommand[]; capabilities: string[] }
  | { state: "bad"; reason: string };

/** The commands at the head of `head` (the bytes received so far; `ended`: the body has no more). */
export function readCommandList(head: Buffer, ended: boolean): CommandList {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let at = 0;
  for (;;) {
    if (head.length - at < 4) break;
    const size = head.subarray(at, at + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/.test(size)) return { state: "bad", reason: "the push is not in git's format" };
    const length = parseInt(size, 16);
    if (length === 0) return { state: "done", commands, capabilities };
    if (length < 5) return { state: "bad", reason: "the push is not in git's format" };
    if (head.length - at < length) break;
    let line = head.subarray(at + 4, at + length).toString("utf8");
    at += length;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (commands.length) return { state: "bad", reason: "the push is not in git's format" };
      capabilities = line.slice(nul + 1).split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    if (line === "push-cert") return { state: "bad", reason: "signed pushes are not taken here" };
    if (SHALLOW.test(line) && !commands.length) continue;
    const match = COMMAND.exec(line);
    if (!match) return { state: "bad", reason: "the push is not in git's format" };
    commands.push({ old: match[1]!, new: match[2]!, ref: match[3]! });
  }
  if (head.length > MAX_COMMAND_BYTES) return { state: "bad", reason: "the push updates too many refs at once" };
  return ended ? { state: "bad", reason: "the push ended early" } : { state: "more" };
}

/** The ref names a push may not update: the default branch, or main and master when it is unknown. */
export function protectedRefs(defaultBranch: string | null): string[] {
  return defaultBranch ? [defaultBranch] : ["refs/heads/main", "refs/heads/master"];
}

/** Empty when the push may go; else every command with why, since a push with one refused update goes nowhere. */
export function refusedCommands(commands: readonly PushCommand[], defaultBranch: string | null): Array<{ ref: string; reason: string }> {
  const kept = new Set(protectedRefs(defaultBranch));
  const why = (command: PushCommand) => ZERO.test(command.new) ? "deleting a ref is not allowed here; push to a new branch"
    : kept.has(command.ref) ? "the default branch is protected here; push to a new branch" : null;
  if (!commands.some((command) => why(command) !== null)) return [];
  return commands.map((command) => ({ ref: command.ref, reason: why(command) ?? "not applied: another update in this push was refused" }));
}

/** The default branch from an upload-pack v0 ref advertisement (`symref=HEAD:refs/heads/x` on its first ref line):
 * "more" until that line has arrived, null when it has none. */
export function advertisedDefaultBranch(body: Buffer): string | null | "more" {
  let at = 0;
  for (;;) {
    if (body.length - at < 4) return "more";
    const size = body.subarray(at, at + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/.test(size)) return null;
    const length = parseInt(size, 16);
    if (length === 0) { at += 4; continue; }
    if (length < 5) return null;
    if (body.length - at < length) return "more";
    const line = body.subarray(at + 4, at + length).toString("utf8");
    at += length;
    if (line.startsWith("# service=")) continue;
    const symref = /(?:^|[\0 ])symref=HEAD:(refs\/heads\/[^\s\0]+)/.exec(line);
    return symref ? symref[1]! : null;
  }
}

const pkt = (payload: Buffer | string) => {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0"), "latin1"), bytes]);
};
const FLUSH = Buffer.from("0000", "latin1");

/** What a refused push is answered with, as receive-pack would: its report-status (each ref `ng` with why, so git prints
 * "! [remote rejected] <ref> (<why>)"), and `message` on side band 2 when the client asked for side bands, which git
 * prints as "remote: ...". With no refs to name, the report says the unpack failed, with `message` as the reason. */
export function refusalBody(input: { capabilities: readonly string[]; refused: ReadonlyArray<{ ref: string; reason: string }>; message: string }): Buffer {
  const oneLine = (text: string) => text.replace(/[\r\n\0]+/g, " ").slice(0, 900);
  const report = input.refused.length
    ? Buffer.concat([pkt("unpack ok\n"), ...input.refused.map((item) => pkt(`ng ${item.ref} ${oneLine(item.reason)}\n`)), FLUSH])
    : Buffer.concat([pkt(`unpack ${oneLine(input.message)}\n`), FLUSH]);
  const reports = input.capabilities.includes("report-status") || input.capabilities.includes("report-status-v2") || !input.refused.length;
  const sideband = input.capabilities.includes("side-band-64k") || input.capabilities.includes("side-band");
  if (!sideband) return reports ? report : FLUSH;
  const parts: Buffer[] = [pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${oneLine(input.message)}\n`, "utf8")]))];
  if (reports) parts.push(pkt(Buffer.concat([Buffer.from([1]), report])));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The message a bot reads on a refused push. */
export function refusalMessage(refused: ReadonlyArray<{ ref: string; reason: string }>, defaultBranch: string | null): string {
  const branch = defaultBranch ? defaultBranch.replace(/^refs\/heads\//, "") : "main or master";
  if (!refused.length) return "This push was refused: push your work to a new branch, for example git push origin HEAD:refs/heads/<new-branch-name>.";
  return `This push was refused: bots may not push to the default branch (${branch}) or delete a branch or tag here. Push your work to a new branch instead, for example git push origin HEAD:refs/heads/<new-branch-name>, and nothing in this push was applied.`;
}
