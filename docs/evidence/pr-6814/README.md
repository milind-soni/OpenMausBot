# PR #6814 — side panel spacing (verification evidence)

The changed surfaces (simple bot panel tab stack, advanced settings accordion bodies, remote desktop browser pane) do not ship a static Vite preview page. Verification therefore combines automated DOM/e2e tests, upstream renderer smoke, and CONTRIBUTING-style preview captures on the same design tokens (Midnight / Daylight, 1440px).

## Spacing intent (summary)

| Surface | Change |
|---------|--------|
| Panel tab chips / card stacks | Uniform `12–16px` vertical rhythm between first card and section headers (`space-y-3` / `gap-3` alignment vs tighter mixes) |
| Advanced settings accordion bodies | Consistent `py` / `space-y` between rows |
| `BotSettingsDialog` | Stable `key="settings"` — no slide-in replay on bot switch; `MemorySection` / `SkillsSection` keyed by `bot.id` |
| Memory usage gauge | Grid layout so long Italian labels do not overlap the bar |

## Automated checks

- `PanelShell.dom.test.ts`, `useBotOverview.test.ts`, `BotSettingsDialog.simple.test.ts`
- CI: `renderer smoke (control-omb ui, Ubuntu 24.04)` — [run on PR #6814](https://github.com/milind-soni/OpenMausBot/actions/runs/44845411890)

## Preview captures (CONTRIBUTING workflow)

Captured locally with `pnpm dev` + `pnpm shots` (`OMB_CDP_CHROME` on Windows):

- `panel-spacing-reference-1440-midnight.png`
- `panel-spacing-reference-1440-daylight.png`

The source page of these captures is not recorded here, so this README does not claim they share the bot-panel spacing tokens.