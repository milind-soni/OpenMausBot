# App Review notes

OpenMausMobile is a companion for the OpenMausBot desktop application and does not use a developer-hosted login.

To review the app:

1. Install and start OpenMausBot on a Mac, Windows, or Linux computer.
2. Open **Settings → Companion**, enable the companion, and choose **Start pairing**.
3. On the iPhone, choose **Scan QR Code**, scan the code shown by the desktop,
   review the computer and address, and confirm pairing.
4. If the camera is unavailable, select the discovered computer or enter the
   address and six-digit code shown by the desktop panel.
5. Create a bot on the desktop or with the `+` button in the iPhone roster, then send a message.

Optional cloud-desktop review requires an ascii.dev Box configured on the Mac.
For the paired phone, enable **Cloud desktop** under **Settings → Companion**,
open a bot configured for **Cloud box**, choose its computer preview on iPhone,
and confirm **Open live cloud desktop**. The app requests a fresh HTTPS viewer
session and does not use or store the provider API key.

The phone and computer must be on the same trusted network. Alternatively, both may be signed into the same Tailscale network and the reviewer may enter the computer's `.ts.net` MagicDNS name.

No purchase or subscription is required. The computer is the source of bot data and credentials; the developer cannot provide a universal demo account without routing reviewers into someone else's private computer.
