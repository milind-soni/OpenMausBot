// /setup coaching rewrites only this turn's text and adds a prompt block; it grants no authority (the services still check the caller).

const SETUP_COMMAND = /^\/setup(?:\s+|$)([\s\S]*)$/i;

export function parseSetupCommand(text: string): { request: string } | null {
  const match = text.trim().match(SETUP_COMMAND);
  if (!match) return null;
  return { request: match[1]!.trim() };
}

export function expandSetupTurnText(userText: string): string {
  const setup = parseSetupCommand(userText);
  if (!setup) return userText;
  return setup.request
    ? `Set yourself up for this job: ${setup.request}`
    : "Set yourself up. Ask me what you need to know, then propose your configuration.";
}

export function setupModeActive(input: { soul?: string; description?: string; text: string }): boolean {
  return parseSetupCommand(input.text) !== null;
}

// skill_manage is mounted only with skill authoring on: never name a tool the model cannot call.
const SKILL_MANAGE_ASIDE = "(keep SOUL.md short; put step-by-step procedure into a skill with skill_manage)";
const NO_SKILL_MANAGE_ASIDE = "(keep SOUL.md short; describe procedures plainly in your standing instructions for now)";

function folderClause(cwd: string | undefined): string {
  return cwd
    ? `which folder on this computer it should work in (today that is ${cwd}; offer to keep it)`
    : "which folder on this computer it should work in (today it has none and works in a private workspace; offer to keep that, or ask for a path)";
}

export type SetupConnectedApps =
  | { state: "available" }
  | { state: "off"; noTools: boolean }
  | { state: "not-configured"; host: "server" | "desktop" | "cloud" }
  | { state: "unsupported" };

export function connectedAppsForSetup(input: {
  mounted: boolean;
  engine: boolean;
  configured: boolean;
  enabled: boolean;
  grants: Record<string, unknown> | undefined;
  host: "server" | "desktop" | "cloud";
}): SetupConnectedApps {
  const noTools = input.grants !== undefined && Object.keys(input.grants).length === 0;
  if (input.mounted && !noTools) return { state: "available" };
  if (!input.engine) return { state: "unsupported" };
  if (!input.configured) return { state: "not-configured", host: input.host };
  if (!input.enabled || noTools) return { state: "off", noTools };
  return { state: "not-configured", host: input.host };
}

const NO_APP = "so you cannot connect an app such as Gmail yourself. If the job needs one,";
const KEY_PLACE = "Composio project key in Settings → API keys, under Self-host connected apps";

function connectedAppsClause(apps: SetupConnectedApps): string {
  switch (apps.state) {
    case "available":
      return " Connect each app or account the job needs, such as Gmail, Slack or Notion, yourself rather than sending the user to settings: in this same turn, even with questions still open, make COMPOSIO_MANAGE_CONNECTIONS for its toolkit (for example gmail) your last tool call. The user gets a Connect card in this chat; end the turn there, and you continue automatically once it is connected.";
    case "off":
      return apps.noTools
        ? ` You have no connected-app tools, ${NO_APP} ask the user to open your settings → Access → Connected apps, turn it on, connect the app with Connect an app…, and give you its tools.`
        : ` Connected apps are switched off for you, ${NO_APP} ask the user to turn on Connected apps in your settings under Access, then tell you to go on; you can start the connection after that.`;
    case "not-configured":
      if (apps.host === "cloud") return ` Connected apps come with their MausBot Cloud plan but are not answering right now, ${NO_APP} say so in one sentence and suggest trying again in a few minutes.`;
      if (apps.host === "desktop") return ` Connected apps are not answering right now, ${NO_APP} say so in one sentence: restarting OpenMausBot usually brings them back, or they can add their own ${KEY_PLACE}.`;
      return ` Connected apps are not set up here, ${NO_APP} say so in one sentence: they are set up by adding a ${KEY_PLACE}.`;
    case "unsupported":
      return ` Your current model cannot use connected apps, ${NO_APP} say so in one sentence.`;
  }
}

// Google refuses the bot's browser at its sign-in page, so a Google account never goes through request_sign_in.
const SIGN_IN_CLAUSE =
  " For a website no connected app covers, call request_sign_in at its sign-in page so the user signs in themselves; never ask for a password or code in chat. Gmail and other Google accounts only connect through connected apps: Google blocks sign-in in your browser.";

// The Chief role is a flag propose_profile cannot touch, but a soul saying "your only job is X" would still narrow it.
const CHIEF_CLAUSE =
  " You are also the Chief of Staff, and setting yourself up does not change that: keep your Chief duties, add this job to your standing instructions instead of replacing them, and never write that this job is all you do.";

function buildSetupPrompt(profileAside: string, apps: SetupConnectedApps, cwd?: string, chief?: boolean): string {
  return (
    "\n\nThe user explicitly asked you to set yourself up. For this setup request, help configure the bot from what the user tells you." +
    (chief ? CHIEF_CLAUSE : "") +
    ` First ask at most four questions that change what you would build: what the job is, when it should happen (on demand, on a schedule, or when something arrives), which apps or accounts it touches, and ${folderClause(cwd)}.` +
    " Then, before any tool call, tell the user in plain language what you intend: who you will be, what you will do and when, where you will work, what you will need from them, and what you will not do. Ask for missing choices, not an extra yes for already-requested actions: changes to your own profile and routines apply immediately, and the person sees each with an Undo." +
    " First send one message describing the changes you are about to request, then make the tool calls. Follow each result: if applied, continue without another confirmation; if pending, end the turn and wait for its in-app decision. Do not repeat the list or claim success from the permission mode alone." +
    ` Use propose_profile for your identity, standing rules ${profileAside}, and the working folder (cwd), create_trigger for a schedule or webhook the user describes, and request_credential for any missing token.` +
    connectedAppsClause(apps) +
    SIGN_IN_CLAUSE +
    " Full Access does not supply answers, credentials, or broader permissions for another bot. A credential request still needs the user's secure entry. Report failed or cancelled changes honestly." +
    " Finish by saying exactly what remains for the user to do by hand, such as creating a third-party application or bot token, or deciding a pending review."
  );
}

export interface SetupPromptOptions {
  skills?: boolean;
  cwd?: string;
  connectedApps: SetupConnectedApps;
  /** The bot is its scope's Chief of Staff. */
  chief?: boolean;
}

export function setupSystemPrompt(active: boolean, options: SetupPromptOptions): string {
  if (!active) return "";
  return buildSetupPrompt(options.skills ? SKILL_MANAGE_ASIDE : NO_SKILL_MANAGE_ASIDE, options.connectedApps, options.cwd, options.chief);
}
