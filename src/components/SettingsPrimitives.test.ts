import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";

describe("settings primitives", () => {
  it("lays out a labeled setting and keeps its status outside the control column", () => {
    const html = renderToStaticMarkup(createElement(SettingRow, {
      title: "Language",
      subtitle: "Choose your app language.",
      children: createElement("select", { "aria-label": "App language" }, createElement("option", null, "English")),
      message: createElement("p", { role: "alert" }, "Could not save"),
    }));
    expect(html).toMatch(/role="group" aria-labelledby="[^"]+"/);
    expect(html).toContain("sm:grid-cols-[minmax(0,1fr)_auto]");
    expect(html).toContain('aria-label="App language"');
    expect(html).toContain('<p role="alert">Could not save</p>');
    expect(html).not.toContain("bg-card");
  });

  it("keeps the form card surface and native switch semantics", () => {
    const html = renderToStaticMarkup(createElement(Card, {
      title: "Profile",
      children: createElement(Switch, { checked: true, disabled: true, "aria-label": "Analytics" }),
    }));
    expect(html).toContain("bg-card");
    expect(html).toContain('type="button" role="switch" aria-checked="true"');
    expect(html).toContain('aria-label="Analytics"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("motion-reduce:transition-none");
  });
});
