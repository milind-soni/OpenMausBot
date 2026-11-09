# Replays

A replay is a page of one job a bot did: the request that started it, each step the bot took, the screenshots of its
recorded browser steps, and its answer. It is the work shown, not a video, so it opens anywhere and reads at a glance.
A small player steps through the screenshots (Play, or ← and →).

Open a bot's conversation, then **Share → Share replay** (also in the conversation's ⋯ menu). The dialog shows the
latest finished job; pick an earlier request from the list to replay that one instead. Look over every step, take
out any screenshot you don't want shown, and then:

- **Publish link** puts the replay on a MausBot page link (`server/pages`), the same as a page a bot publishes: a card
  with the link, Copy link and Unpublish appears in the conversation, and it counts towards your account's pages.
  Publishing the same job again updates the same link.
- **Download .html** saves it as one file with its screenshots inside it, to keep or send. This works without a
  MausBot sign-in, so on a self-hosted server too.

## What goes in

- The request: the person's message that started the job.
- Every step until the person's next message, in order:
  - browser steps the bot recorded, with what it did ("Clicked Sign up"), the page's address (its host and path, never
    its query or fragment) and title, whether it worked, and its screenshot;
  - each other tool's one-line description and summary (files, shell, MCP).
- The bot's last answer in that job.

Screenshots come only from the bot's recorded browser steps: turn on **Record browser steps** in the bot's settings
(Access). Without it, a replay still lists the steps, with no pictures. A screenshot shared by several steps shows once.

## What never goes in

Tool results, file contents, the person's other messages, attachments, typed text (masked when the step was
recorded), and the screenshots a step never took (for a minute after a one-time code, or while a secret field was in
use). Every text is redacted again (`redactSecretsInText`, `scrubHeldSecrets`) as the page is made, and all of it is
escaped: nothing the bot wrote runs on the page.

## Limits

A published page holds 5 MB and 200 files, so a replay keeps up to 150 screenshots within 4.5 MB: failed steps
first, then the first and last, then each new page, then the rest spread evenly. The others are left out, and the
dialog says how many. A replay lists at most 400 steps. Browser screenshots are kept for 30 days
(`server/browser-evidence.ts`), so an older job replays with fewer pictures.

Replays are for a bot's own conversations; a room's are not offered yet.

## API

All three are for the owner's own app (admin scope):

- `GET /api/threads/<id>/replay[?request=<message id>]`: the preview and the requests that can be replayed.
- `POST /api/threads/<id>/replay/publish` with `{ "request"?, "title"?, "leaveOut"?: [step numbers] }`: publishes it
  and answers with the page card.
- `GET /api/threads/<id>/replay.html?request=&title=&leaveOut=1,4`: the one-file download.
