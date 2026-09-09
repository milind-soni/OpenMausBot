// `handOffInstall` swaps the terminal step: instead of quitting and letting
// electron-updater run the installer, the downloaded file is handed to the
// user. Ubuntu system packages use it — see electron/updater.mjs for why a
// chat app must not run dpkg itself. Everything before the install is shared.
// It receives the staged paths and resolves with an optional state patch
// describing what is left to do, which the card renders.
export function createUpdaterCoordinator(updater, setState, { handOffInstall = null, nativeStaging = false } = {}) {
  let checkOperation = null;
  // Set from downloadUpdate's resolution: the paths electron-updater staged.
  // Only the hand-off needs them; quitAndInstall reads its own copy.
  let downloadedFiles = null;
  let downloadOperation = null;
  let installOperation = null;
  let nativeStagingStarted = false;
  let nativeReady = false;
  // Squirrel has no cancellation or attempt ID. After a staging failure a
  // second attempt could consume the first attempt's late ready event.
  let recoveryRequired = false;
  // A staged update, install hand-off, or failed user action remains useful
  // until the user acts again. Hourly checks must not replace its controls.
  let actionOwnsState = false;
  const routedErrors = new WeakSet();

  const routeError = (manual, error) => {
    if (recoveryRequired) return;
    actionOwnsState = manual;
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) {
      downloadOperation.failed = true;
      clearTimeout(downloadOperation.timer);
    }
    if (checkOperation) checkOperation.failed = true;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation = null;
    }
    if (nativeStagingStarted) {
      recoveryRequired = true;
      nativeReady = false;
      setState({
        status: "error",
        retryable: false,
        message: `${String(error?.message ?? error)} Quit and reopen OpenMausBot before trying the update again.`,
      });
      return;
    }
    if (!manual) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message: String(error?.message ?? error) });
  };

  function handleRejectedOperation(manual, error) {
    if (error instanceof Error && routedErrors.has(error)) return;
    routeError(manual, error);
  }

  function checkOwnsState() {
    return !recoveryRequired && !actionOwnsState && !installOperation && !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      setState({ status: "available", version: info?.version, message: undefined });
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) setState({ status: "idle" });
  });
  // downloadUpdate/checkForUpdates reject after most updater errors, but the
  // macOS native staging pass used by quitAndInstall is event-only. Without
  // this listener a Squirrel.Mac failure leaves the renderer on "Restarting"
  // forever because quitAndInstall itself returns void.
  updater.on("error", (error) => {
    // Shared error events do not identify their operation. If a download
    // overtook a check, let their individual promises route failures instead.
    if (checkOperation?.supersededByDownload && !installOperation) return;
    const manual = Boolean(installOperation || downloadOperation || checkOperation?.manual || nativeStagingStarted);
    routeError(manual, error);
  });
  updater.on("download-progress", (progress) => {
    if (recoveryRequired || installOperation || nativeStagingStarted) return;
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) });
  });
  updater.on("update-downloaded", (info) => {
    if (recoveryRequired || installOperation) return;
    // On macOS electron-updater emits this before Squirrel.Mac has finished
    // staging the ZIP. Our vendor patch resolves downloadUpdate only on the
    // native ready event, not merely when the local ZIP transfer finishes.
    if (downloadOperation) {
      downloadOperation.downloadedInfo = info;
      if (nativeStaging && !nativeStagingStarted) {
        nativeStagingStarted = true;
        setState({ status: "preparing", version: info?.version, message: undefined });
        downloadOperation.timer = setTimeout(() => {
          updater.logger?.warn?.("Native update preparation exceeded the five-minute deadline; restart is required before retrying.");
          routeError(true, new Error("Preparing the update took too long."));
        }, 5 * 60 * 1000);
        downloadOperation.timer.unref?.();
      }
      return;
    }
    // No native attempt may become actionable from an uncorrelated late event.
    if (nativeStaging) return;
    actionOwnsState = true;
    setState({ status: "downloaded", version: info?.version });
  });

  function check(manual = false) {
    if (recoveryRequired || installOperation || (nativeStaging && (downloadOperation || nativeStagingStarted)) || (!manual && actionOwnsState)) return Promise.resolve();
    if (checkOperation) {
      // A manual caller upgrades the shared operation; a timer never downgrades it.
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    if (manual) actionOwnsState = false;
    const operation = { manual, supersededByDownload: Boolean(downloadOperation), failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function download() {
    if (recoveryRequired || installOperation || nativeStagingStarted) return Promise.resolve();
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    const operation = { downloadedInfo: null, failed: false, promise: null, timer: null };
    downloadOperation = operation;
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    // — the UI reads a missing percent as "starting".
    setState({ status: "downloading" });
    try {
      operation.promise = Promise.resolve(updater.downloadUpdate())
        .then((result) => {
          if (!operation.failed) {
            downloadedFiles = Array.isArray(result) ? result.filter((file) => typeof file === "string") : null;
          }
          if (!operation.failed && operation.downloadedInfo) {
            nativeReady = nativeStaging;
            actionOwnsState = true;
            setState({ status: "downloaded", version: operation.downloadedInfo?.version });
          }
          return result;
        })
        .catch((error) => handleRejectedOperation(true, error))
        .finally(() => {
          clearTimeout(operation.timer);
          if (downloadOperation === operation) downloadOperation = null;
        });
    } catch (error) {
      handleRejectedOperation(true, error);
      downloadOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function install() {
    if (recoveryRequired || installOperation || downloadOperation || (nativeStaging && !nativeReady)) return;
    actionOwnsState = true;
    if (handOffInstall) {
      handOff();
      return;
    }
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    try {
      updater.quitAndInstall(true, true);
    } catch (error) {
      routeError(true, error);
      return;
    }
    // quitAndInstall is void and cannot be canceled. A slow handoff must stay
    // busy: exposing Retry here used to arm another native quit callback.
    if (installOperation === operation) {
      operation.timer = setTimeout(() => {
        if (installOperation !== operation) return;
        updater.logger?.warn?.("Update restart handoff exceeded two minutes; keeping installation locked to prevent overlapping retries.");
        setState({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update." });
      }, 2 * 60 * 1000);
      operation.timer.unref?.();
    }
  }

  // The platform owns the install from here: a terminal opens with the
  // command on the clipboard and the user finishes there. No quit — the
  // running app stays usable, and the new version is picked up next launch.
  function handOff() {
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    Promise.resolve()
      .then(() => handOffInstall(downloadedFiles))
      .then((patch) => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "handed-off", ...patch });
      })
      .catch((error) => {
        if (installOperation !== operation) return;
        routeError(true, error);
      });
  }

  return { check, download, install };
}
