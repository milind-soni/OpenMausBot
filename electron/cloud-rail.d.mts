/** A circle of the rail: a place the window can show, by its saved id (`local` for this computer). Names, colours and
 * states only: never an address. */
export interface RailPlace {
  id: string;
  name: string;
  color: import("./cloud-buy.mjs").CloudColor | null;
  /** This computer, a Cloud of the person's own (My Cloud included), a team's Cloud, or a server they connected by hand. */
  kind: "computer" | "cloud" | "team" | "server";
  /** False while there is nothing to open yet (a Cloud being made, with no address). */
  opens: boolean;
  active?: true;
  /** Being set up, 0 to 1 (0 while it waits for its payment). */
  progress?: number;
  /** Waiting for its payment. */
  waiting?: true;
  /** Something needs the person there (a payment problem on a Cloud they own). */
  attention?: true;
  /** A server or computer of the person's own that signed in with their account. */
  server?: true;
  /** Not heard from in the last few minutes. */
  offline?: true;
  /** When the Admin last heard from it (ms). */
  lastSeenAt?: number;
  /** Signed in, but only reachable on its own network: nothing to open from here. */
  ownNetwork?: true;
  /** Signed in and reachable, but not connected to this app yet: a click shows how to connect it. */
  pairs?: true;
  /** It runs an older release than the newest the Admin names: time to update it. */
  update?: { version: string; latest: string };
  /** Its colour is changed from the rail (a right-click on its circle): the swatch it shows, and why only its admins or a
   * sign-in may change it, if so. None for a Cloud still being made. */
  paint?: { swatch: import("./cloud-list.mjs").CloudSwatch | null; locked?: "member" | "signed-out" };
  /** A Cloud of the person's own that has ended (or stopped): it opens its own screen, never its address. */
  ended?: true;
  /** Its owner may take this Cloud off their list (it ended, or was never paid for): its menu offers Remove from list. */
  removable?: true;
  /** A server connected by hand: Remove from list forgets it on this computer (this app signs out of it there). */
  forget?: true;
  /** A server of the person's own, theirs alone by its own word, that this computer's bots may move to: its menu offers
   * Make … my home. */
  makeHome?: true;
}
/** ＋'s choices here: buying a Cloud, pasting a server's pairing link, typing its address on this computer's Settings, and
 * a new organization on the Team plan this account pays for (absent from an older app's main). */
export interface RailAddChoices { cloud: boolean; link: boolean; address: boolean; organization?: boolean }
/** `beside`: a place's page, which never reads the list, learns that the window's rail stands beside it. */
export interface RailState { places: RailPlace[]; add: RailAddChoices; beside?: true }
/** Buying another Cloud as a page sees it: what the sheet says, never the account, an address or the checkout page. */
export type AddCloudView =
  | { signedIn: false }
  | {
    signedIn: true;
    /** The person has a Cloud of their own already (else ＋ buys their first, in this computer's own sheet). */
    hasCloud: boolean;
    /** The Admin lists every Cloud of theirs (else it sells one Cloud per account). */
    supported: boolean;
    canAdd: boolean;
    blocked?: import("./cloud-account.mjs").CloudAddBlock;
    offer: import("./cloud-home.mjs").CloudOffer | null;
    /** How many Clouds of their own they have: the next one is suggested as "Cloud {count + 1}". */
    count: number;
    /** For the account a Team plan with organizations is billed to: whether a new one may be added now (else why), how many
     * it has of how many. */
    organizations?: { canAdd: boolean; blocked?: import("./cloud-list.mjs").OrganizationBlock; count: number; max: number };
    home?: { name: string; color: import("./cloud-buy.mjs").CloudColor | null };
    adding?: {
      name: string; color: import("./cloud-list.mjs").CloudSwatch | null; tier: string | null; startedAt: number;
      status: "checkout" | "setting_up" | "ready" | "problem"; progress?: number; link?: true; done?: true;
    };
  };
export declare const RAIL_MIN_PLACES: number;
/** main's own circles: each as the page sees it, plus the Cloud main acts on for it (never sent to a page). */
export declare function railPlaces(input: { saved: { environments: any[]; activeId: string }; home?: string | null; mine?: string | null; state?: unknown; offers?: (entry: any) => boolean }): Array<RailPlace & { cloudId?: string }>;
export declare function addCloudView(state: unknown, offer: import("./cloud-home.mjs").CloudOffer | null): AddCloudView;
