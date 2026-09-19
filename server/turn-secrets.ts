// The phone-secret submission registry and its guards — extracted verbatim
// from index.ts: the registry with its bot-deletion mutation claim and the
// desktop handoff prompt. index.ts wires createTurnSecrets at the helpers'
// original site; every caller is an HTTP route evaluated long after that
// wiring.
import { PhoneSecretSubmissionRegistry } from "./phone-secret.ts";
import type { Store } from "./store.ts";

/** Everything the registry guards read from their host. store is the
 * index.ts const, bound before the wiring site. */
export interface TurnSecretsDeps {
  store: Store;
}

export function createTurnSecrets(deps: TurnSecretsDeps) {
  const { store } = deps;
  const phoneSecretSubmissions = new PhoneSecretSubmissionRegistry();

  function claimPhoneSecretBotDeletion(botId: string): (() => void) | null {
    const scopes = [
      { botId },
      ...store.groups
        .filter((group) => group.memberIds.includes(botId))
        .map((group) => ({ groupId: group.id })),
    ];
    const releases: Array<() => void> = [];
    for (const scope of scopes) {
      const release = phoneSecretSubmissions.claimMutation(scope);
      if (!release) {
        for (const undo of releases.reverse()) undo();
        return null;
      }
      releases.push(release);
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  function credentialDesktopHandoff(label: string): string {
    return `Securely provide the ${label} from OpenMausBot on your phone or computer. It is never added to chat.`;
  }

  return {
    phoneSecretSubmissions, claimPhoneSecretBotDeletion, credentialDesktopHandoff,
  };
}
