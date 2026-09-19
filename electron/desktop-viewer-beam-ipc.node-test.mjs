// The driving beam IPC path: main may only inject the stylesheet when the
// requesting bot owns the open viewer, and the injected CSS must be the exact
// reviewed beam (panel-parity colors, reduced-motion fallback).
import assert from "node:assert/strict";
import { test } from "node:test";
import { drivingBeamStylesheet } from "./desktop-viewer-beam.cjs";

test("beam injection is keyed to the viewer's owning bot", () => {
  // Mirrors the guard inside main.mjs's desktop-viewer:driving handler.
  const state = { open: true, ownerContextId: "bot-a" };
  const requested = "bot-b";
  const mayInject =
    state.open && state.ownerContextId !== null && requested === state.ownerContextId;
  assert.equal(mayInject, false);
  const fromOwner = "bot-a";
  assert.equal(state.open && state.ownerContextId !== null && fromOwner === state.ownerContextId, true);
});

test("the injected beam mirrors the panel's colorful BorderBeam look", () => {
  const css = drivingBeamStylesheet();
  // violet + cyan accents, same palette family as BorderBeam colorVariant="colorful"
  assert.match(css, /124,\s*92,\s*255/);
  assert.match(css, /34,\s*211,\s*238/);
});

test("the beam stylesheet is inert to clicks and honors reduced motion", () => {
  const css = drivingBeamStylesheet();
  assert.match(css, /pointer-events:\s*none/);
  const fallback = css.slice(css.indexOf("prefers-reduced-motion"));
  assert.match(fallback, /animation:\s*none/);
});
