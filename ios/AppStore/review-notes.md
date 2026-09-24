# App Review notes

OpenMausMobile is a companion for the OpenMausBot desktop application. The
primary same-network flow does not require an account. The desktop also offers
an optional passwordless email sign-in that provisions a private HTTPS address
for reaching that same computer from another network; the iOS app itself does
not present a login screen.

To review the primary flow:

1. Install and start OpenMausBot on a Mac, Windows, or Linux computer.
2. Open **Settings → Phone**, enable Companion, and choose **Start pairing**.
3. On the iPhone, choose **Scan QR Code**, scan the code shown by the desktop,
   review the computer and address, and confirm pairing.
4. If the camera is unavailable, select the discovered computer or enter the
   address and six-digit code shown by the desktop panel.
5. Create a bot on the desktop or with the `+` button in the iPhone roster,
   then send a message.
6. In Safari, Notes, Photos, or Files, open the system Share sheet and choose
   **OpenMausBot**. The extension shows the paired computer and asks for a bot
   or room before sending the selected link, text, image, or document. The
   containing app does not need to be open, but the paired computer must remain
   awake with OpenMausBot running.

To review optional cross-network HTTPS access, enter an email in **Settings →
Phone → Use your phone anywhere** on the desktop, enter the eight-digit
email code, enable Companion, and scan a newly generated QR code. The hosted
service authenticates and provisions the desktop; the phone still pairs to that
specific computer and receives no universal OpenMausBot account credential.
The reviewer may use any email inbox they control. This optional path uses an
OpenMausBot-managed Cloudflare Tunnel and does not require Tailscale.

Optional cloud-desktop review requires a boat.dev Box configured on the
computer. For the paired phone, enable **Cloud desktop** under **Settings →
Phone**, open a bot configured for **Cloud box**, choose its computer
preview on iPhone, and confirm **Open live cloud desktop**. The app requests a
fresh HTTPS viewer session and does not use or store the provider API key.

For the direct remote alternative, both devices may be signed into the same
Tailscale network and the reviewer may enter the computer's `.ts.net` MagicDNS
name. No purchase or subscription is required. The computer is the source of
bot data and credentials, so a universal demo account cannot safely expose a
shared computer to reviewers.
