import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VerifyCard } from "./VerifyCard";
import { t } from "@/lib/i18n";
import type { VerifyStep } from "@/lib/verify-steps";

const steps: VerifyStep[] = [
  { id: "s1", subcommand: "doctor", command: "pnpm control:omb doctor --url http://127.0.0.1:8799", status: "passed", dryRun: false },
  { id: "s2", subcommand: "send", command: "node --experimental-strip-types scripts/control-omb.ts send --bot x --text y", status: "failed", dryRun: false },
  { id: "s3", subcommand: "press", command: './node_modules/.bin/control-atlas.mjs press "Meta+K"', status: "running", dryRun: false },
];
const noop = () => undefined;
const render = (props: Partial<Parameters<typeof VerifyCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(VerifyCard, { steps, canSave: true, staged: false, onDismiss: noop, onSave: noop, ...props }));

describe("VerifyCard", () => {
  it("renders nothing without steps", () => {
    expect(render({ steps: [] })).toBe("");
  });

  it("lists each step with its subcommand, full command and status, behind labelled controls", () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t("chat.verify.aria")}"`);
    expect(markup).toContain("1 passed · 1 failed · 1 running");
    expect(markup).toContain(">doctor<");
    expect(markup).toContain(">send<");
    expect(markup).toContain(">press<");
    expect(markup).toContain('title="pnpm control:omb doctor --url http://127.0.0.1:8799"');
    expect(markup).toContain("Meta+K");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain(`aria-label="${t("chat.verify.collapse")}"`);
    expect(markup).toContain(`aria-label="${t("chat.verify.dismiss")}"`);
    expect(markup).toContain(t("chat.verify.save"));
  });

  it("announces the summary and makes the step list reachable by keyboard", () => {
    const markup = render();
    expect(markup).toMatch(/<span role="status" aria-live="polite" aria-atomic="true"[^>]*>1 passed · 1 failed · 1 running</);
    expect(markup).toMatch(/<ol tabindex="0" aria-label="[^"]+"/);
    expect(markup).not.toContain('role="region"');
  });

  it("starts collapsed for a long run, keeping only the header", () => {
    const long = Array.from({ length: 7 }, (_, i) => ({ ...steps[0], id: `s${i}`, subcommand: `step${i}` }));
    const markup = render({ steps: long });
    expect(markup).toContain("7 passed");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(`aria-label="${t("chat.verify.expand")}"`);
    expect(markup).not.toContain("<ol");
    expect(markup).not.toContain(t("chat.verify.save"));
  });

  it("has no footer at all when the run cannot be saved", () => {
    const markup = render({ canSave: false });
    expect(markup).toContain(">doctor<");
    expect(markup).not.toContain(t("chat.verify.save"));
    expect(markup).not.toContain("<button disabled");
    expect(markup).not.toContain(t("chat.verify.staged"));
  });

  it("says the skill is staged instead of offering Save again", () => {
    const markup = render({ staged: true });
    expect(markup).toContain(t("chat.verify.staged"));
    expect(markup).not.toContain(t("chat.verify.save"));
  });
});
