// Android 11+ advertises paired wireless debugging transports as DNS-SD connect services.
export function isPhoneTransport(device, selectedSerial) {
  return device.connection === "usb" || (
    device.connection === "network" &&
    device.serial === selectedSerial &&
    /^adb-[A-Za-z0-9_-]+\._adb-tls-connect\._tcp\.?$/.test(device.serial)
  );
}
