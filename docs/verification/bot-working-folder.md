# Bot working folder actions

Run the isolated server and renderer checks:

```sh
pnpm exec vitest run server/routes/bot-memory.test.ts src/components/BotWorkingFolderActions.test.ts src/components/SidebarBotRead.test.ts src/components/bot-panel/PanelShell.dom.test.ts scripts/testing/bot-working-folder-ui.e2e.test.ts
node --test electron/save-file.node-test.mjs
```

The integration check launches a disposable fake-engine server with
`launchVerificationServer` and mounts the production folder actions in a DOM
renderer. It runs a real fake-engine turn and places a fixture report in its
recorded working directory. It clicks Open working folder in the header and menu
variants, checks that the prepared directory exists inside the fixture, and
checks that both openings find the report in that directory. It then activates a
sibling conversation and verifies that copying still targets the explicitly
selected original thread. The test prints the fixture URL, data
directory and persistent server log path. Its desktop and clipboard bridges
record calls rather than opening an OS window. The panel and sidebar tests also
check the visibility of the actions.

The desktop shows Open working folder when the folder can be opened locally.
Otherwise, a known path offers Copy path instead. These actions are mutually
exclusive. The integration check also verifies copying in remote-client mode.
Feedback uses the app's floating notice toast, outside the header and menu;
opening shows a spinner, and successful copying shows a check mark.

Folder lookup uses the selected conversation's pinned `cwd` first, otherwise
the bot's custom `cwd`, otherwise `task-workspaces/<botId>/<threadId>`. It does
not substitute the bot's shared memory workspace. An explicitly null task folder
has no known host location. Both lookup and preparation include the thread id;
unknown threads are refused and switching conversations cancels stale actions.

Folder controls mount only after the session is confirmed to be an owner or
admin. Client-only sessions and pending access checks render no action, make
no working-folder request and show no failure toast. Header and both sidebar
menu modes have regression coverage for client-only sessions.

The route checks cover custom paths, creation on demand, existing directories,
file collisions, VM/cloud restrictions, unsafe paths, unauthenticated requests,
chat-only sessions and remote administrators. Remote administrators cannot
prepare a folder on the host. Renderer checks cover opening failures,
browser-only clients and switching bots during a request.

For a packaged Windows smoke check, use only an isolated fixture and disposable
Electron profile. Open both UI entry points and confirm Explorer selects the
conversation's folder. On macOS, revealing an application bundle must select it
in Finder without launching it. Choose a custom folder inside the fixture and repeat from both
entry points. Switch to a VM or cloud bot and confirm unavailable host actions
are hidden. The automated checks exercise the shell adapter with stand-ins;
they do not prove Explorer's visible behavior.
