# Install the phone web app

The browser UI can be added to your phone's Home Screen. It opens in its own
window and uses the same workspace, conversations and pairing as the browser.

1. Open your workspace's **HTTPS web link** in Safari on iPhone or Chrome on
   Android. Use an existing hosted address, Tailscale HTTPS address or your own
   HTTPS reverse proxy. A phone cannot reach the computer through a localhost
   link. See [self-hosting](self-hosting.md) for remote access and pairing.
2. Pair the browser with that workspace using its normal pairing flow.
3. On iPhone, open Safari's **Share** menu, choose **Add to Home Screen**, keep
   **Open as Web App** enabled if Safari offers it, then tap **Add**. On Android,
   open Chrome's menu and choose **Install app** or **Add to Home screen**.
4. Open **OpenMausBot** from the Home Screen. If that browser keeps Home Screen
   apps in separate storage, pair this new window too. Installation does not
   grant access to a workspace by itself.

The installed start address is the workspace root; pairing codes and URL tokens
are not saved in the manifest. Use a new pairing invitation if access expires
or the device is revoked.

A plain `http://` link on your home network (such as `http://192.168.1.20:8799`)
works only while the phone is on the same Wi-Fi as the computer; the pairing
screen says so. To use it away from home, give the computer an HTTPS address
(Tailscale or your own proxy), or use the MausBot phone app, which can connect
**Anywhere** through an end-to-end encrypted relay (start the server with
`openmausbot serve --relay`).

Your server must be running and reachable. This web app does not add offline
chat, push notifications or native phone computer control.
