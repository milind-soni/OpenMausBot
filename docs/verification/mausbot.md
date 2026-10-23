# MausBot, everyone's helper

MausBot is the bot every place and every Team Cloud member gets once: a new
install's first bot and its Chief of Staff, or, for an install that already has
bots, a helper beside them. It is never deleted or archived; the person takes it
off the sidebar with "Show MausBot in the sidebar" in Settings → General, which
its menu's **Hide from sidebar** also turns off.

## Automated checks

```sh
pnpm exec vitest run server/default-bot.test.ts server/default-bot.e2e.test.ts \
  server/team-setup-requests.test.ts src/lib/default-bot.test.ts src/components/MausBotWelcome.test.ts \
  src/lib/mausbot-landing.test.ts
```

- `server/default-bot.test.ts`: a fresh install gets one MausBot once; an
  existing install gets one once on update and its Chief is untouched; a new
  install's renamed MausBot is adopted, not duplicated; the intro shows once,
  not after it was answered or dismissed; delete and archive are refused; a
  move to My Cloud and coming home leave exactly one; each Team Cloud member
  gets their own; a Team User's MausBot holds no Chief tools.
- `server/default-bot.e2e.test.ts`: on a real fixture server, `DELETE
  /api/bots/:id` answers 409, the switch hides and shows it, and a MausBot that
  is not the Chief creates a bot with `create_bot`.
- `server/team-setup-requests.test.ts` ("MausBot's Chief-level team setup"):
  it adds specialists like a Chief but never changes who the Chief is.
- `src/components/MausBotWelcome.test.ts` and `src/lib/default-bot.test.ts`:
  the first-launch welcome shows once with its panel closed, Add pins it and Not
  now turns the switch off, a name, colour, look or uploaded picture is saved as
  the bot's own edit screen saves it, a renamed MausBot is still found by its
  mark, and a new install's intro offers only the setup still to do.
- `src/lib/mausbot-landing.test.ts`: the rows already in the sidebar glide down
  by the new row's height, the avatar lands in the new slot and leaves nothing
  behind, reduced motion only fades the row in, and a hidden sidebar just adds it.
- `server/default-bot.test.ts` also: a place with no Chief gets MausBot as its
  Chief and the daily brief comes from it (hidden from the sidebar or not); a
  place with a Chief keeps it.

## By hand

Launch the app against an isolated fixture (`docs/verification/README.md`),
finish the first-run welcome and its tour, then:

1. The **Meet MausBot** popup appears once, with MausBot out of the sidebar
   while it is open. Its picture opens the customise panel (name first, then
   colour, look, **Upload a picture · Generate a picture with AI**); the title
   and the Add button follow the name. **Add** makes the sidebar rows glide down
   while the avatar travels into the new top slot and the row fades in; with
   reduced motion it only fades in. Reopen the app: it does not appear again.
2. MausBot's first message says what it does in the app's language, with
   example asks and, on a new install, only the setup steps still to do. Each
   step opens the app's own flow.
3. Its sidebar menu offers **Hide from sidebar**, not Archive or Delete; the
   switch in Settings → General brings it back.

Evidence: [popup, light](evidence/mausbot/welcome-light.png),
[popup, dark](evidence/mausbot/welcome-dark.png),
[customise panel](evidence/mausbot/welcome-customize-light.png),
[uploaded picture](evidence/mausbot/welcome-upload-light.png),
[the fly-in](evidence/mausbot/fly-in.gif), [slowed](evidence/mausbot/fly-in-slow.gif),
[compact, icon rail and reduced motion](evidence/mausbot/fly-in-compact-rail-reduced.png),
[intro and setup](evidence/mausbot/added-light.png),
[menu](evidence/mausbot/menu-light.png),
[Settings, switched off](evidence/mausbot/settings-off.png),
[chrome picture, light](evidence/mausbot/chrome-picture-daylight.png),
[chrome picture, dark](evidence/mausbot/chrome-picture-midnight.png).
