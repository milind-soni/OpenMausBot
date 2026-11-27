// A customer-run server's licence, from MausBot's signed config to license.key in the server's data folder. What may be
// written, and how, is customer-run.ts section 5; this is only when. The licence the config carries is offered here
// (each config the connector accepts, and the kept one at start); it is written once the home runs, checked again every
// hour (a restore or a rollback can put an older file back), and never removed.
import type { LicenceFileState } from "./adopted-home.ts";
import type { AuditEvent } from "./audit.ts";
import { checkLicence, licenceFingerprint, licenceProof } from "./customer-run.ts";
import { errorText, type Log } from "./log.ts";

/** How often the licence on the server is compared with the one MausBot sent last, to put it back if it was replaced. */
export const LICENCE_RECHECK_MS = 60 * 60_000;
/** After a write that failed, or an audit log that could not be written, the next try waits this long. */
export const LICENCE_RETRY_MS = 5 * 60_000;

export interface LicenceHome {
  licenceFile(mode: "check" | "write", licence: string): Promise<LicenceFileState>;
  licenceProof: string | null;
}

export interface LicenceDeliveryOptions {
  home: LicenceHome;
  log: Log;
  /** One audit line; it throws when the log cannot be written, and then the licence is not written either. */
  record: (event: Extract<AuditEvent, { event: "licence" }>) => void;
  now?: () => number;
  recheckMs?: number;
  retryMs?: number;
}

export class LicenceDelivery {
  private readonly options: LicenceDeliveryOptions;
  private readonly now: () => number;
  /** The newest well-formed licence MausBot sent. */
  private wanted: string | null = null;
  /** The licence the server's folder is known to hold, and when that was last checked. */
  private settled: { licence: string; at: number } | null = null;
  /** No try before this, after one that failed. */
  private retryAt = 0;
  private refused: string | null = null;
  private waitingSaid: string | null = null;
  private running: Promise<void> | null = null;

  constructor(options: LicenceDeliveryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The licence a config carries. Absent leaves everything as it is; one of the wrong shape is logged and never written. */
  offer(value: unknown): Promise<void> {
    if (value === undefined || value === null) return this.tick();
    const licence = checkLicence(value);
    if (!licence) {
      const why = typeof value === "string" ? `it is not a licence (${value.length} characters)` : "it is not text";
      if (this.refused !== why) {
        this.refused = why;
        this.options.log(`ignored the licence in MausBot's config: ${why}`);
        try { this.options.record({ event: "licence", what: "refused", by: "admin", why }); } catch { /* logged above */ }
      }
      return this.tick();
    }
    this.refused = null;
    if (licence !== this.wanted) {
      this.wanted = licence;
      this.retryAt = 0;
      this.options.home.licenceProof = licenceProof(licence);
    }
    return this.tick();
  }

  /** Writes the licence when it is not known to be on the server, or is due its hourly check. One try at a time. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const licence = this.wanted;
    if (!licence || this.now() < this.retryAt) return Promise.resolve();
    const due = !this.settled || this.settled.licence !== licence || this.now() - this.settled.at >= (this.options.recheckMs ?? LICENCE_RECHECK_MS);
    if (!due) return Promise.resolve();
    this.running = this.deliver(licence).finally(() => { this.running = null; });
    return this.running;
  }

  private failed(why: string): void {
    this.retryAt = this.now() + (this.options.retryMs ?? LICENCE_RETRY_MS);
    this.options.log(`could not save the licence MausBot sent: ${why}; trying again in ${Math.round((this.options.retryMs ?? LICENCE_RETRY_MS) / 60_000)} minutes`);
  }

  private settle(licence: string, state: LicenceFileState): boolean {
    if (state === "same" || state === "written") {
      this.settled = { licence, at: this.now() };
      this.waitingSaid = null;
      return true;
    }
    if (state === "recent" && this.waitingSaid !== licence) {
      this.waitingSaid = licence;
      this.options.log("license.key on the server was changed in the last few minutes, by hand or by the server's owner; the licence MausBot sent waits until the server has read it");
    }
    return state !== "differs";
  }

  private async deliver(licence: string): Promise<void> {
    const fingerprint = licenceFingerprint(licence);
    try {
      if (this.settle(licence, await this.options.home.licenceFile("check", licence))) return;
    } catch (error) {
      return this.failed(errorText(error));
    }
    // The audit line comes first: a licence the log could not record is not written.
    try {
      this.options.record({ event: "licence", what: "writing", by: "admin", fingerprint });
    } catch (error) {
      return this.failed(`the audit log cannot be written (${errorText(error)})`);
    }
    let state: LicenceFileState;
    try {
      state = await this.options.home.licenceFile("write", licence);
    } catch (error) {
      try { this.options.record({ event: "licence", what: "failed", by: "admin", fingerprint }); } catch { /* the log said why already */ }
      return this.failed(errorText(error));
    }
    if (this.settle(licence, state) && state === "written") this.options.log(`saved the licence MausBot sent (${fingerprint}) to the server's data folder`);
  }
}
