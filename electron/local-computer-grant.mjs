// "This computer" belongs to the server this app launched, and to no other. The app hands that one child its driver
// connection over the child's private utility-process port, which no other process on the computer can read or write,
// and sends it again whenever the driver changes. The connection file the app also keeps grants nothing: a server reads
// this computer only from this message (server/desktop-computer.ts), so a second OpenMausBot server never finds it.
export const LOCAL_COMPUTER_GRANT = "openmausbot:local-computer";

export function localComputerGrantMessage(connection) {
  return {
    type: LOCAL_COMPUTER_GRANT,
    connection: connection && typeof connection === "object" && !Array.isArray(connection) ? connection : null,
  };
}

/** `connection()`: the driver record now. `attach(proc, isCurrent)` on each server child's spawn; `changed()` after
 * every driver change. A child that is no longer the current one is never sent anything. */
export function createLocalComputerGrant({ connection, log = () => {} }) {
  let target = null;
  let current = () => false;
  const send = () => {
    const proc = target;
    if (!proc || !current(proc)) return;
    try {
      proc.postMessage(localComputerGrantMessage(connection()));
    } catch (error) {
      log(`local computer grant failed: ${error?.message ?? error}`);
    }
  };
  return Object.freeze({
    attach(proc, isCurrent) {
      target = proc;
      current = typeof isCurrent === "function" ? isCurrent : () => true;
      send();
    },
    changed: send,
  });
}
