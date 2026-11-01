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
