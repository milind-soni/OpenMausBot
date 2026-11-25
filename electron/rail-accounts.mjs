// The rail with several accounts signed in on this device: it lists places, each place knows its account, and a click on a
// place of another account switches first (cloud-rail.mjs `workspaces:open`). An account that waits makes no request and has no
// timer, so its places show as they looked when it was last the one in use, with no counts or live state.
//
// Security: these rows go only to the rail's own page (cloud-rail.mjs), the one page allowed to know other accounts' addresses.
// With one account nothing here changes the rail at all.

/** A place of no Cloud: an account with nothing on the rail still has one way to reach it. */
export const ACCOUNT_PLACE = "account:";
const ACTIVE = "active", HAND = "hand";

/** The account's places as the rail shows them now, to keep while it waits: what they are and how they look, nothing that would
 * need asking again and nothing to act on but opening. This computer and a server saved by hand aren't any account's. */
export function accountRows(rows) {
  return rows.filter((row) => row.opens && row.kind !== "computer" && !row.forget && !row.account)
    .map(({ id, name, color, kind, ended }) => ({ id, name, color, kind, opens: true, ...(ended ? { ended: true } : {}) }));
}

/**
 * The rail's rows, grouped: This computer, each account by its address, then servers saved by hand. A Cloud two accounts can reach
 * (a team's) is one row: the account in use's when it can, else the first that waits. An account that waits, left with no row, gets
 * one of its own.
 * @param {any[]} all the account in use's rows, from railPlaces.
 * @param {{ saved: { environments: any[] }, email?: string | null, accounts?: Array<{ id: string, email: string, signIn?: true, places: any[], rows: any[] }> }} input
 */
export function withAccounts(all, { saved, email = null, accounts = [] }) {
  if (!accounts.length) return all;
  const taken = new Set(saved.environments.map((entry) => entry.origin).filter(Boolean));
  const first = (account, row) => {
    const origin = account.places.find((entry) => entry.id === row.id)?.origin;
    if (!origin) return true;
    if (taken.has(origin)) return false;
    taken.add(origin);
    return true;
  };
  const rowsOf = (account) => {
    const mark = { account: account.id, group: account.id, email: account.email, ...(account.signIn ? { signIn: true } : {}) };
    const rows = account.rows.filter((row) => first(account, row)).map((row) => ({ ...row, ...mark }));
    return rows.length ? rows : [{ id: `${ACCOUNT_PLACE}${account.id}`, name: account.email, color: null, kind: "account", opens: true, ...mark }];
  };
  const isComputer = (row) => row.kind === "computer";
  // The first claim to a Cloud two accounts share is the account in use's, whatever the order they show in.
  const waited = accounts.map((account) => ({ email: account.email, rows: rowsOf(account) }));
  const own = all.filter((row) => !isComputer(row) && !row.forget).map((row) => ({ ...row, group: ACTIVE, ...(email ? { email } : {}) }));
  // In a fixed order, so a click that makes another account the one in use doesn't move the row under the pointer.
  const groups = [...(own.length ? [{ email: email ?? "", rows: own }] : []), ...waited].sort((a, b) => a.email.localeCompare(b.email));
  return [...all.filter(isComputer), ...groups.flatMap((group) => group.rows), ...all.filter((row) => row.forget).map((row) => ({ ...row, group: HAND }))];
}
