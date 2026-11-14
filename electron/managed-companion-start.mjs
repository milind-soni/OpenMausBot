/** How long a start waits for the stored-address check before it dials anyway; the check corrects it afterwards. */
export const STORED_ADDRESS_CHECK_WAIT_MS = 3_000;

/**
 * Starts the managed HTTPS connection when the phone link starts. A stored address may have been removed while this
 * computer was away, so `check` asks the control plane first: a gone one is provisioned again (or forgotten for the
 * relay) rather than dialled for nothing. The check holds the start for at most `checkWaitMs`. `wait` then holds the
 * caller until the address verifies; the desktop sets it only for a start that turns on routes without Anywhere (the
 * relay), since with the relay on pairing never waits on the HTTPS address, and a Wi-Fi or Tailscale start never
 * waits on it at all. The connection starts only while `desired()` still holds.
 */
export async function startCheckedManagedConnection({ check, start, wait, desired, checkWaitMs = STORED_ADDRESS_CHECK_WAIT_MS }) {
  const checked = Promise.resolve().then(check).catch(() => null);
  let timer = null;
  const capped = Promise.race([
    checked,
    new Promise((resolve) => {
      timer = setTimeout(resolve, checkWaitMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (wait) {
    await capped;
    if (desired()) await start({ waitForVerification: true });
    return;
  }
  void capped.then(() => (desired() ? start({ waitForVerification: false }) : null)).catch(() => {});
}
