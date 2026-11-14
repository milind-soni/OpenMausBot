# Open a chat from outside the app

Open a chat row's **···** menu in the sidebar and choose **Copy link** (a bot
conversation, a room, or a channel). It copies an `openmausbot://` link that
opens that chat in the desktop app, so an external dashboard, a browser
bookmark, or a script can bring the person straight to the right conversation:

```text
openmausbot://thread/<thread-id>?bot=<bot-id>
```

A dashboard that only knows a bot (or a room) also has a link, which opens
its current conversation:

```text
openmausbot://bot/<bot-id>
```

## The link

- **`openmausbot://thread/<thread-id>?bot=<bot-id>`** — one exact chat. The
  `?bot=` part names who owns it (a bot id or a room id). It is optional when
  opening (a bare `openmausbot://thread/<thread-id>` resolves against the chats
  on this computer the same way a pasted in-app reference does), but **Copy
  link** always writes it, and the app checks it strictly: if the thread is not
  that bot's, nothing opens.
- **`openmausbot://bot/<bot-id>`** — the bot's current conversation, exactly
  as clicking the bot in the sidebar opens it: with threads hidden, its main
  thread, the conversation the person last wrote in. Handy for a team map
  whose Chat button only knows the bot's id. A room's id works here too.

## What opening one does

- Brings the window to the front. If it is showing a connected server (**Server**
  menu), it switches back to **Local** first — the chats live on this computer —
  and opens the link when that page is up.
- Opens the named chat and reveals its row in the sidebar. **Nothing else**: it
  never sends a message, interrupts a running turn, or starts a new
  conversation.
- Works at launch too: the link is held until the app has loaded its bots, so
  it can start a closed app and still find its chat. On macOS, where the app
  keeps running with its window closed, the link opens a new window.
- Works from any page — the team map, Routines, a room — and leaves it for
  the chat. Settings and the keyboard shortcuts list close so the chat is not
  hidden behind them; a dialog with unsaved input, such as New Bot, stays.
- Unknown or mismatched ids show a short notice in the chat instead of
  opening anything: "That bot is no longer here." for an unknown bot link;
  "That thread is no longer here." for an unknown thread, or, when the link
  names a bot that exists, "That thread is no longer here. Showing <bot>
  instead." — the window moves to that bot, the same way a dead in-app thread
  reference behaves.

Like the `openmausbot://cloud` and `openmausbot://organization` links, these are
local-shell actions: a page loaded from a remote server never receives them, and
the browser build has no such links at all. An app connected to another
computer as its companion (**Settings → Remote access → Connect to another
computer**) opens them against that computer's chats, the ones it shows.
