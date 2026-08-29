/**
 * Close the pre-provider dispatch window once the provider accepted a turn.
 *
 * A stop can race with sendTurn resolving. At that point the provider has
 * already accepted the turn, so cancellation interrupts it but must not be
 * reclassified as a pre-provider cancellation or skip normal bookkeeping.
 */
export async function completeAcceptedProviderDispatch(options: {
  cancelled: boolean;
  interrupt: () => Promise<void>;
  assertOwned: () => void;
  finish: () => void;
}): Promise<void> {
  if (options.cancelled) {
    await options.interrupt().catch(() => {});
  } else {
    options.assertOwned();
  }
  options.finish();
}
