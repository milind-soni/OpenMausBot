// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ connected: true }));
vi.mock("@/lib/connected-apps", () => ({
  connectorStatusMemory: () => ({ authoritative: true, services: { googlecalendar: { connected: fixture.connected } } }),
  preloadConnectedApps: async () => ({ authoritative: true, refused: false, services: { googlecalendar: { connected: fixture.connected } } }),
}));
vi.mock("@/lib/connector-status", () => ({ hasActiveConnection: (service: { connected?: boolean }) => service.connected === true }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: (select: (state: unknown) => unknown) => select({ pluginsOpen: false }) }));

import { setRelayLink } from "@/lib/relay-server";
import { CalendarAgenda } from "./CalendarAgenda";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const nativeFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  setRelayLink(null);
  globalThis.fetch = nativeFetch;
  fixture.connected = true;
  document.body.innerHTML = "";
});

it("routes reads and saves through serverFetch (RelayLink), recovers from save failures without locking settings, and refreshes on visibility", async () => {
  let selectedCalendarIds: string[] = [];
  let failNextSave = true;
  let eventTitle = "School pickup";
  const relayCalls: Array<{ path: string; method: string }> = [];
  setRelayLink({
    close: () => undefined,
    fetch: async (path, request) => {
      const method = request?.method ?? "GET";
      relayCalls.push({ path, method });
      if (path === "/api/dashboard/calendar-agenda" && method === "PUT") {
        if (failNextSave) {
          failNextSave = false;
          return jsonResponse({ error: "Temporary failure" }, 503);
        }
        selectedCalendarIds = (JSON.parse(new TextDecoder().decode(request?.body ?? new Uint8Array())) as { calendarIds: string[] }).calendarIds;
        return jsonResponse({ selectedCalendarIds });
      }
      if (path.includes("calendarId=")) {
        return jsonResponse([{ date: "2026-11-25", events: [
          { id: "primary:event-1", calendarId: "primary", title: eventTitle, start: "2026-11-25T15:00:00Z", end: "2026-11-25T15:30:00Z", allDay: false, color: "#1a73e8" },
          { id: "team:event-2", calendarId: "team", title: "Team planning", start: "2026-11-25T16:00:00Z", end: "2026-11-25T16:30:00Z", allDay: false },
        ] }]);
      }
      return jsonResponse({
        calendars: [{ id: "primary", name: "Personal", primary: true, color: "#1a73e8" }, { id: "team", name: "Team", primary: false }],
        selectedCalendarIds,
      });
    },
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(CalendarAgenda)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.textContent).toContain("Personal");
  expect(relayCalls[0]).toEqual({ path: "/api/dashboard/calendar-agenda", method: "GET" });

  const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => { boxes[0]!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t save your calendar selection.");
  const settingsButton = container.querySelector<HTMLButtonElement>("[aria-label='Calendar settings']")!;
  expect(settingsButton.disabled).toBe(false);

  await act(async () => { container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(container.querySelector('[role="alert"]')).toBeNull();

  await act(async () => { boxes[1]!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(selectedCalendarIds).toEqual(["primary", "team"]);

  await act(async () => { settingsButton.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(relayCalls.at(-1)).toEqual({ path: "/api/dashboard/calendar-agenda?calendarId=primary&calendarId=team", method: "GET" });
  expect(container.querySelector("[data-agenda-month] button")?.firstChild?.textContent).toBe("November 2026");
  expect([...container.querySelectorAll("[data-agenda-event]")].map((event) => event.textContent)).toEqual([
    "16:00School pickup", "17:00Team planning",
  ]);
  expect(container.querySelector<HTMLElement>("[data-agenda-event]")?.style.borderInlineStartColor).toBe("#1a73e8");

  eventTitle = "Updated pickup";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(container.textContent).toContain("Updated pickup");
  await act(async () => { root.unmount(); });

  const returningContainer = document.createElement("div");
  document.body.appendChild(returningContainer);
  const returningRoot = createRoot(returningContainer);
  await act(async () => { returningRoot.render(createElement(CalendarAgenda)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(returningContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).toHaveLength(0);
  expect(returningContainer.textContent).toContain("Updated pickup");
  await act(async () => { returningRoot.unmount(); });
});

it("renders no agenda loading placeholders and makes no network requests while Calendar is disconnected", async () => {
  fixture.connected = false;
  const fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(CalendarAgenda)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(container.querySelector('[aria-label="Loading calendars"]')).toBeNull();
  expect(container.querySelector('[aria-label="Loading agenda"]')).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  await act(async () => { root.unmount(); });
});
