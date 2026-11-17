/** Node's `process.platform` values: the server's operating system. */
export type ServerPlatform = "aix" | "android" | "cygwin" | "darwin" | "freebsd" | "haiku" | "linux" | "netbsd" | "openbsd" | "sunos" | "win32";

/** How an operator's server was installed. */
export type ServerInstall = "npx" | "global" | "docker" | "source";

/** GET /.well-known/openmausbot/environment, served without auth, and the `environment` of a POST /api/auth/pair answer:
 * a saved connection checks it still reaches the same server. */
export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: ServerPlatform;
  version: string;
  capabilities: {
    /** Pairing and sessions are available (this build). */
    remoteSessions: true;
    /** Only while the maintainer flag `features.sharedComputers` is on; otherwise absent, like a build without the feature. */
    sharedComputers?: true;
    lendingDetails?: true;
    /** A Cloud home with lending on: a lent computer may open the device link and lend its internet connection. */
    deviceLink?: true;
    /** A personal Cloud home with lending on: a lent computer may lend its Chrome to the bots here. Never a team Cloud. */
    myChromeLink?: true;
    /** The same: the app on the person's computer says how it is and hears what the bots here ask of it
     * (POST /api/shared-computers/asks). */
    computerAsks?: true;
    /** A lent computer may say it takes run_command's timeout_seconds; only then does this server send it. */
    commandTimeouts?: true;
    /** A lent computer may say it runs a command for up to 900 seconds; only then does this server ask it for more than 240. */
    longCommands?: true;
    /** A lent computer may say it takes edit_file, append_file and delete_file; only then does this server send them. */
    fileEdits?: true;
    /** A lent computer may say it runs the MCP servers saved here that run on it (mcp_tools, mcp_call). Never a team Cloud. */
    lentMcp?: true;
    /** A person's own OMB Cloud home. */
    cloudHome?: true;
    /** A team's Cloud home: `label` is the team's name. */
    cloudTeam?: true;
    /** A Cloud home, or a server one person owns, that takes the one-time move from that person's computer: by-row chats,
     * the manifest, the chats and credentials checks, and lines its owner wrote there stamped as the owner's. Whether a
     * session is that person, /api/auth/session says (`own`). */
    move?: 1;
    /** Who can update the server: the desktop app that runs it, or the operator. */
    selfUpdate: "desktop-managed" | "operator";
    /** For an operator's server: how it was installed, so a client offers the update command that fits it. */
    install?: ServerInstall;
    /** Whether /pair offers "sign in with your email" (an allow-list is set). */
    emailSignIn?: boolean;
    /** GET /api/threads/:id/job answers, long-polled (the headless CLI needs it). */
    jobs: true;
  };
}
