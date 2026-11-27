import { ObservationCoordinator } from "../server/computer-observation.ts";

// Stable fixture: every requested observation still captures, because pages
// can update asynchronously. Only byte-identical frames are withheld from the
// model; deterministic actions therefore always receive fresh evidence.
const frames = ["initial", "initial", "after-click", "after-click", "after-submit", "after-submit", "after-submit"];
const baselineSent = frames.length;
const coordinator = new ObservationCoordinator();
for (const [index, frame] of frames.entries()) {
  // index 1 deliberately models an action whose pixels do not change: it
  // must still capture once, while duplicate suppression avoids a model send.
  if (index === 1 || index === 2 || index === 4) coordinator.noteAction();
  coordinator.observeFrame(frame, null);
}
const metrics = coordinator.metrics;
const reduction = ((1 - metrics.screenshotsSentToModel / baselineSent) * 100).toFixed(1);
const suppressed = metrics.screenshotsCaptured - metrics.screenshotsSentToModel;
if (suppressed < 1 || metrics.screenshotsCaptured !== frames.length) {
  throw new Error("fixture failed to capture every observation or suppress a duplicate");
}
console.log("Computer observation benchmark (offline deterministic fixture)");
console.log(`Screenshot observations sent to model: ${baselineSent} → ${metrics.screenshotsSentToModel} (${reduction}% reduction)`);
console.log(`Actions: ${metrics.computerActions}; screenshots captured: ${metrics.screenshotsCaptured}; duplicate captures suppressed: ${suppressed}`);
