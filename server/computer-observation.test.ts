import { describe, expect, it } from "vitest";
import { ObservationCoordinator } from "./computer-observation.ts";

describe("computer observation coordinator", () => {
  it("captures after actions but sends vision only for changed pixels", () => {
    const coordinator = new ObservationCoordinator();
    expect(coordinator.observeFrame("frame-a", null)).toMatchObject({ changed: true });
    coordinator.noteAction();
    expect(coordinator.observeFrame("frame-a", null)).toMatchObject({ changed: false });
    coordinator.noteAction();
    expect(coordinator.observeFrame("frame-b", { x: 20, y: 20, width: 100, height: 100 })).toMatchObject({ changed: true });
    coordinator.noteRetry();
    coordinator.noteStructuredObservation();
    coordinator.noteVerification(true);
    coordinator.noteVerification(false);
    expect(coordinator.metrics).toEqual({
      screenshotsCaptured: 3,
      screenshotsSentToModel: 2,
      fullScreenObservations: 1,
      croppedObservations: 1,
      structuredBrowserObservations: 1,
      computerActions: 2,
      retries: 1,
      verificationSuccesses: 1,
      verificationFailures: 1,
    });
  });
});
