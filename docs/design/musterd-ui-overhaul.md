# Musterd UI / UX overhaul — Claude Design brief

**Product:** Musterd — a lean local multi-bot harness (fork of OpenMausBot), native peer to Kepler workspace agents.  
**Repo (GitHub Import):** https://github.com/P-Sivakumaran/Musterd  
**Branch to read:** `feat/lean-harness` (or this docs branch once merged).  
**Round-trip:** Claude Design designs → export HTML / handoff → implement here in Cursor / Kepler (not a native Design→Kepler pipe).

## What Musterd is (voice)

Musterd is the desk where you run a small team of local bots: chat, rooms, approvals, computer use, skins. It is **not** a cloud SaaS marketing site and **not** OpenAI/Anthropic chat chrome with a new logo.

- **Local-first harness** — bots, threads, and config live under `~/.musterd`.
- **Kepler peer** — inbound via Musterd MCP; outbound via `kepler_notify` / inbox. Same operator desk as Kepler, different job.
- **Edition:** default `local` trims cloud buy flows, companion phones, and verticals from the built-in surface. Full edition exists; **design for local** unless a screen is explicitly cloud-only.

Brand signal: **Musterd** should read as the product name at hero scale on any redesign of empty states / onboarding — not only as nav text.

## What to redesign (priority surfaces)

Design these as one coherent product language. Prefer fewer, stronger screens over a kit of disconnected mockups.

| Priority | Surface | Source of truth in repo |
| --- | --- | --- |
| P0 | App shell — frame, sidebar, chat column | `src/components/Sidebar.tsx`, `src/components/ChatView.tsx`, `src/App.tsx` |
| P0 | Message stream + composer | `src/components/Composer.tsx`, message / bubble components under `src/components/` |
| P0 | Empty / first-run chat | `src/components/ChatEmptyState.tsx`, `src/components/onboarding/` |
| P1 | Bot picker / bot settings | `src/components/BotPickerList.tsx`, `src/components/bot-settings/`, `BotSettingsDialog.tsx` |
| P1 | Rooms / group threads | `src/components/room-panel/`, `RoomHeader.tsx` |
| P1 | Appearance / skins | `src/lib/skins.ts`, `src/components/SkinPicker.tsx`, `[data-skin]` blocks in `src/styles.css` |
| P2 | Approvals / activity | `ApprovalCard.tsx`, `ActivityPanel.tsx`, `src/components/inbox/` |
| P2 | Settings / keys | `AppSettingsRows.tsx`, `src/components/keys/` |

**Out of scope for this overhaul pass:** cloud buy / WhatsApp companion phone hero chrome, Whop / Postiz verticals, marketing landing pages outside the app.

## Hard constraints (engineering must keep)

1. **Skins are CSS custom properties** under `[data-skin="…"]`, not a second component library. New visuals must map onto existing tokens (`--color-app`, `--color-panel`, `--color-ink`, `--color-accent`, `--color-composer`, …). See `docs/design/system/README.md`.
2. **Default skin choice is `system`** → Midnight (dark) / Daylight (light). Overhaul may propose a new default story, but must not orphan the other skins without a migration note.
3. **Typography today:** Geist Variable + Geist Mono (`--font-sans` / `--font-mono`). Optional overrides via `data-font` (`src/lib/fonts.ts`). A new brand font is allowed in Design if it ships with a concrete fallback plan.
4. **Shared controls:** `.ui-button`, `.ui-icon-button`, `.popover-surface`, `.glass-surface`, `.chat-column` in `src/styles.css` (`@layer components`). Prefer restyling these over inventing parallel primitives.
5. **Desktop + phone:** `PHONE_LAYOUT` / media queries matter; touch targets already grow under `@media (pointer: coarse)`.
6. **Contrast:** skins aim at WCAG AA; `pnpm check:contrast` / `scripts/check-skin-contrast.mjs` are gatekeepers.
7. **i18n:** user-visible strings go through `t(...)` / locales — Design copy is English source; implementers wire keys.

## Design goals

1. **One desk** — first viewport of the running app should feel like a single composition (sidebar + chat), not a dashboard of cards.
2. **Harness identity** — differentiate from generic “AI chat” and from upstream OpenMausBot where it still shows. Calm, precise, local tooling — not neon agent-swarm.
3. **Kepler kinship** — visual cousin to Kepler workspace UX (operator desk, tasks, agents) without cloning Kepler chrome. Shared operator, distinct product.
4. **Density with air** — power users live here all day; keep information density, reduce chrome noise (pill clusters, duplicate status strips, decorative glass).
5. **Motion with purpose** — existing tokens (`--animate-panel-in`, `--animate-msg-in`, …). 2–3 intentional motions max in proposals; no perpetual glow spam.
6. **Local edition honesty** — hide or de-emphasize cloud upsell in empty states and settings for the default edition.

## Anti-goals / avoid

- Purple-on-white / indigo gradient “AI SaaS” look.
- Warm cream + terracotta serif brochure look.
- Broadsheet dense newspaper columns.
- Carding everything; no cards in hero/empty-state unless they are the interaction.
- Floating badges / promo stickers on the chat hero.
- Rebranding as “Maus” / OpenMausBot in new art.

## Deliverables expected from Claude Design

1. **Product prototype** (preferred) or high-fidelity wireframes covering P0 + at least one P1 surface.
2. **Skin story** — show Midnight + Daylight at minimum; call out token changes vs today’s `--color-*` set.
3. **States** — idle chat, streaming / working, approval interrupt, empty team, narrow phone width.
4. **Export:** standalone HTML and/or Download as `.zip`, plus **Handoff to Claude Code** / local agent notes so implementers can map frames → `src/components/*`.
5. **Short change list** — what tokens, primitives, and components move; what stays.

## How work returns here

1. Paste the prompt in `docs/design/claude-design-prompt.md` into a new Claude Design project.
2. Attach design system via GitHub Import on `P-Sivakumaran/Musterd` (read-only App). Prefer pointing Import at `docs/design/` + `src/styles.css` + `src/lib/skins.ts` + key components if the UI asks for a frontend subfolder.
3. Iterate in Design until P0 feels right.
4. Export HTML/zip → drop into this repo under `docs/design/handoff/` (create when exporting) **or** open a PR with screenshots + HTML.
5. Implement in Cursor/Kepler against real React + tokens — Design output is visual truth, not production source.

## Related docs

- System pointers: [`system/README.md`](./system/README.md)
- Paste-ready prompt: [`claude-design-prompt.md`](./claude-design-prompt.md)
- MCP / Kepler peer: [`../mcp-server.md`](../mcp-server.md)
