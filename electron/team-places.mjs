// The person's teams, as places their own places may name. A team's Cloud is read over this window's own sign-in there,
// which exists once they have opened it, and what it had is remembered, so a team not open now still says which bots it
// has. Only the teams the verified session lists are named, so a team they left is not. Security: a team is never told
// anything and is never a home: nothing about the person's other places reaches it.
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_TEAMS = 20, MAX_BOTS = 500;
const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Read like a place's move summary, which is how bots are counted. */
const summary = (bots) => ({ v: 1, items: bots.map((name, at) => ({ key: `bot:${at}`, kind: "bot", label: name, parts: {} })) });

/** What each team had when last read, read back: `{ [teamId]: { name, bots } }`. */
export function parseRemembered(value) {
  const teams = {};
  if (!record(value) || value.v !== 1 || !record(value.teams)) return teams;
  for (const [id, team] of Object.entries(value.teams).slice(0, MAX_TEAMS)) {
    if (!TEAM_ID.test(id) || !record(team) || typeof team.name !== "string" || !Array.isArray(team.bots)) continue;
    teams[id] = { name: team.name, bots: team.bots.filter((name) => typeof name === "string" && name.trim()).slice(0, MAX_BOTS) };
  }
  return teams;
}

/** The names in a Team Cloud's /api/bots answer: the bots this person sees there. */
export function botNames(body) {
  const bots = record(body) && Array.isArray(body.bots) ? body.bots : [];
  return [...new Set(bots.filter((bot) => record(bot) && !bot.hidden && typeof bot.name === "string" && bot.name.trim()).map((bot) => bot.name.trim()))].slice(0, MAX_BOTS);
}

/**
 * @param {{
 *   account(): { state(): any } | null,
 *   fetch: typeof fetch,
 *   remembered: { read(): unknown, write(value: unknown): void },
 * }} deps `account()`: the verified account, whose state lists the teams the person is in. `remembered`: what each
 * team had when last read.
 * @returns {() => Array<{ key: string, name: string, kind: "team", read(): Promise<unknown> }>}
 */
export function teamPlaces({ account, fetch: fetchImpl, remembered }) {
  const kept = () => { try { return parseRemembered(remembered.read()); } catch { return {}; } };
  return () => {
    let state = null;
    try { state = account()?.state?.() ?? null; } catch { state = null; }
    const teams = record(state) && Array.isArray(state.teams) ? state.teams : [];
    return teams.filter((team) => record(team) && typeof team.id === "string" && TEAM_ID.test(team.id) && typeof team.name === "string" && team.name.trim()).slice(0, MAX_TEAMS)
      .map((team) => ({
        key: `team:${team.id}`, name: team.name.trim(), kind: "team",
        read: async () => {
          const origin = record(team.machine) && typeof team.machine.origin === "string" ? team.machine.origin : null;
          if (origin) {
            const response = await fetchImpl(`${origin}/api/bots?messages=0`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
              headers: { accept: "application/json", origin, ...BACKGROUND_HEADERS } }).catch(() => null);
            if (response?.ok) {
              const bots = botNames(await response.json().catch(() => null));
              const all = kept();
              all[team.id] = { name: team.name.trim(), bots };
              try { remembered.write({ v: 1, teams: all }); } catch {}
              return summary(bots);
            }
            await response?.body?.cancel();
          }
          const seen = kept()[team.id];
          return seen ? summary(seen.bots) : null;
        },
      }));
  };
}
