// What this server knows of its person's OMB Cloud plan, for what Pro
// unlocks: starting a Live call (server/live-call-controller.ts).
//
// Only the desktop app's Cloud sign-in knows the plan. It applies the rule
// (electron/pro-plan.mjs) and hands this server the answer alone, never the
// account: OMB_PRO_PLAN when it starts the server, then each change over the
// utility process's private parent port. The server holds that answer as the
// last known one. A server the desktop app did not start (dev, tests,
// headless or Docker) says Pro with OMB_PRO_PLAN=1; a Cloud home is the
// plan's own machine and always counts.
import { liveCallsAllowed, proPlanFromEnvironment, proPlanFromMessage } from "../electron/pro-plan.mjs";

export class ProPlan {
  private known: boolean;
  private readonly cloudHome: boolean;
  private readonly log: (line: string) => void;

  constructor({ cloudHome, env = process.env, log = (line) => console.log(line) }: {
    cloudHome: boolean;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
  }) {
    this.cloudHome = cloudHome;
    this.known = proPlanFromEnvironment(env);
    this.log = log;
  }

  /** The desktop app's private message with a new answer: true when it was
   * one. A malformed one throws and changes nothing. */
  receive(message: unknown): boolean {
    const pro = proPlanFromMessage(message);
    if (pro === null) return false;
    if (pro !== this.known) this.log(`[pro-plan] the desktop app says ${pro ? "Pro" : "not Pro"}`);
    this.known = pro;
    return true;
  }

  /** Whether a Live call may start now. Asked when a call starts, never
   * during one: a plan change never cuts off a running call. */
  liveCallsAllowed(): boolean {
    return liveCallsAllowed({ cloudHome: this.cloudHome, lastKnown: this.known });
  }
}
