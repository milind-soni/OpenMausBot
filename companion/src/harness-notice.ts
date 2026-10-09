// What the companion tells the harness on its own, rather than relaying for a
// phone. The harness has no idea devices exist: a phone's requests reach it
// as this computer's own. So when a phone is unpaired, only the companion
// knows, and a Live call that phone holds would otherwise keep running until
// it went quiet. This notice closes that gap.
//
// It travels the relay's own authenticated path — loopback, the companion
// marker, the device id and, under the desktop app, the private relay token —
// to the one route the harness keeps for the companion alone
// (routes.ts COMPANION_NOTICES). Best effort: a harness that is not running
// has no call to end.
import { request as httpRequest } from "node:http";

import { companionIdentityHeaders } from "./proxy.ts";

const DEVICE_ID = /^[\w-]{1,128}$/;
const NOTICE_TIMEOUT_MS = 4_000;

export interface DeviceRevokedNotice {
  /** Where the harness listens on loopback. */
  harnessPort: number;
  /** The registry id of the phone that was just unpaired. */
  deviceId: string;
  /** The desktop app's private relay token; absent for a standalone harness. */
  mutationToken?: string;
  timeoutMs?: number;
}

/** Tell the harness a phone was unpaired. True when it took the notice. */
export function notifyDeviceRevoked(notice: DeviceRevokedNotice): Promise<boolean> {
  return new Promise((resolve) => {
    if (!DEVICE_ID.test(notice.deviceId)) {
      resolve(false);
      return;
    }
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: notice.harnessPort,
        path: "/api/live/device-revoked",
        method: "POST",
        headers: { ...companionIdentityHeaders(notice.deviceId, notice.mutationToken), "content-length": "0" },
        timeout: notice.timeoutMs ?? NOTICE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 500;
        resolve(status >= 200 && status < 300);
      },
    );
    request.on("timeout", () => request.destroy(new Error("the harness did not answer")));
    request.on("error", () => resolve(false));
    request.end();
  });
}
