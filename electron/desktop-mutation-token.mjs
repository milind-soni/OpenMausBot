export function postDesktopMutationToken(proc, token, companionToken, slog) {
  try {
    proc.postMessage({
      type: "openmausbot:desktop-mutation-token",
      token,
      companionToken,
    });
  } catch (error) {
    slog(`desktop mutation capability sync failed: ${error?.message ?? error}`);
  }
}
