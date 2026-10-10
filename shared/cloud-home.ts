// The places an OMB Cloud home offers, shared by the server (what a bot is
// shown and may use, server/cloud-home.ts) and the app (what the Computer
// panel and the place chip list), so the two cannot disagree.
//
// A Cloud home is a headless Linux server in the cloud. "This computer" there
// would be the server itself, not the person's own Mac or PC (which it cannot
// reach yet), and a Local VM needs a container runtime a Fly machine cannot
// run. So neither is ever offered: not in the place list, the Computer panel,
// the tools a bot sees, Auto routing, or what a bot is told. Bots there work
// in the built-in browser and on cloud computers.
import type { Surface } from "./wire.ts";

/** Whether a Cloud home offers this place at all. */
export function cloudHomeOffersPlace(place: Surface): boolean {
  return place !== "local" && place !== "vm";
}
