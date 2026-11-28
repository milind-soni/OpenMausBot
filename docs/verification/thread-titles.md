# Automatic thread titles

```sh
pnpm exec vitest run server/thread-title-auto.e2e.test.ts
pnpm exec vitest run server/index.test.ts -t 'title|snippet'
pnpm exec vitest run server/thread-title.test.ts server/thread-title-generate.test.ts server/host/handed-thread-title.test.ts server/side-jobs.test.ts server/tasks.test.ts server/group-tasks.test.ts server/team-backup.test.ts server/drivers/openai-responses.test.ts src/components/settings/pages/FeaturesPage.test.ts
```

The isolated server fixture uses a scripted Claude CLI. A new conversation first shows the user's opening line. When the first turn settles with an answer, its generated title uses the request and the answer. If the turn fails, ends without an answer or takes longer than 30 seconds, the original request is used. The title call has a separate 30-second limit. A failed or empty answer leaves the current title intact.

Settings → Features selects a connected model for titles; Automatic uses the conversation's engine or, when it cannot generate text, the configured helper if the bot permits it. Automatic follow-up titles are off by default. When enabled, a generated title may update after a later reply; a manual rename stays fixed. Explicit Regenerate still works on a manually named thread.

The title model receives redacted excerpts. Confined guest, linked hand-off and voice-call titles stay on the conversation's engine. Backups carry the follow-up preference and title provenance. The destination keeps its own provider selection.
