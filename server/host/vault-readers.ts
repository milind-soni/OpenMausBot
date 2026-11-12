// Whose saved secrets a turn and a Settings session reach. On a Team Cloud a secret a member typed into a card in their
// own private chat is theirs alone: no other member's chat, shared chat, group chat or routine reaches it, and no admin
// sees it. Off a Team Cloud every secret is the install's, as it always was.
import { audienceMember, type Audience } from "../audience.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TEAM_READER, type VaultReader } from "../vault-store.ts";

export interface VaultReadersDeps {
  team: boolean;
  audienceOf(threadId: string): Audience;
  personOf(auth: Extract<RequestAuth, { kind: "session" }>): string;
}

export function createVaultReaders(deps: VaultReadersDeps) {
  return {
    /** A turn in this conversation: the team's secrets, and the person's own whose private chat it is. */
    turn(threadId: string): VaultReader {
      return deps.team ? { person: audienceMember(deps.audienceOf(threadId)), team: true } : TEAM_READER;
    },
    /** Settings → Vault: an admin sees the team's (and on a team their own), anyone else only their own. */
    viewer(auth: RequestAuth): VaultReader {
      return { person: deps.team && auth.kind === "session" ? deps.personOf(auth) : null, team: auth.scopes.includes("admin") };
    },
  };
}

export type VaultReaders = ReturnType<typeof createVaultReaders>;
