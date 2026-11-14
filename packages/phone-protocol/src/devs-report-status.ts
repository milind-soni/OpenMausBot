// A @devs bug report's status, as the MausBot team last said it (server/host/devs-reports.ts asks about it hourly and at each
// start). The server writes it on the person's message that sent the report, and on the one line that tells them its fix
// runs here; clients say it in their own words (src/components/BugReportNote.tsx), so it follows the app's language.

export interface BugReportStatus {
  /** The MausBot team's id for the report (the "Sent to the MausBot team (report …)" line names it). */
  id: string;
  /** `received`: we have it and are looking; `fixed`: the team fixed it. */
  status: "received" | "fixed";
  /** The release the fix ships in, once the team knows it. */
  fixedIn?: string;
  /** This app runs that release (or a later one): the fix is here. */
  running?: true;
}

export interface BugReportField {
  /** On a person's message that tagged @devs: its report's status. On the one notice that tells them the fix runs here: the same, `running` set. */
  bugReport?: BugReportStatus;
}

const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether this app's version (`running`) is the release `fixedIn` or a later one. Anything that doesn't read as a version is
 * never at least it, and neither is a pre-release of that very release: the fix is said to be here only when it surely is. */
export function versionAtLeast(running: string, fixedIn: string): boolean {
  const have = VERSION.exec(running.trim()), want = VERSION.exec(fixedIn.trim());
  if (!have || !want || want[4] !== undefined) return false;
  for (const part of [1, 2, 3]) {
    const a = Number(have[part]), b = Number(want[part]);
    if (a !== b) return a > b;
  }
  return have[4] === undefined;
}
