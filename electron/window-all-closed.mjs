// The last-window-closed quit policy, kept Electron-free so the startup gate
// stays unit-testable with plain object fakes.
//
// The startup screen owns a real BrowserWindow before the main window
// exists, and its recovery timers destroy that splash when the loading
// renderer stalls — by design, so boot is not held hostage by it (see
// "recover from a stalled loading window"). But the destroy leaves the app
// with zero windows mid-boot, and an unconditional last-window-closed quit
// fires before boot can deliver the main window or the error page: the
// process exits ~10s after launch, before the server child is even forked
// and before any window ever showed (issue #2028). During startup an empty
// window set only means "boot is still working on it"; once startup has
// settled it means there is nothing left for the user.
export function createAllWindowsClosedQuit({ app, platform = process.platform, allWindows }) {
  let startupSettled = false;
  const maybeQuit = () => {
    if (platform === "darwin" || !startupSettled) return;
    if (allWindows().length > 0) return;
    app.quit();
  };
  app.on("window-all-closed", maybeQuit);
  return {
    // Boot settled — success or failure. The draining close may already have
    // fired while the gate was open, and window-all-closed does not repeat
    // for an already-empty set, so the drained check runs once here too.
    settleStartup: () => {
      startupSettled = true;
      maybeQuit();
    },
  };
}
