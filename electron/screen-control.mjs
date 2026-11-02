// Computer control as lending sees it: its state for the icon's menu and for the person's own Clouds, a start of it
// again (from the icon's menu, or Turn on on a Cloud's card), and each change kept in the app's log.
import { screenStatus } from "./screen-status.mjs";

/** `connection()`: computer control's state as cua.mjs last published it (a promise). `request()`: start it again, which
 * on a Mac asks macOS for what it never asked, and on Linux turns local control on. */
export function createScreenControl({ connection, remote = () => false, request, log = () => {}, platform = process.platform }) {
  const now = async () => screenStatus({ platform, connection: await Promise.resolve().then(connection).catch(() => null), remote: remote() });
  return {
    now,
    /** Its state once it started again. */
    async start() {
      try { await request(); } catch (error) { log(`computer control: ${error?.message ?? error}`); }
      return now();
    },
    /** Packaged on Windows nothing reads the console, so why computer control stopped is kept in the app's log. */
    changed(next) {
      const why = next?.reason ?? next?.message;
      log(`computer control: ${next?.mode ?? next?.status ?? "unknown"}${why ? `: ${why}` : ""}`);
    },
  };
}
