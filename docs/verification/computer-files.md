# Saving recent changed files

Launch the isolated server and real Files component:

```sh
node --experimental-strip-types scripts/verify-computer-files.ts
```

Open the printed `previewUrl`. The fixture creates four synthetic files and
the fake engine's persisted reply links to three by absolute file URL. The
temporary project is the conversation's pinned working folder. The sealed
launcher has no Git, so the fixture supplies changed-file digest rows to the
renderer; all file requests still reach the real, unchanged server using the
persisted reply. No real engine, account, or application data is used. Ctrl-C
closes both fixture servers and removes only their temporary data.

Check the following in the browser:

1. `report #1.md` and `metrics.csv` have **Save a copy** buttons. Opening
   the Files tab must not download either file.
2. Save `report #1.md`. The button reports **Downloaded**, and the saved
   text contains the synthetic review. Its encoded file URL is sent with the
   stored reply's message ID through the existing file endpoint.
3. **Preview table: metrics.csv** opens the existing table preview, with
   Alpha / 12 and Beta / 7. Escape returns to the Files panel.
4. `missing.txt` is intentionally absent. Saving it shows the server's
   error rather than pretending it was downloaded.
5. `unshared.txt` says **Not shared**, explains that the bot must share a
   link in chat, and offers no download or preview. A digest is not a grant.
6. Repeat at a narrow viewport and with `?skin=atelier` for the light theme.
   Long file names must not push the panel wider.

Focused checks:

```sh
pnpm exec vitest run src/components/ComputerFilesPane.test.ts src/components/ComputerPanel.simple.test.ts src/components/AttachmentGallery.test.ts src/components/AttachmentPreview.test.ts server/message-file.test.ts scripts/testing/verification-docs.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

The component tests cover the visible branch, exact thread/message scope,
encoded file URLs, Windows paths, explicit null pins, changed bot defaults,
deleted-file filtering, workspace refusal, and state reset on thread changes.
Authorization and containment remain the server's responsibility on every
click. Only existing Markdown file links and stored file attachments are
used; there is no new path-reading API or expanded root. Unmatched spelling
variants remain unavailable rather than guessing by basename. CSV/TSV use the
existing preview; other formats retain their existing save behavior. This is
not a full directory browser, a checkpoint test, or a packaged desktop/phone verification.
