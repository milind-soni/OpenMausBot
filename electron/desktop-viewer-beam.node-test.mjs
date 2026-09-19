import assert from "node:assert/strict";
import { test } from "node:test";
import { drivingBeamStylesheet } from "./desktop-viewer-beam.cjs";

test("the driving beam rides the viewport edge as a rotating conic ring", () => {
  const css = drivingBeamStylesheet();
  assert.match(css, /body::after/);
  assert.match(css, /conic-gradient/);
  assert.match(css, /animation:\s*astra-beam-spin/);
  assert.match(css, /@keyframes astra-beam-spin/);
});

test("the beam never intercepts input meant for the VNC canvas", () => {
  assert.match(drivingBeamStylesheet(), /pointer-events:\s*none/);
});

test("reduced motion gets a static frame instead of the spin", () => {
  const css = drivingBeamStylesheet();
  const fallback = css.slice(css.indexOf("prefers-reduced-motion"));
  assert.match(fallback, /animation:\s*none/);
});
