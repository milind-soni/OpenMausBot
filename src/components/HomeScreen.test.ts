import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { CloudSetupSteps } from "./CloudSetupSteps";
import { homeDay, homeScreenText } from "./HomeScreen";

beforeEach(() => setLocale("en"));

it("names a team's Cloud on every screen that waits on it, and keeps My Cloud's own words otherwise", () => {
  expect(homeScreenText({ screen: "offline", name: "Acme" }).title).toBe("Can't reach Acme right now.");
  expect(homeScreenText({ screen: "offline" }).title).toBe("Can't reach My Cloud right now.");
  expect(homeScreenText({ screen: "opening", name: "Acme" }).title).toBe("Opening Acme…");
  expect(homeScreenText({ screen: "opening" }).title).toBe("Opening My Cloud…");
  expect(homeScreenText({ screen: "signin", name: "Acme" })).toMatchObject({ title: "Sign in to open Acme", action: "sign-in" });
  expect(homeScreenText({ screen: "plan", machine: "stopped", name: "Acme" })).toMatchObject({ title: "Acme isn't running", action: "manage" });
  expect(homeScreenText({ screen: "plan", machine: "stopped" }).title).toBe("My Cloud isn't running");
  for (const machine of ["stopped", "payment-problem"] as const) {
    const told = homeScreenText({ screen: "plan", machine, name: "Acme", member: true });
    expect(told, "a team's User asks its owner, and has nothing to press").toMatchObject({ title: "Acme isn't running", body: "Ask its owner to start it again. Its files are kept for a while.", action: null });
  }
  expect(homeScreenText({ screen: "plan", machine: "stopped", name: "Acme" }).body, "whoever pays is told how").toContain("Subscribe again on your Plan page");
  expect(homeScreenText({ screen: "plan", machine: "payment-problem", name: "Acme" }).action).toBe("manage");
  expect(homeScreenText({ screen: "plan", machine: "failed", name: "Acme", member: true }).body, "a failed machine isn't anyone's plan").not.toContain("owner");
  expect(homeScreenText({ screen: "waking", name: "Acme" }).title, "only My Cloud is woken").toBe("Waking My Cloud…");
  expect(homeScreenText(null).title).toBe("Opening My Cloud…");
  expect(homeScreenText({ screen: "moving" }).title).toBe("Moving to My Cloud… almost done");
  expect(homeScreenText({ screen: "moving", name: "Garage server" })).toMatchObject({ title: "Moving to Garage server… almost done", action: null, busy: true });
});

it("while the Admin sets My Cloud up, the screen says so plainly, with its step, and never asks the person to do anything", () => {
  const setup = homeScreenText({ screen: "setup", step: "storage" });
  expect(setup).toEqual({ title: "Setting up My Cloud…", body: "This takes about a minute. It opens by itself when it's ready.", reason: null, action: null, busy: true });
  expect(homeScreenText({ screen: "setup", name: "Acme" }).title).toBe("Setting up Acme…");
  expect(homeScreenText({ screen: "setup", step: "starting", slow: true }).body).toMatch(/taking longer than usual/);
  const steps = renderToStaticMarkup(createElement(CloudSetupSteps, { step: "checking" }));
  expect(steps).toContain('data-cloud-setup="checking"');
  expect(steps).toMatch(/aria-current="step"[^>]*>Checking it&#x27;s ready</);
  for (const words of Object.values(setup)) expect(String(words)).not.toMatch(/Server menu|choose it again|DNS|resolv|ERR_/i);
});

it("says why My Cloud can't be reached in the app's language, and keeps the Admin's English when no cause comes", () => {
  setLocale("pt-br");
  expect(homeScreenText({ screen: "offline", reason: "The server My Cloud runs on is being restarted.", cause: "host" }).reason).toMatch(/^Nosso provedor de hospedagem/);
  expect(homeScreenText({ screen: "offline", reason: "My Cloud hasn't answered.", cause: "no_answer" }).reason).toMatch(/^O Cloud não responde/);
  expect(homeScreenText({ screen: "offline", reason: "An older desktop's words." }).reason).toBe("An older desktop's words.");
});

it("a Cloud that isn't running says what it is in plain words with its one action; one that doesn't answer says Try again, with no endless spinner", () => {
  const now = new Date(2026, 9, 30, 12).getTime(), day = new Date(2026, 10, 1, 9).getTime();
  expect(homeScreenText({ screen: "ended", name: "My Cloud", deleteAt: day }, now))
    .toEqual({ title: "My Cloud has ended.", body: "Its files are deleted on November 1.", reason: null, action: "buy", busy: false });
  expect(homeScreenText({ screen: "ended" }).title).toBe("This Cloud has ended.");
  expect(homeScreenText({ screen: "ended", name: "Old" }).body, "its files' day only when the Admin names it").toBeNull();
  expect(homeScreenText({ screen: "checkout", name: "Client B" })).toEqual({ title: "The checkout for Client B wasn't finished.", body: null, reason: null, action: "continue", busy: false });
  expect(homeScreenText({ screen: "checkout" }).title).toBe("This checkout wasn't finished.");
  expect(homeScreenText({ screen: "payment", name: "Client B" }))
    .toEqual({ title: "The payment for Client B didn't go through.", body: "Update your card to keep using it.", reason: null, action: "card", busy: false });
  expect(homeScreenText({ screen: "offline", name: "Acme" })).toMatchObject({ title: "Can't reach Acme right now.", action: "retry", busy: false });
  expect(homeScreenText({ screen: "offline" })).toMatchObject({ title: "Can't reach My Cloud right now.", action: "retry", busy: false });
  expect(homeDay(new Date(2027, 0, 5).getTime(), now), "another year is named").toBe("January 5, 2027");
  for (const screen of ["ended", "checkout", "payment"] as const) {
    for (const words of Object.values(homeScreenText({ screen, name: "Client B", deleteAt: day }, now))) expect(String(words)).not.toMatch(/—|\bVM\b|engine|ctx|server/i);
  }
});

it("My Cloud this computer couldn't connect to names its address and what may be in the way, with Try again", () => {
  expect(homeScreenText({ screen: "offline", cause: "network", host: "omb-t-1.fly.dev" })).toMatchObject({
    title: "Can't reach My Cloud right now.", action: "retry",
    reason: "This computer couldn't connect to omb-t-1.fly.dev. If My Cloud opens on another device or network, check whether a VPN, firewall or DNS filter here blocks that address.",
  });
});

it("an Admin that asked the app to wait says when it tries again by itself, and nothing once that time has passed", () => {
  const now = new Date(2026, 10, 20, 15, 0).getTime(), at = new Date(2026, 10, 20, 15, 5).getTime();
  const time = new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(new Date(at));
  expect(homeScreenText({ screen: "offline", retryAt: at }, now)).toMatchObject({
    action: "retry", reason: `MausBot Cloud asked this app to wait before it signs in to My Cloud again. The app tries again by itself at ${time}.`,
  });
  expect(homeScreenText({ screen: "offline", retryAt: at }, at + 1).reason).toBeNull();
});
