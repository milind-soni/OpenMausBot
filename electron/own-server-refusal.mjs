// Why a server this desktop is signed in to is not one of the person's own (computer-sharing.mjs ownServerSession), so
// lending this computer to it is not offered: one word, which the app turns into one line for the person.

/** "team": a team's server; "cloud": a Cloud or hosted workspace, lent by its own rules; "not-owner": this app is not
 * signed in there as its owner (admin); "shared": other people sign in there too. Null when it is their own. */
export function ownServerRefusal(auth) {
  if (auth?.team) return "team";
  if (auth?.cloudHome === true || auth?.hosted === true) return "cloud";
  if (auth?.kind !== "session" || !Array.isArray(auth.scopes) || !auth.scopes.includes("admin")) return "not-owner";
  if (auth.own !== true) return "shared";
  return null;
}
