import capabilitiesModule from './capabilities.cjs';

const { desktopCapabilities } = capabilitiesModule;

export function createCapabilityPublisher(options) {
  const build = async remote => desktopCapabilities({ ...options.facts(), remote, localConnection: await options.connection() });
  options.ipcMain.handle('desktop:capabilities', event => build(!options.isLocalSender(event)));
  return async () => {
    const local = await build(false);
    options.rail(local);
    let remote;
    for (const window of options.windows()) {
      if (window.isDestroyed()) continue;
      let isLocal = false;
      try { isLocal = new URL(window.webContents.getURL()).origin === options.origin(); } catch {}
      if (!isLocal) remote ??= await build(true);
      window.webContents.send('desktop:capabilities-changed', isLocal ? local : remote);
    }
  };
}
