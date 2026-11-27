# Sharing a bot or a department as a template

A template is a folder (`bot.md` or `team.md`, `skills/<name>/SKILL.md`, `avatars/<key>.<ext>`) that holds no chats,
memory, keys or connection addresses. A bot makes one of itself when asked in chat (the header Share sends the ask); a
department's "…" → Share makes one at once. Publish sends it to the community repository through the MausBot Admin;
without a MausBot sign-in the card offers Save folder… and GitHub's upload page instead. Import (+ → Import…) adds one
from a GitHub link or a folder.

Before anything leaves the computer, every text in a template loses home folders (`~`), the app's workspace folders
(`<workspace>`), email addresses, phone numbers and the publisher's own names (`shared/publish-scrub.ts`); the card says
how many in one line, and a template with a key or token in it is never published. Publish has one optional field,
Published by, which becomes the template's `author.name` ("Community" when empty) and shows on the card and in the
Templates gallery.

## Automated checks

```sh
pnpm exec vitest run shared/publish-scrub.test.ts shared/share-folder.test.ts shared/skill-files.test.ts server/share.test.ts server/share-github.test.ts server/share-skill-files.test.ts server/share-team-templates.test.ts src/components/TemplateCard.test.ts src/components/ImportDialog.test.ts src/lib/template-share.test.ts
pnpm exec vitest run server/share.e2e.test.ts server/cloud-team-templates.e2e.test.ts --silent=false
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-share-ui.e2e.test.ts scripts/testing/team-template-ui.e2e.test.ts --maxWorkers=1
```

`server/share.e2e.test.ts` launches an isolated fixture. Its fake engine calls the `share` tool when the bot is asked to
share itself; the test checks the card in the chat, saves the folder, finds no key, memory, chat line or connection
address in it, adds it back as an equivalent bot with its routine paused and skill off, refuses a chat import whose path
the person didn't write, and round-trips a department with its group chat, brief and Chief.

`server/cloud-team-templates.e2e.test.ts` launches a Team Cloud with an owner, an admin and a member: a bot with a skill
and its script is shared into `team-files/templates/<slug>/`, added again (the old one kept as `<slug>.previous/`),
listed, imported as a new bot whose skill brings the script, and removed, each refused to the member, over HTTP and
through the share tool in a chat. `server/share-team-templates.test.ts` covers a private GitHub link and publishing to
a person's own repository against a fake GitHub behind a fake connected-apps relay (`server/testing/fake-composio-github.ts`):
no network is reached.

## By hand in a fixture

```sh
node --experimental-strip-types scripts/control-omb.ts launch
```

1. Create a bot, give it a skill and a routine, then send it: "Create a public template of yourself that I can share with somebody else".
2. Expected with a Claude engine: the bot calls `share` with action export, and one card appears with Draft, the counts and
   "Chats, memory and keys are never shared". Details lists Instructions, Skills, Routines, Apps.
3. On a server not signed in to MausBot the card shows "Sign in to MausBot to publish" (desktop) or "Publishing isn't
   available here" (self-hosted), with Save folder… and Upload on GitHub.
4. `POST /api/share/import` with `{ "path": "<saved folder>" }` adds a new bot; its routine is off and nothing private came along.
