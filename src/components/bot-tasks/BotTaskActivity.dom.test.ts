// @vitest-environment happy-dom
// A task's activity as a person reads it: oldest first, proof spelled out, GitHub's part marked, and GitHub's words
// shown as GitHub shows them (sanitized Markdown), with entry links only to github.com.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotTaskActivity } from "../../../shared/bot-tasks";
import { setLocale } from "@/lib/i18n";
import { BotTaskActivityList } from "./BotTaskActivity";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
});

const lin = { kind: "bot", id: "b1", name: "Lin" } as const;
const render = (activity: BotTaskActivity[], taskRepo = "acme/gadgets") =>
  flushSync(() => root.render(createElement(BotTaskActivityList, { activity, taskRepo, ownerName: (id: string) => (id === "b2" ? "Rigel" : id) })));
const rows = () => [...host.querySelectorAll<HTMLLIElement>("ol > li")];

describe("BotTaskActivityList", () => {
  it("lists entries oldest first, whatever order they came in", () => {
    render([
      { id: "c", at: 3000, by: lin, type: "comment", text: "third" },
      { id: "a", at: 1000, by: lin, type: "created" },
      { id: "b", at: 2000, by: lin, type: "owner", to: "b2" },
    ]);
    expect(rows().map((row) => row.dataset.activity)).toEqual(["created", "owner", "comment"]);
    expect(rows()[1]!.textContent).toContain("Lin gave it to Rigel");
  });

  it("spells out each kind of proof on a status change", () => {
    render([{
      id: "s", at: 1, by: lin, type: "status", from: "in_progress", to: "done", evidence: [
        { kind: "commit", sha: "0123456789abcdef0123456789abcdef01234567" },
        { kind: "ci_run", url: "https://github.com/acme/gadgets/actions/runs/42" },
        { kind: "review_url", url: "https://reviews.example.com/7" },
        { kind: "command", command: "pnpm test", exitCode: 0 },
        { kind: "command", command: "pnpm lint", exitCode: 1 },
      ],
    }]);
    expect(rows()[0]!.textContent).toContain("Lin moved it from In progress to Done");
    const proof = [...host.querySelectorAll<HTMLLIElement>("[data-evidence]")];
    expect(proof.map((one) => one.dataset.evidence)).toEqual(["commit", "ci_run", "review_url", "command", "command"]);
    expect(proof[0]!.querySelector("code")!.textContent).toBe("0123456");
    expect(proof[0]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/acme/gadgets/commit/0123456789abcdef0123456789abcdef01234567");
    expect(proof[1]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/acme/gadgets/actions/runs/42");
    expect(proof[2]!.querySelector("a"), "a review off github.com stays text").toBeNull();
    expect(proof[2]!.textContent).toContain("https://reviews.example.com/7");
    expect(proof[3]!.textContent).toBe("pnpm testexit 0");
    expect(proof[4]!.querySelector(".text-danger")!.textContent).toBe("exit 1");
  });

  it("marks what came from GitHub, and only that", () => {
    render([
      { id: "1", at: 1, by: lin, type: "comment", text: "on it" },
      { id: "2", at: 2, by: { kind: "github", login: "octocat" }, type: "github_comment", text: "LGTM", url: "https://github.com/acme/gadgets/pull/12#issuecomment-1" },
      { id: "3", at: 3, by: { kind: "github", login: "octocat" }, type: "github_review", state: "CHANGES_REQUESTED", text: "" },
      { id: "4", at: 4, by: { kind: "system" }, type: "github_check", name: "ci", conclusion: "success" },
      { id: "5", at: 5, by: { kind: "system" }, type: "github_state", state: "merged" },
      { id: "6", at: 6, by: lin, type: "posted", url: "https://github.com/acme/gadgets/pull/12#issuecomment-2" },
    ]);
    expect(rows().map((row) => row.hasAttribute("data-from-github"))).toEqual([false, true, true, true, true, false]);
    expect(rows()[2]!.textContent).toContain("octocat reviewed: changes requested");
    expect(rows()[1]!.querySelector("a")!.getAttribute("href")).toBe("https://github.com/acme/gadgets/pull/12#issuecomment-1");
  });

  it("drops links that leave github.com", () => {
    render([
      { id: "1", at: 1, by: { kind: "github", login: "mallory" }, type: "github_comment", text: "hi", url: "javascript:alert(1)" },
      { id: "2", at: 2, by: { kind: "github", login: "mallory" }, type: "github_comment", text: "hi", url: "https://github.com.evil.io/x" },
    ]);
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });

  it("renders GitHub's words as GitHub does: a collapsed <details> that opens, and a GFM table", () => {
    const text = [
      "Review notes",
      "",
      "<details>",
      "<summary>Full test log</summary>",
      "",
      "```",
      "ok 1 - parses",
      "```",
      "",
      "</details>",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| lint | pass |",
      "| ~~e2e~~ | skipped |",
      "",
      "- [x] typecheck",
      "- [ ] release",
    ].join("\n");
    render([{ id: "1", at: 1, by: { kind: "github", login: "octocat" }, type: "github_comment", text, imported: true }]);
    const body = rows()[0]!.querySelector("[data-task-markdown]")!;
    const details = body.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Full test log");
    expect(details.textContent).toContain("ok 1 - parses");
    details.querySelector("summary")!.click();
    expect(details.open).toBe(true);
    expect([...body.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Check", "Result"]);
    expect([...body.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["lint", "pass", "e2e", "skipped"]);
    expect(body.querySelector("td del")!.textContent).toBe("e2e");
    expect([...body.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map((box) => [box.checked, box.disabled])).toEqual([[true, true], [false, true]]);
  });

  it("strips what GitHub strips: script tags, event handlers and javascript: links", () => {
    const text = [
      '<script>window.pwned = 1</script>',
      '<img src="https://example.com/a.png" alt="shot" onerror="alert(1)">',
      '<a href="javascript:alert(1)">raw</a> [md](javascript:alert(1)) [ok](https://example.com/docs)',
      '<iframe src="https://example.com"></iframe><style>body{display:none}</style>',
      '<details open onclick="alert(1)"><summary onmouseover="alert(1)">More</summary>inside</details>',
      "**bold**",
    ].join("\n\n");
    render([{ id: "1", at: 1, by: { kind: "github", login: "mallory" }, type: "github_comment", text }]);
    const body = rows()[0]!.querySelector("[data-task-markdown]")!;
    expect(body.querySelector("script, style, iframe")).toBeNull();
    expect(body.textContent).not.toContain("window.pwned");
    expect(body.innerHTML).not.toMatch(/onerror|onclick|onmouseover|javascript:/i);
    const img = body.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img.getAttribute("alt")).toBe("shot");
    const links = [...body.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://example.com/docs"]);
    expect(links[0]!.target).toBe("_blank");
    expect(links[0]!.rel).toBe("noopener noreferrer");
    expect(body.querySelector("details")!.open).toBe(true);
    expect(body.querySelector("strong")!.textContent).toBe("bold");
  });

  it("marks history imported from GitHub and shows its original GitHub time as a date, normal entries keep the relative time", () => {
    const original = Date.UTC(2025, 2, 14, 9, 30);
    render([
      { id: "1", at: original, by: { kind: "github", login: "octocat" }, type: "github_comment", text: "old note", imported: true },
      { id: "2", at: original + 1000, by: lin, type: "github_ref", ref: { repo: "acme/gadgets", number: 12 } },
    ]);
    const [imported, linked] = rows();
    expect(imported!.hasAttribute("data-imported")).toBe(true);
    expect(imported!.querySelector("[data-github-badge]")!.textContent).toBe("Imported from GitHub");
    const time = imported!.querySelector<HTMLTimeElement>("time[data-original-time]")!;
    expect(time.dateTime).toBe(new Date(original).toISOString());
    expect(time.textContent).toContain("2025");
    expect(time.title).toBe(`Original time on GitHub: ${time.textContent}`);
    expect(linked!.hasAttribute("data-imported")).toBe(false);
    expect(linked!.querySelector("[data-github-badge]")).toBeNull();
    expect(linked!.querySelector("time[data-original-time]")).toBeNull();
    expect(linked!.querySelector("time")!.textContent).not.toContain("2025");
  });

  it("shows a recorded command as self-reported using the neutral verification badge", () => {
    render([{
      id: "s", at: 1, by: lin, type: "status", from: "review", to: "done", evidence: [
        { kind: "command", command: "pnpm test", exitCode: 0, verification: { status: "unverifiable", checkedAt: 1, detail: "Recorded exit code 0." } },
      ],
    }]);
    expect(host.querySelector("[data-verification-badge]")?.textContent).toBe("Not verifiable");
    expect(host.querySelector("[data-verification-line]")?.textContent).toContain("Self-reported exit code 0, not independently checked.");
  });

  it("badges each checked claim: verified, failed as an error, not verifiable as neutral, with when and why", () => {
    const checkedAt = Date.UTC(2026, 10, 27, 9, 0);
    render([{
      id: "s", at: 1, by: lin, type: "status", from: "review", to: "done", evidence: [
        { kind: "commit", sha: "0123456789abcdef0123456789abcdef01234567", verification: { status: "verified", checkedAt } },
        { kind: "ci_run", url: "https://github.com/acme/gadgets/actions/runs/42", verification: { status: "failed", checkedAt, detail: "The run failed" } },
        { kind: "review_url", url: "https://reviews.example.com/7", verification: { status: "unverifiable", checkedAt, detail: "Not on GitHub" } },
        { kind: "command", command: "pnpm test", exitCode: 0 },
      ],
    }]);
    const proof = [...host.querySelectorAll<HTMLLIElement>("[data-evidence]")];
    const badge = (item: HTMLLIElement) => item.querySelector<HTMLElement>("[data-verification-badge]");
    expect(proof.map((item) => badge(item)?.textContent ?? null)).toEqual(["Verified", "Failed", "Not verifiable", null]);
    expect(badge(proof[1]!)!.className).toContain("text-danger");
    expect(badge(proof[2]!)!.className).not.toContain("danger");
    const line = (item: HTMLLIElement) => item.querySelector<HTMLElement>("[data-verification-line]");
    expect(line(proof[0]!)!.textContent).toMatch(/^Checked .*2026/);
    expect(line(proof[1]!)!.textContent).toMatch(/^The run failed · Checked /);
    expect(line(proof[1]!)!.className).toContain("text-danger");
    expect(line(proof[2]!)!.textContent).toMatch(/^Not on GitHub · Checked /);
    expect(badge(proof[1]!)!.title).toContain("The run failed");
    expect(badge(proof[1]!)!.title).toContain("Checked ");
    expect(line(proof[3]!), "older proof without a check shows no badge and no line").toBeNull();
    expect(proof[3]!.textContent).toBe("pnpm testexit 0");
  });
});
