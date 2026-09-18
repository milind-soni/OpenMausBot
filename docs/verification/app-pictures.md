# Pictures of Astra itself

`docs/screenshots/` holds the app's product shots. They were taken by hand on a
live workspace, which is what a README wants and what evidence cannot use:
nobody can re-run them, and they contain whatever that workspace happened to
hold. This recipe photographs the app on the standard isolated fixture instead —
the shipped `<App/>` (`scripts/testing/threads-preview.tsx`), a disposable home,
the repository's fake engine, and a conversation this run created through the
shared control core.

## Run

```sh
node --experimental-strip-types scripts/capture-astra-ui.ts
```

The recipe:

1. launches the fixture (`launchVerificationServer` in `scripts/control-astra.ts`)
   with `FAKE_CLAUDE_REPLIES` set, so the engine answers with a reply written
   into the recipe (`server/testing/fake-claude-cli.ts`);
2. creates three agents — Scout, Ledger, Astra — through `new-bot`;
3. sends one turn to Astra with `send` and waits for it to settle with `wait`;
4. mounts the real `<App/>` over a Vite preview (`scripts/testing/preview-fixture.ts`)
   at `/__threads.html` — the entry and route `pnpm control:omb ui launch`
   serves for the same page;
5. drives the machine's own Chrome over CDP (`scripts/testing/chrome-capture.ts`,
   through Node's built-in WebSocket, so no dependency is added) and photographs
   the app in the default skin, then again under Atelier.

Set `ASTRA_CAPTURE_CHROME` to a Chromium binary to override the browser the
recipe finds. Pictures and a `findings.json` land in
`docs/verification/evidence/astra-app/`.

## What the pictures show

`astra-app-dark.png` and `astra-app-light.png` are the whole app at 1280×900,
2× — sidebar, transcript, composer and window header — with the answer rendered
as markdown: bold, bullets, italics and an inline code span.

Expected: the sidebar lists the fixture's own seeded bot plus the three this run
created, with Astra open. The app opens the newest bot, which is why the
conversation agent is created last; that is also the order a real sidebar shows
(newest first). The transcript holds Astra's greeting, the question, the reply,
and a token count in the header.

## What this proves, and what it does not

Proven: the shipped `<App/>` renders a real conversation — fetched from the
fixture's HTTP API and produced by a real turn — with its sidebar, markdown
transcript, composer and both skins, in a browser at a fixed size. Before each
shutter the recipe requires the sidebar row for that bot, the newest transcript
row by its own `data-mid` (the id `wait` returned) and a model chip carrying a
resolved model name, so a frame cannot be a half-painted shell.

Not proven: the Electron window. The traffic lights and the title strip in the
picture are the renderer's own header for the shell, and no Electron process is
involved, so nothing here covers menus, the preload bridge, dictation or screen
capture. The reply is scripted, not a model's. Timestamps and token counts are
real, so a re-run reproduces the picture but not its exact bytes. The hand-made
shots in `docs/screenshots/` stay as they are; these two sit with the rest of
the verification evidence.

Sidebar behaviour beyond a plain list — folders, archive, drag — has its own
fixture: [the sidebar fixture](sidebar.md).