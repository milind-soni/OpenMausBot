import { beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
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

it("says why My Cloud can't be reached in the app's language, and keeps the Admin's English when no cause comes", () => {
  setLocale("pt-br");
  expect(homeScreenText({ screen: "offline", reason: "The server My Cloud runs on is being restarted.", cause: "host" }).reason).toMatch(/^Nosso provedor de hospedagem/);
  expect(homeScreenText({ screen: "offline", reason: "My Cloud hasn't answered.", cause: "no_answer" }).reason).toMatch(/^O Cloud não responde/);
  expect(homeScreenText({ screen: "offline", reason: "An older desktop's words." }).reason).toBe("An older desktop's words.");
});
