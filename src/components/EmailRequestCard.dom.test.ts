// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import type { EmailOutgoingFields } from "../../shared/email";
import { EmailOutgoingRequestForm } from "./EmailRequestCard";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const field = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const save = () => act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });

it("sends what the person typed for the outgoing server, shows why it still can't send, and nothing once it does", async () => {
  const answers = ["smtp.easy.example didn't answer on 587.", null];
  const submit = vi.fn(async (_fields: EmailOutgoingFields) => answers.shift() ?? null);
  await act(async () => root.render(createElement(EmailOutgoingRequestForm, { address: "me@shop.example", initial: { smtpHost: "smtp.shop.example", smtpPort: 465 }, submit })));
  expect(container.textContent).toContain("me@shop.example");
  await input("Outgoing mail server (SMTP)", "smtp.easy.example");
  await input("Port", "587");
  await choose("Security", "starttls");
  await input("Password for sending, if different", "fake-sending-password");
  await save();
  expect(submit).toHaveBeenLastCalledWith({ smtpHost: "smtp.easy.example", smtpPort: 587, smtpSecurity: "starttls", smtpPassword: "fake-sending-password" });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("smtp.easy.example didn't answer on 587.");
  await save();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
