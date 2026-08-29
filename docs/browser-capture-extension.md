# Browser Capture Bridge

OpenMausBot includes an opt-in Chrome Manifest V3 extension at
`browser-extension/`. It is a local receipt bridge for approved signed-in
tabs, not a remote browser-control channel.

## Trust boundary

Version 0.5.0 has host access only for Google Messages, Plaud, Monarch,
YouTube, Mercury, ChatGPT, Claude, Grok, and Gemini. A tab is inert until the user approves that exact tab
from the extension popup. Every five minutes its service worker reads bounded
visible text from approved, still-open tabs and silently submits a local
receipt to OpenMausBot on `127.0.0.1`. The loopback endpoint validates the
receipt and stores it in OpenMausBot's private app-data directory; it cannot
invoke tools or commands. The extension does not send data to a remote network
service, read cookies, enter forms, click page
controls, or follow links. It strips URL query strings/fragments and redacts
common password, API-key, bearer-token, and one-time-code patterns before a
receipt is written. Editable controls and forms are removed from the cloned
page subtree before text extraction, reducing the risk of capturing unsent
drafts. YouTube is title-only and only watch pages are eligible. Changed pages
retain at most twelve events per source; unchanged pages overwrite a heartbeat
receipt so Capture can
distinguish a fresh quiet check from a dead extension.

AI platforms have a narrower capture contract than the other approved tabs:
only up to 50 visible sidebar/thread/notebook titles are written. Conversation
bodies, prompts, responses, attachments, editors, and drafts are excluded by
the extension and stripped again by the server.

## Install

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select the repository's `browser-extension` directory.
2. Pin **OpenMausBot Capture Bridge**. Sign in to Plaud, Monarch, Mercury,
   Google Messages, YouTube, ChatGPT, Claude, Grok, or Gemini in Chrome as usual. On each tab to include,
   open the extension and choose **Approve this tab**. Other matching tabs are
   not read.
3. Approval creates an immediate seed. Automatic checks then run every five
   minutes and submit silently to the running local OpenMausBot app. No browser
   downloads are created.

The Capture bot should declare the corresponding source (`plaud`, `monarch`,
`mercury`, `google-messages`, `youtube`, `ai-chatgpt`, `ai-claude`, `ai-grok`,
or `ai-gemini`) and pass its committed source cursor to
`capture_read_browser_receipts`. The tool is exposed only when Capture is
explicitly assigned to **This computer**. Store new evidence with
`capture_memory_upsert`, then record `ok`/`empty` and the returned cursor
through `capture_record_source`. A malformed receipt is rejected and cannot
advance a cursor. Each browser source keeps its own cursor.

The dedicated localhost route is data-only, checks the extension Origin and a
required non-simple request header, applies the server's schema/redaction rules,
and never dispatches agent work. Sensitive event receipts remain bounded instead
of accumulating indefinitely. If no seed
exists, or the latest heartbeat becomes older than 15 minutes, the source
fails closed instead of being reported as empty. OAuth and Chrome extension
installation remain human-visible setup steps.
