/**
 * Starts the managed HTTPS connection when the phone link starts. A stored address may have been removed while this
 * computer was away, so `check` asks the control plane first: a gone one is provisioned again (or forgotten for the
 * relay) rather than dialled for nothing. `wait` holds the start until the address verifies; the desktop sets it only
 * while Anywhere (the relay) is off, since with the relay on pairing never waits on the HTTPS address. Without
 * `wait` the connection starts behind the check, and only while `desired()` still holds.
 */
export async function startCheckedManagedConnection({ check, start, wait, desired }) {
  const checked = Promise.resolve().then(check).catch(() => null);
  if (wait) {
    await checked;
    await start({ waitForVerification: true });
    return;
  }
  void checked.then(() => (desired() ? start({ waitForVerification: false }) : null)).catch(() => {});
}
