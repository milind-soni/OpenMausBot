// electron-updater 6.8.9 resolves the Mac download when its local HTTP response
// finishes, before Squirrel validates/extracts the ZIP. Wait for native ready
// instead, and never arm a future quit from a premature Restart request.
// Exact, single-site replacements deliberately fail closed on upstream changes.
export function patchMacUpdater(source) {
  function replace(before, after) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`Expected one Mac updater site to patch, found ${count}: ${before.slice(0, 80)}`);
    source = source.replace(before, after);
  }

  replace(
    '        return await new Promise((resolve, reject) => {\n          const pass =',
    `        this.squirrelDownloadedUpdate = false;
        return await new Promise((resolve, reject) => {
          const cleanup = () => {
            this.nativeUpdater.removeListener("error", fail);
            this.nativeUpdater.removeListener("update-downloaded", ready);
            this.server?.removeListener("error", fail);
          };
          const fail = (error) => { cleanup(); reject(error); };
          const ready = () => { cleanup(); resolve([]); };
          this.server.once("error", fail);
          const pass =`,
  );
  replace(
    `            let errorOccurred = false;
            response.on("finish", () => {
              if (!errorOccurred) {
                this.nativeUpdater.removeListener("error", reject);
                resolve([]);
              }
            });
`,
    "",
  );
  replace(
    `              errorOccurred = true;
              this.nativeUpdater.removeListener("error", reject);
              reject(new Error(\`Cannot pipe "\${downloadedFile}": \${error}\`));`,
    '              fail(new Error(`Cannot pipe "${downloadedFile}": ${error}`));',
  );
  replace(
    `            this.nativeUpdater.setFeedURL({
              url: getServerUrl(this.server),
              headers: {
                "Cache-Control": "no-cache",
                Authorization: \`Basic \${authInfo.toString("base64")}\`
              }
            });
            this.dispatchUpdateDownloaded(event);
            if (this.autoInstallOnAppQuit) {
              this.nativeUpdater.once("error", reject);
              this.nativeUpdater.checkForUpdates();
            } else {
              resolve([]);
            }`,
    `            try {
              this.nativeUpdater.setFeedURL({
                url: getServerUrl(this.server),
                headers: {
                  "Cache-Control": "no-cache",
                  Authorization: \`Basic \${authInfo.toString("base64")}\`
                }
              });
              this.dispatchUpdateDownloaded(event);
              if (this.autoInstallOnAppQuit) {
                this.nativeUpdater.once("error", fail);
                this.nativeUpdater.once("update-downloaded", ready);
                this.nativeUpdater.checkForUpdates();
              } else {
                ready();
              }
            } catch (error) {
              fail(error);
            }`,
  );
  replace(
    `          this.nativeUpdater.on("update-downloaded", () => this.handleUpdateDownloaded());
          if (!this.autoInstallOnAppQuit) {
            this.nativeUpdater.checkForUpdates();
          }`,
    '          throw new Error("The native Mac update is not ready to install.");',
  );
  return source;
}
