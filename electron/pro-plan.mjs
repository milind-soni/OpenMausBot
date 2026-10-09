// Who may start a Live call, in one place: an active OMB Cloud plan of any
// tier (Personal, Pro or Max), the owner's rule. Pure and dependency-free, so
// Electron main, the server and the renderer can all import it.
//
// Electron's Cloud sign-in (cloud-account.mjs) is the only part of the app
// that knows the plan. Main applies the rule to it and hands its server the
// answer alone, never the account: OMB_PRO_PLAN when it starts the server,
// then each change over the utility process's private port (server/pro-plan.ts).
// A server the desktop app did not start (dev, tests, headless or Docker)
// says Pro with OMB_PRO_PLAN=1. The server asks only when a call starts: a
// call already running is never cut off by a plan change.

export const PRO_PLAN_ENV = "OMB_PRO_PLAN";
export const PRO_PLAN_MESSAGE = "openmausbot:pro-plan";

/**
 * Whether a Live call may start, from what this side knows of the plan.
 *
 * Verified by OMB Cloud, the plan answers: an active paid plan (also while a
 * failed re-check keeps the last verified one, `checking`) or a payment
 * received and still being linked is yes; signed out, free, or a plan that is
 * not active is no. While the plan cannot be checked right now (not read yet,
 * signing in, OMB Cloud unreachable, or this computer's sign-in ended), the
 * plan last verified decides: the account's own `lastPlan` where it carries
 * one, otherwise `lastKnown`, the answer this side last had. A Cloud home is
 * the plan's own machine and always may.
 *
 * `account`: the Cloud sign-in's state; omitted where it is never seen (the
 * server, which holds the answer Electron gave it as `lastKnown`).
 */
export function liveCallsAllowed({ account, lastKnown = false, cloudHome = false } = {}) {
  if (cloudHome) return true;
  const last = lastKnown === true;
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return last;
  switch (account.status) {
    case "signed-out": return false;
    case "connecting": return last;
    case "connected": {
      const entitlement = account.entitlement;
      if (entitlement?.plan === "pro" && entitlement.status === "active") return true;
      // A payment being linked; otherwise free, or a plan that is not active.
      return Boolean(account.purchase);
    }
    case "unavailable":
    case "reauth-required":
      return account.lastPlan ? account.lastPlan.active === true : last;
    default: return false;
  }
}

/** The spawn environment's entry: a server starts with this answer. */
export function proPlanEnvironment(pro) {
  return { [PRO_PLAN_ENV]: pro === true ? "1" : "0" };
}

/** A server's answer at startup: "1" is Pro, anything else is not. */
export function proPlanFromEnvironment(env) {
  return env?.[PRO_PLAN_ENV]?.trim() === "1";
}

/** Electron's private message that hands a running server a new answer. */
export function proPlanMessage(pro) {
  return { type: PRO_PLAN_MESSAGE, pro: pro === true };
}

/** The answer in Electron's message; null for any other message. A
 * malformed one throws: it is refused, never read as an answer. */
export function proPlanFromMessage(message) {
  if (!message || typeof message !== "object" || message.type !== PRO_PLAN_MESSAGE) return null;
  if (typeof message.pro !== "boolean") throw new Error("invalid Pro plan message");
  return message.pro;
}

/** Main's side: the answer kept where the Cloud sign-in lives, so a server
 * started (or restarted) later begins with it. Each state of the sign-in
 * updates it; a state that cannot say keeps the last answer. */
export function createProPlanRelay() {
  let pro = false;
  return {
    update(account) {
      pro = liveCallsAllowed({ account, lastKnown: pro });
      return pro;
    },
    environment: () => proPlanEnvironment(pro),
    message: () => proPlanMessage(pro),
  };
}
