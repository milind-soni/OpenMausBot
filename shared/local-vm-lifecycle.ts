/** The same resume boundary is used by the server and the renderer. */
export function canResumeLocalVm(status: {
  daemonUp: boolean;
  image: boolean;
  container: string;
  imageMatches: boolean;
  managed: boolean;
  network: string;
  security: string;
  persistence: string;
}): boolean {
  return status.daemonUp === true && status.image === true && status.container === "stopped"
    && status.imageMatches === true && status.managed === true && status.network === "loopback"
    && status.security === "hardened" && status.persistence === "durable";
}
