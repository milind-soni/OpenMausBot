import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { CloudSetupSteps } from "./CloudSetupSteps";
import { homeScreenText } from "./HomeScreen";

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
