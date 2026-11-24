# Open one computer's bots from another computer

A desktop app can share itself with your other computers over Tailscale. The computer that has the bots is the
**host**. The computer you sit at is the **client**: it opens the host's bots in its own window, from **Connect to a
server**. The bots, their conversations, keys and routines stay on the host.

Any desktop build can be the host or the client: Windows, macOS or Ubuntu. Both computers need Tailscale, signed in to
the same Tailscale account, with MagicDNS on. Nothing here is reachable from outside your Tailscale network.

A phone uses a different path: **Settings → Devices → Phones and tablets → Add a phone**. A phone's code has six digits and only
the phone app can use it. The link a phone pairing creates is phone-only too: a desktop client that refuses it is
behaving as expected. A computer needs the link below.

## Share the host

1. On the host, open **Settings → Devices**. Settings search finds the row too: type "other computers" or
   "tailscale".
2. On the **Private network** row under **You're here**, choose **Set up Tailscale** (or **Allow my other computers**),
   then keep its switch, **Your other computers**, on. This turns Tailscale on in the app first, if it is off, and turning the share off
   turns it off again unless you turned Tailscale on yourself or a phone is paired. The app never installs, starts or
   signs in Tailscale itself: if Tailscale is not installed, not running, signed out or waiting for approval on your
   Tailscale network, the row says so.
3. Wait for the row to say **On**: the host answers at `https://<name>.ts.net` when Tailscale's HTTPS Certificates are
   on, or at `http://<name>.ts.net:8799` when they are off. Both are private to your Tailscale network.
4. Choose **Add a computer** in **Computers**. Its last step shows **Copy link** and a 12-character code. The code works
   once, and the step says until when.

The private network row in **You're here** on the same page is where Tailscale is set up; while it is on, phones reach
this computer over it too, and **Turn off for phones** turns it off once the share is off.

## Connect the client

1. On the client, choose **＋** at the end of the rail, then **Connect to another computer**.
2. Paste the link. Or type the address and the code in their two boxes.
3. The sheet names the host it found and says it is on Tailscale. Choose **Connect to** and the host's name.

The host now sits on the client's rail beside This computer. To end a connection from the host's side, remove that
device under **Computers** on the host's Devices page. Turning **Your other computers** off stops the host
answering every other computer at once.

## Keep the host reachable

The host must be on, awake and connected to Tailscale. **Keep this computer awake** on the host's Devices page
holds it awake while a way in is on, and that includes **Your other computers**.

## What the client says when it can't connect

| It says | Do this |
|---|---|
| "…is a MausBot desktop app. To open it from here, turn on Tailscale and Your other computers…" | The address reached the host's phone link or an app that is not shared. Share the host as above and use its link. |
| "That code is for the phone app…" | A six-digit code was typed. Use **Pair a computer** on the host. |
| "Tailscale isn't connected on this computer." | Open Tailscale on the client and sign in. |
| "…isn't on this computer's tailnet." | The two computers are signed in to different Tailscale accounts. |
| "…is on your tailnet but didn't answer." | The host is asleep, offline, or **Your other computers** is off. |
| "macOS blocked the connection…" | On the client, allow the app in System Settings → Privacy & Security → Local Network. |

## Security

- The share is off until you turn it on, and an organization's policy that turns remote access off disables it.
- With HTTPS Certificates on, `tailscale serve` fronts the host's server on port 443 of its `.ts.net` name. With them
  off, the server listens on the host's own Tailscale addresses on port 8799. It never listens on every interface, so
  a device on the same Wi-Fi that is not on your Tailscale network gets no answer.
- A request that names another host is refused, and so is one that names the loopback address from outside.
- Being on the Tailscale network is not enough: every client pairs with a one-time code and gets its own session,
  which the host lists and can sign out.

[docs/verification/tailscale.md](verification/tailscale.md) has the script that proves this on two real computers.

## Without Tailscale

Share the computer with **My Cloud** from its own app, and open My Cloud from the other computer. A server of
your own (`openmausbot serve`) is the other choice: see [self-hosting](self-hosting.md).

## The earlier desktop companion connection

Older versions paired one desktop app to another with a six-digit code and a managed `https://c-….` address, and the
client restarted into a client mode. No new connection of that kind can be made. Desktop Companion mode is marked in
the app for sunset on December 7, and the log line `the secure address ended (retired)` is that shutdown being
reported, not a failure. An installation still connected that
way sees a notice in **Settings → This app** (Advanced mode) with **Disconnect and use this computer**; after disconnecting, connect again
with the steps above.
