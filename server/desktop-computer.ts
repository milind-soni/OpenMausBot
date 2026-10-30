// "This computer" is the desktop app's own computer, and only the server the app launched may drive it. The app proves
// that by handing the driver connection to that one child over Electron's private utility-process port, which only the
// app's main process can write to and which plain Node never has. No file, environment variable or HTTP route supplies
// it, so a second OpenMausBot server on the same computer (a copy run from source, a demo, a test) never finds this
// computer, even with the app's own record of its driver in reach. A Mac shared with My Cloud goes through lending, not here.
import { THIS_COMPUTER_NOT_READY } from "../shared/your-computer.ts";
import { cuaUnavailableReason, decodeCuaConnection, type LocalComputerConnection } from "./local-computer.ts";

export const DESKTOP_COMPUTER_GRANT = "openmausbot:local-computer";

export interface DesktopComputer {
  /** Only ever called with a message from the parent port; true when it was this grant. */
  receive(message: unknown): boolean;
  connection(): LocalComputerConnection | null;
  /** Whether the desktop app has spoken: false on any server it did not launch. */
  granted(): boolean;
  unavailableReason(): string | null;
}

export function createDesktopComputer({
  platform = process.platform,
  decode = decodeCuaConnection,
}: {
  platform?: NodeJS.Platform;
  decode?: typeof decodeCuaConnection;
} = {}): DesktopComputer {
  let record: unknown = null;
  let heard = false;
  return {
    receive(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return false;
      const grant = message as Record<string, unknown>;
      if (grant.type !== DESKTOP_COMPUTER_GRANT) return false;
      const connection = grant.connection;
      if (connection !== null && (typeof connection !== "object" || Array.isArray(connection))) {
        throw new Error("invalid local computer grant");
      }
      record = connection;
      heard = true;
      return true;
    },
    // Decoded on every use: a Linux driver is checked again (same binary, live processes) each time, as the file was.
    connection: () => (record ? decode(record, { platform }) : null),
    granted: () => heard,
    unavailableReason: () => (record ? cuaUnavailableReason(record, platform) : null),
  };
}

/** The one this server hears from, if it was launched by the desktop app. */
export const desktopComputer = createDesktopComputer();

/** Why a turn cannot use this computer, in words for the person and the bot alike. */
export function thisComputerNotReady(desktop: DesktopComputer = desktopComputer, platform: NodeJS.Platform = process.platform): string {
  if (!desktop.granted()) {
    return "Only the OpenMausBot app on this computer can let a bot use it. Open the app here, or let the bot work in its own browser or on a cloud desktop instead.";
  }
  const reason = desktop.unavailableReason();
  if (!reason) return `${THIS_COMPUTER_NOT_READY}make sure OpenMausBot has the permissions it asks for, then restart it`;
  const permission = platform === "darwin" && /(?:Screen Recording|Accessibility).*required/i.test(reason);
  return `${THIS_COMPUTER_NOT_READY}${reason}${permission ? ". Relaunch OpenMausBot after granting the missing macOS permission." : ""}`;
}
