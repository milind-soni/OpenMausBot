import { createHash } from "node:crypto";

/** Provider-neutral policy for deciding when a computer observation needs vision. */
export interface ObservationMetrics {
  screenshotsCaptured: number;
  screenshotsSentToModel: number;
  fullScreenObservations: number;
  croppedObservations: number;
  structuredBrowserObservations: number;
  computerActions: number;
  retries: number;
  verificationSuccesses: number;
  verificationFailures: number;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const emptyObservationMetrics = (): ObservationMetrics => ({
  screenshotsCaptured: 0,
  screenshotsSentToModel: 0,
  fullScreenObservations: 0,
  croppedObservations: 0,
  structuredBrowserObservations: 0,
  computerActions: 0,
  retries: 0,
  verificationSuccesses: 0,
  verificationFailures: 0,
});

/**
 * Keeps observations cheap without claiming the screen is immutable. Every
 * requested observation still captures fresh pixels (pages can change without
 * an input action), while byte-identical frames are not sent to the model twice.
 */
export class ObservationCoordinator {
  metrics = emptyObservationMetrics();
  private lastObservation: string | null = null;

  noteAction(count = 1) {
    this.metrics.computerActions += Math.max(0, Math.trunc(count));
  }

  noteRetry() {
    this.metrics.retries += 1;
  }

  /** canonicalFrame must describe the full screenshot, even when the image
   * returned to the model is cropped. A boat-provided full-frame hash works. */
  observeFrame(canonicalFrame: string | null, crop: CropRegion | null) {
    this.metrics.screenshotsCaptured += 1;
    const hash = canonicalFrame
      ? createHash("sha256").update(canonicalFrame).digest("hex")
      : null;
    const view = crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : "full";
    const signature = hash ? `${hash}:${view}` : null;
    // If the boat cannot provide a full-frame hash, fail open and send the
    // valid image. Suppressing a possibly-new crop would be worse.
    const changed = signature === null || signature !== this.lastObservation;
    if (signature) this.lastObservation = signature;
    if (changed) {
      this.metrics.screenshotsSentToModel += 1;
      if (crop) this.metrics.croppedObservations += 1;
      else this.metrics.fullScreenObservations += 1;
    }
    return { changed, hash };
  }

  noteStructuredObservation() {
    this.metrics.structuredBrowserObservations += 1;
  }

  noteVerification(ok: boolean) {
    if (ok) this.metrics.verificationSuccesses += 1;
    else this.metrics.verificationFailures += 1;
  }
}
