// The lease that lets one computer at a time run the heavy part of its move into a Cloud (server/cloud-send-lease.ts):
// asked for before a pass that copies and before the freeze, held through the switch, asked again every few minutes while
// held, and let go of at the end. A Cloud too old to keep one (404) lets every computer go on, as before.

/** How often a held lease is asked for again: well inside the Cloud's 10 minutes. */
export const LEASE_RENEW_MS = 3 * 60_000;

const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : "");

/**
 * @param {{
 *   session(): Promise<{ call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }> }>,
 *   holder(): Promise<string | null>,
 *   label(): Promise<string>,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void },
 *   log?(line: string): void,
 * }} deps `holder`: this computer, as the Cloud tells computers apart (one-home-main.mjs `installationOf`); null until it is
 * known, and then nothing waits. `label`: its name, which the other computer's line says while it waits.
 */
export function createMoveLease({ session, holder, label, timers = { set: (work, ms) => { const timer = setInterval(work, ms); timer.unref?.(); return timer; }, clear: (timer) => clearInterval(timer) }, log = () => {} }) {
  let held = null, name = "", timer = null;
  const ask = async (body) => (await session()).call("POST", "/api/cloud-send/lease", { v: 1, ...body });
  const stop = () => { if (timer) timers.clear(timer); timer = null; };

  return {
    /** Null once this computer holds the lease, or when the Cloud keeps none; otherwise the other computer, by its name. */
    async take() {
      const id = await holder();
      if (!id) return null;
      name = sentence(await label().catch(() => "")) || name;
      const answer = await ask({ holder: id, label: name });
      if (answer.status === 409) { stop(); held = null; return { name: sentence(answer.body?.label) }; }
      // An older Cloud keeps no lease, and one that fails to answer fails the request the move makes next anyway.
      if (!answer.ok) return null;
      held = id;
      if (!timer) {
        timer = timers.set(() => {
          if (!held) return;
          ask({ holder: held, label: name }).then((again) => { if (again.status === 409) log("one home: another computer took My Cloud's move lease"); }, () => {});
        }, LEASE_RENEW_MS);
      }
      return null;
    },
    /** Lets go of a held lease, so another computer's move goes on at once. */
    async release() {
      stop();
      const id = held;
      held = null;
      if (id) await ask({ holder: id, release: true }).catch(() => {});
    },
    held: () => held !== null,
  };
}
