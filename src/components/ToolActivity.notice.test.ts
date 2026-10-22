import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced }));

const { ToolActivity } = await import("./ToolActivity");
const { setLocale } = await import("@/lib/i18n");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) => renderToStaticMarkup(createElement(ToolActivity, { tool }));

const resumed = { name: "Resuming after a restart", ok: true, nameCode: "chat.notice.resumingAfterRestart" };
const held = (name: string) => ({
  name: `${name} is held (stopped by you) — @mention it or say resume`, ok: false, nameCode: "chat.notice.roomHeld", nameParams: { name },
});

afterEach(() => {
  mode.advanced = false;
  setLocale("en");
});

describe("a server notice in ToolActivity", () => {
  it.each([false, true])("is worded in the person's language without its English name in the details (advanced: %s)", (advanced) => {
    mode.advanced = advanced;
    setLocale("pt-br");
    const html = render(resumed);
    expect(html).toContain("Retomando após uma reinicialização");
    expect(html).not.toContain("Resuming after a restart");
    expect(html).not.toContain('data-testid="tool-name"');
    expect(html).not.toContain("font-mono\">Retomando");
  });

  it("fills its params", () => {
    setLocale("pt-br");
    expect(render(held("Scout"))).toContain("Você parou Scout. Mencione com @ ou escreva “retomar”.");
  });

  it("keeps the English for a code this build does not know or a param that is missing", () => {
    setLocale("pt-br");
    const unknown = render({ name: "A notice from a newer server", ok: true, nameCode: "chat.notice.inventedLater" });
    expect(unknown).toContain("A notice from a newer server");
    const missing = render({ ...held("Scout"), nameParams: undefined });
    expect(missing).toContain("Scout is held (stopped by you) — @mention it or say resume");
    expect(missing).not.toContain("{name}");
  });

  it("shows markup in a param as text", () => {
    setLocale("pt-br");
    const html = render(held("<img src=x onerror=alert(1)>"));
    expect(html).toContain("Você parou &lt;img src=x onerror=alert(1)&gt;.");
    expect(html).not.toContain("<img");
  });
});
