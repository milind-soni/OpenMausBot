// The live-desktop window is remote content (a noVNC page Astra's React tree
// never renders), so the "Astra is driving" beam cannot be a React component
// the way ComputerPanel's BorderBeam is. Main injects this stylesheet into the
// viewer's webContents while the owning bot drives, and removes it when the
// bot stops. Pure and synchronous so the shape of what ships inside the
// sandboxed viewer stays trivially reviewable (see desktop-viewer-beam.node-test.mjs).
"use strict";

const BEAM_CSS = `
@property --astra-beam-angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  padding: 3px;
  background: conic-gradient(
    from var(--astra-beam-angle),
    rgba(124, 92, 255, 0) 0deg,
    rgba(124, 92, 255, 0.95) 40deg,
    rgba(34, 211, 238, 0.9) 70deg,
    rgba(124, 92, 255, 0) 140deg
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask-composite: exclude;
  animation: astra-beam-spin 2.4s linear infinite;
}
@keyframes astra-beam-spin {
  to { --astra-beam-angle: 360deg; }
}
@media (prefers-reduced-motion: reduce) {
  body::after {
    animation: none;
    background: rgba(124, 92, 255, 0.75);
  }
}
`;

/** The stylesheet injected into the live-desktop viewer while Astra drives.
 *  A rotating conic ring rides the viewport edge (mirroring the panel's
 *  colorful BorderBeam); under reduced motion it degrades to a static violet
 *  frame. `body::after` + pointer-events:none keeps the VNC canvas fully
 *  clickable underneath. */
function drivingBeamStylesheet() {
  return BEAM_CSS;
}

module.exports = { drivingBeamStylesheet };
