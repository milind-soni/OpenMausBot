// Setup mode: the coaching block a bot gets when it has not been set up yet,
// or when the user asks for it with /setup. The bot interviews the user, says
// what it intends, and then configures itself only through proposal cards
// (propose_profile, propose_routine, skill_manage, request_credential) — so
// nothing changes without the user's approval. Mirrors skill-learn.ts:
// /setup is a turn-text rewrite plus a prompt block, never a hidden mode.
//
// Setup mode is card-gated, not provenance-gated: it doesn't matter who sent
// the message that entered it — a peer message or a routine trigger that
// happens to begin with /setup enters it exactly like a message the user
// typed, and nothing about the bot actually changes until a card is
// confirmed. And like /learn, only the current turn's text is rewritten —
// the transcript keeps the raw "/setup …" user message verbatim, so replay
// and history read the same thing the user sent.

const SETUP_COMMAND = /^\/setup(?:\s+|$)([\s\S]*)$/i;

/** `/setup` at the start of a message, optionally followed by a job description. */
export function parseSetupCommand(text: string): { request: string } | null {
  const match = text.trim().match(SETUP_COMMAND);
  if (!match) return null;
  return { request: match[1]!.trim() };
}

/** What the model reads in place of a literal `/setup` message. */
export function expandSetupTurnText(userText: string): string {
  const setup = parseSetupCommand(userText);
  if (!setup) return userText;
  return setup.request
    ? `Set yourself up for this job: ${setup.request}`
    : "Set yourself up. Ask me what you need to know, then propose your configuration.";
}

/** A bot with neither standing instructions nor a description has not been
 * set up. /setup re-enters the mode for a configured bot. */
export function setupModeActive(input: { soul?: string; description?: string; text: string }): boolean {
  const blank = !(input.soul ?? "").trim() && !(input.description ?? "").trim();
  return blank || parseSetupCommand(input.text) !== null;
}

// skill_manage is only ever mounted alongside the other agent tools when
// skill authoring is turned on for this turn (OMB_SKILL_AUTHORING_ENABLED);
// the block must never name a tool the model cannot actually call.
const SKILL_MANAGE_ASIDE = "(keep SOUL.md short; put step-by-step procedure into a skill with skill_manage)";
const NO_SKILL_MANAGE_ASIDE = "(keep SOUL.md short; describe procedures plainly in your standing instructions for now)";

function folderClause(cwd: string | undefined): string {
  return cwd
    ? `which folder on this computer it should work in (today that is ${cwd}; offer to keep it)`
    : "which folder on this computer it should work in (today it has none and works in a private workspace; offer to keep that, or ask for a path)";
}

function buildSetupPrompt(profileAside: string, cwd?: string): string {
  return (
    "\n\nThis bot has not been set up yet, or the user asked you to set yourself up. Your job this conversation is to set yourself up from what the user tells you." +
    ` First ask at most four questions that change what you would build: what the job is, when it should happen (on demand, on a schedule, or when something arrives), which apps or accounts it touches, and ${folderClause(cwd)}.` +
    " Then, before any tool call, tell the user in plain language what you intend: who you will be, what you will do and when, where you will work, what you will need from them, and what you will not do. Wait for a yes." +
    " When they say yes, first send one message that lists the cards you are about to raise, then make the tool calls — the cards must appear after that message, never before it. After the tool calls add at most one short line and do not repeat the list." +
    ` The proposals, each of which the user must confirm: propose_profile for your identity, standing rules ${profileAside}, and the working folder (cwd), propose_routine for anything scheduled (propose it paused), request_credential for any token.` +
    " Never claim something is set up until its card is confirmed." +
    // Setup used to end by sending the user to a settings panel to authorize
    // apps by hand. need_tool does it here instead: the apps the job touches
    // are the ones it just asked about, so it can connect them in the same
    // conversation rather than handing over a chore.
    " Then connect what the job needs rather than sending them away for it: call need_tool once per app the job touches, naming the capability in plain words (\"calendar\", \"email\"), and OpenMausBot will show them what it can connect and run the sign-in right here." +
    " Finish by saying only what genuinely remains for them to do by hand — creating a third-party application or bot token, or enabling a routine — and never send them to a settings panel for an app connection you could have offered with need_tool."
  );
}

/** The setup block naming skill_manage, for a turn with skill authoring on. */
export const SETUP_PROMPT = buildSetupPrompt(SKILL_MANAGE_ASIDE);

export function setupSystemPrompt(active: boolean, options?: { skills?: boolean; cwd?: string }): string {
  if (!active) return "";
  return buildSetupPrompt(options?.skills ? SKILL_MANAGE_ASIDE : NO_SKILL_MANAGE_ASIDE, options?.cwd);
}
