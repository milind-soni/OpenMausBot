// A customer-run server's licence, from MausBot's signed config to license.key in the server's data folder. What may be
// written, and how, is customer-run.ts section 5; this is only when. The licence the config carries is offered here
// (each config the connector accepts, and the kept one at start); it is written once the home runs, checked again every
// hour (a restore or a rollback can put an older file back), and never removed.
import type { AuditEvent } from "./audit.ts";
import { checkLicence, licenceFingerprint, licenceProof } from "./customer-run.ts";
import { errorText, type Log } from "./log.ts";

/** How often the licence on the server is compared with the one MausBot sent last, to put it back if it was replaced. */
export const LICENCE_RECHECK_MS = 60 * 60_000;

export interface LicenceHome {
  writeLicence(licence: string): Promise<"written" | "same" | "no_home">;
  licenceProof: string | null;
}

export interface LicenceDeliveryOptions {
  home: LicenceHome;
  log: Log;
  /** One audit line; it may throw when the log cannot be written. */
  record: (event: Extract<AuditEvent, { event: "licence" }>) => void;
  now?: () => number;
  recheckMs?: number;
}

export class LicenceDelivery {
  private readonly options: LicenceDeliveryOptions;
  private readonly now: () => number;
  /** The newest well-formed licence MausBot sent. */
  private wanted: string | null = null;
  /** The licence the server's folder is known to hold, and when that was last checked. */
  private settled: { licence: string; at: number } | null = null;
  private refused: string | null = null;
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
      this.options.home.licenceProof = licenceProof(licence);
    }
    return this.tick();
  }

  /** Writes the licence when it is not known to be on the server, or is due its hourly check. One write at a time. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const licence = this.wanted;
    if (!licence) return Promise.resolve();
    const due = !this.settled || this.settled.licence !== licence || this.now() - this.settled.at >= (this.options.recheckMs ?? LICENCE_RECHECK_MS);
    if (!due) return Promise.resolve();
    this.running = this.write(licence).finally(() => { this.running = null; });
    return this.running;
  }

  private async write(licence: string): Promise<void> {
    let outcome: Awaited<ReturnType<LicenceHome["writeLicence"]>>;
    try {
      outcome = await this.options.home.writeLicence(licence);
    } catch (error) {
      this.options.log(`could not save the licence MausBot sent: ${errorText(error)}; trying again`);
      return;
    }
    if (outcome === "no_home") return;
    this.settled = { licence, at: this.now() };
    if (outcome === "same") return;
    const fingerprint = licenceFingerprint(licence);
    this.options.log(`saved the licence MausBot sent (${fingerprint}) to the server's data folder`);
    try {
      this.options.record({ event: "licence", what: "saved", by: "admin", fingerprint });
    } catch (error) {
      this.options.log(`could not write the audit log: ${errorText(error)}`);
    }
  }
}
