export function installDeviceLocationIpc({ ipcMain, canLocate, currentLocation }) {
  ipcMain.handle("location:current", async event => {
    const unavailable = "Location is only available in the active Mac workspace";
    if (!canLocate(event)) throw new Error(unavailable);
    const location = await currentLocation();
    if (!canLocate(event)) throw new Error(unavailable);
    return location;
  });
}
