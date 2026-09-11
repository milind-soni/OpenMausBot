import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VerifyCard } from "./VerifyCard";
import { t } from "@/lib/i18n";
import { showRun, type RunStep } from "@/lib/verify-steps";

const steps: RunStep[] = [
  { id: "s1", label: "doctor", command: "pnpm control:omb doctor --url http://127.0.0.1:8799", status: "passed", dryRun: false, verified: true },
  { id: "s2", label: "send", command: "node --experimental-strip-types scripts/control-omb.ts send --bot x --text y", status: "failed", dryRun: false, verified: true },
  { id: "s3", label: "git push", command: "git push origin main", status: "running", dryRun: false, verified: false },
];
const TAG = `>${t("chat.verify.verifiedTag")}<`;
const noop = () => undefined;
const render = (props: Partial<Parameters<typeof VerifyCard>[0]> = {}) =>
  renderToStaticMarkup(createElement(VerifyCard, { steps, canSave: true, staged: false, onDismiss: noop, onSave: noop, ...props }));

describe("VerifyCard", () => {
  it("renders nothing without steps", () => {
    expect(render({ steps: [] })).toBe("");
  });

  it("lists each step with its label, full command and status, tagging the verified ones, behind labelled controls", () => {
    const markup = render();
    expect(markup).toContain(`aria-label="${t("chat.verify.aria")}"`);
    expect(markup).toContain(`>${t("chat.verify.title")}<`);
    expect(markup).toContain("3 steps · 2 verified · 1 failed · 1 running");
    expect(markup).toContain(">doctor<");
    expect(markup).toContain(">send<");
    expect(markup).toContain(">git push<");
    expect(markup).toContain('title="pnpm control:omb doctor --url http://127.0.0.1:8799"');
    expect(markup).toContain('title="git push origin main"');
    // the tag sits between the label and the command, on verified steps only
    expect(markup.match(new RegExp(TAG, "g"))).toHaveLength(2);
    expect(markup).toMatch(new RegExp(`>doctor</span><span class="[^"]*text-success">${t("chat.verify.verifiedTag")}</span><code`));
    expect(markup).toMatch(/>git push<\/span><code/);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain(`aria-label="${t("chat.verify.collapse")}"`);
    expect(markup).toContain(`aria-label="${t("chat.verify.dismiss")}"`);
    expect(markup).toContain(t("chat.verify.save"));
  });

  it("explains under Save that it fills the message instead of sending", () => {
    expect(render()).toMatch(new RegExp(`${t("chat.verify.save")}</button><span class="text-\\[12px\\] text-ink-secondary">${t("chat.verify.saveHint")}</span>`));
  });

  it("announces the summary and makes the step list reachable by keyboard", () => {
    const markup = render();
    expect(markup).toMatch(/<span role="status" aria-live="polite" aria-atomic="true"[^>]*>3 steps · 2 verified · 1 failed · 1 running</);
    expect(markup).toMatch(/<ol tabindex="0" aria-label="[^"]+"/);
    expect(markup).not.toContain('role="region"');
  });

  it("starts collapsed for a long run, keeping only the header", () => {
    const long = Array.from({ length: 7 }, (_, i) => ({ ...steps[0], id: `s${i}`, label: `step${i}` }));
    const markup = render({ steps: long });
    expect(markup).toContain("7 steps · 7 verified");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(`aria-label="${t("chat.verify.expand")}"`);
    expect(markup).not.toContain("<ol");
    expect(markup).not.toContain(t("chat.verify.save"));
    expect(markup).not.toContain(t("chat.verify.saveHint"));
  });

  it("has no footer at all when the run cannot be saved", () => {
    const markup = render({ canSave: false });
    expect(markup).toContain(">doctor<");
    expect(markup).not.toContain(t("chat.verify.save"));
    expect(markup).not.toContain("<button disabled");
    expect(markup).not.toContain(t("chat.verify.staged"));
    expect(markup).not.toContain(t("chat.verify.saveHint"));
  });

  it("says the skill is staged instead of offering Save again", () => {
    const markup = render({ staged: true });
    expect(markup).toContain(t("chat.verify.staged"));
    expect(markup).not.toContain(t("chat.verify.save"));
    expect(markup).not.toContain(t("chat.verify.saveHint"));
  });

  it("renders whatever steps it is given; whether one unverified command is worth a card is the caller's call", () => {
    const one = [steps[2]];
    const markup = render({ steps: one });
    expect(markup).toContain(`aria-label="${t("chat.verify.aria")}"`);
    expect(markup).toContain("1 step · 1 running");
    expect(markup).toContain(">git push<");
    expect(markup).not.toContain(TAG);
    // ChatView asks this before mounting the card
    expect(showRun(one)).toBe(false);
    expect(showRun(steps)).toBe(true);
  });
});
