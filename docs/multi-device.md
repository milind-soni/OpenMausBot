# Using OpenMausBot on more than one device

This page is for a person with two or more computers, or a computer and a phone, who wants the same bots everywhere.
It says what each device keeps, what does and does not travel between them, the ways to use one set of bots from every
device, and what to check when a device looks empty.

## What each device keeps

The desktop app runs a full OpenMausBot on the computer it is installed on. Until you choose another home (below), that
computer is the bots' **home**: their conversations, memory, skills, routines, connected apps and keys are stored
there, and its routines run there.

Signing in to the same account on a second computer (**Settings → MausBot Cloud**) does not copy one computer's home
to the other by itself. Unless both computers open the same home (below), each has its own: a new computer can show an
empty Inbox, and a bot created on one computer does not appear in the other's list. Engine sign-ins (Claude, Codex and
the rest) are separate too, because they belong to the machine the bots run on.

Bots work together only within one home: a bot on one computer cannot reach a teammate on another.

## One set of bots on every device

Pick one home, then open it from your other devices. There are three ways:

| Home | Good for | How |
| --- | --- | --- |
| **My Cloud** (Starter, Pro or Max plan) | Bots that keep running when your computers are off | Sign in at **Settings → MausBot Cloud**. Once My Cloud is ready, the desktop app moves this computer's bots there by itself, once, and opens My Cloud from then on. On your other computers, sign in to the same account and choose **Open My Cloud**. See [cloud-pro.md](cloud-pro.md). |
| **Your own server** | A VPS or always-on machine you run yourself | Pair each device with it, then right-click the server's circle at the window's left edge and choose **Make <server> my home** to move this computer's bots there. See [self-hosting.md](self-hosting.md). |
| **One of your computers** | Two desktops on the same Tailscale network, no Cloud | On the computer with the bots, turn on **Settings → Devices → Private network → Your other computers** and choose **Add a computer**; on the other, choose **＋ → Connect to another computer**. The bots stay on the first computer, which must be on. See [desktop-companion.md](desktop-companion.md). |

A phone is paired separately. For My Cloud, use **Settings → MausBot Cloud → Use My Cloud on your phone**; for this
computer, **Settings → Devices → Phones and tablets → Add a phone** (a six-digit code). The phone opens the home it paired
with. See [ios-companion.md](ios-companion.md).

After a move to My Cloud or your own server, the computer you moved from stops running its copy, so no routine runs
twice. The computer still lends the new home its folders, screen and Chrome while the desktop app runs and is signed in.
On your own server this happens by itself only when you are its one owner; on a server with other members or admins,
lending also needs `features.sharedComputers` set to `true` (see [feature-flags.md](feature-flags.md)).
With two or more computers lent to My Cloud, its bots take the computer you are typing on as "my computer": the one
whose desktop app sent the message. The lending icon's menu on each computer says so while My Cloud can use it.

## Moving bots by hand

To copy one computer's bots to another home without a move, export a backup on the old one with **Settings → Import &
export → Export backup** and import it on the new one with **Import backup**. Importing replaces the bots and chats
already on the new home: they move to a safety copy under `.backups/` in its data folder, so export the new home's own
backup first if you still need what is on it. API keys, engine sign-ins and paired
devices stay where they are on both sides, and routines arrive paused: sign in to your AI on the new home and turn the
routines you want back on.

## When a device looks wrong

| What you see | Why, and what to do |
| --- | --- |
| A computer you just signed in on has an empty Inbox and no bots | It has its own home. Open the home that has your bots (My Cloud, your server, or the other computer), or move the bots as above. |
| A bot made on one computer is missing on another | Each home has its own bots. Use one home for both computers. |
| A bot says it can't reach a teammate | The teammate lives in another home. Bring both homes together with one of the ways above. |
| Bots came over in a backup but can't answer | Engine sign-ins and API keys stay out of a backup. Sign in to your AI again on the new home. |
| Routines did not run after a backup import | Imported routines arrive paused. Turn them back on. |
| The second computer can't connect to the first | Check the troubleshooting table in [desktop-companion.md](desktop-companion.md). |
