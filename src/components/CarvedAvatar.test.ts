import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CarvedAvatar, REST_POSE, carvedFills, carvedGeometry } from "./CarvedAvatar";
import { MausAvatar } from "./Avatar";
import { CARVED_BODIES, CARVED_BODY_IDS } from "../../shared/carved-bodies";
import { MAUS_COLORS } from "@/lib/mascot";

const render = (body: (typeof CARVED_BODY_IDS)[number], color: "orange" | "purple" = "orange") =>
  renderToStaticMarkup(createElement(CarvedAvatar, { body, color, animated: false, label: body }));

describe("CarvedAvatar", () => {
  it("draws every part, two eyes, and a smile unless the drawing has its own mouth", () => {
    for (const id of CARVED_BODY_IDS) {
      const markup = render(id);
      const body = CARVED_BODIES[id];
      expect(markup).toContain(`data-carved-body="${id}"`);
      expect(markup.match(/<rect /g)?.length, id).toBe(2);
      expect(markup.match(/<path /g)?.length, id).toBe(body.parts.length + 1 + (body.eyes.mouth ? 1 : 0));
      expect(markup.includes("<ellipse"), id).toBe(body.eyes.mouth);
    }
  });

  it.each(["pumpkin", "laddu"] as const)("is what MausAvatar wears for the %s body", (bodyId) => {
    const markup = renderToStaticMarkup(createElement(MausAvatar, { color: "orange", bodyId, animated: false }));
    expect(markup).toContain(`data-carved-body="${bodyId}"`);
    expect(markup).not.toContain("linearGradient");
  });

  it("fills flat with the bot's colour, pale for the ghost, bone for the skull", () => {
    expect(render("pumpkin")).not.toContain("linearGradient");
    expect(carvedFills(CARVED_BODIES.pumpkin, "orange").body).not.toBe(MAUS_COLORS.orange);
    expect(carvedFills(CARVED_BODIES.ghost, "purple").body).toMatch(/^#[e-f]/);
    expect(carvedFills(CARVED_BODIES.skull, "purple").body).toBe(CARVED_BODIES.skull.bone);
  });

  it("paints firecrackers in the bot's colour and sweets in their own", () => {
    expect(carvedFills(CARVED_BODIES.rocket, "blue").body).toBe(carvedFills(CARVED_BODIES.pumpkin, "blue").body);
    expect(carvedFills(CARVED_BODIES.laddu, "blue").body).toBe(CARVED_BODIES.laddu.bone);
    expect(carvedFills(CARVED_BODIES.jalebi, "purple").body).toBe(carvedFills(CARVED_BODIES.jalebi, "green").body);
  });

  it("opens round eyes and an open mouth when startled", () => {
    const body = CARVED_BODIES.pumpkin;
    const rest = carvedGeometry(body, REST_POSE);
    const wide = carvedGeometry(body, { ...REST_POSE, wide: 1 });
    expect(rest.eyes[0].height).toBeGreaterThan(rest.eyes[0].width * 1.5);
    expect(Math.abs(wide.eyes[0].height - wide.eyes[0].width)).toBeLessThan(body.eyes.round * 0.1);
    expect(rest.smile.opacity).toBe(1);
    expect(wide.smile.opacity).toBe(0);
    expect(wide.open.opacity).toBe(1);
  });

  it("closes the eyes and follows the gaze", () => {
    const body = CARVED_BODIES.cat;
    const shut = carvedGeometry(body, { ...REST_POSE, shut: 1 });
    expect(shut.eyes[0].height).toBeLessThan(body.eyes.h * 0.15);
    const left = carvedGeometry(body, { ...REST_POSE, gx: -1 });
    const rest = carvedGeometry(body, REST_POSE);
    expect(left.eyes[0].x).toBeLessThan(rest.eyes[0].x);
    expect(left.body).toContain("rotate(9)");
  });
});
