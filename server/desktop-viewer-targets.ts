import type { ContainerComputerStatus, LocalVmTarget } from "./container-computer.ts";
import type { RequestAuth } from "./request-auth.ts";
import { desktopViewerUrl, type DesktopTarget } from "./routes/desktop-viewer.ts";

export const viewerTargetId = (target: { key: string }) => `local/${target.key.replace(":", "-")}`;

/** Native owner windows keep the existing direct viewer and cookie isolation. */
export function localVmViewerStatus<T extends { target_key: string; viewer_url: string }>(status: T, auth: RequestAuth): T {
  return auth.kind === "loopback" ? status : {
    ...status,
    viewer_url: status.viewer_url ? desktopViewerUrl(viewerTargetId({ key: status.target_key })) : "",
  };
}

export function localDesktopTarget(target: LocalVmTarget, deps: {
  status: (target: LocalVmTarget) => Promise<ContainerComputerStatus>;
  touch: (target: LocalVmTarget) => void;
}): DesktopTarget {
  return {
    key: target.key,
    async resolve() {
      const status = await deps.status(target);
      if (!status.managed || !status.imageMatches || status.network !== "loopback" || status.container !== "running"
        || !status.viewer_url) {
        throw Object.assign(new Error("Local VM unavailable"), { status: 409 });
      }
      return {
        port: status.viewer_port ?? 0,
        password: new URLSearchParams(new URL(status.viewer_url).hash.slice(1)).get("password"),
        touch: () => deps.touch(target),
      };
    },
  };
}
