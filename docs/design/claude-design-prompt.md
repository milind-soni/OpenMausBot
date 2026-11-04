# Claude Design — paste pack

Use after installing the **Claude Design Import** GitHub App on `P-Sivakumaran/Musterd` (read-only).

## 1. Project setup (UI steps)

1. Open [claude.ai/design](https://claude.ai/design) → **Product prototype** (or Start with a file → Add a design system).
2. **Create here** → Link code from GitHub → `https://github.com/P-Sivakumaran/Musterd`.
3. Company / system blurb:

   > Musterd — lean local multi-bot harness. Operator desk for bots, rooms, and approvals. Peer to Kepler. Token-driven skins in CSS, not a separate component kit.

4. Prefer attaching / emphasizing:
   - `docs/design/musterd-ui-overhaul.md`
   - `docs/design/system/README.md`
   - `src/styles.css`
   - `src/lib/skins.ts`
   - `src/components/Sidebar.tsx`
   - `src/components/ChatView.tsx`
   - `src/components/Composer.tsx`
   - `src/components/ChatEmptyState.tsx`

## 2. First message (paste)

```text
Read docs/design/musterd-ui-overhaul.md and docs/design/system/README.md as the brief.

You are redesigning the Musterd desktop app UI (local multi-bot harness), not a marketing site.

Constraints:
- Build against the existing CSS token system ([data-skin], --color-*, --font-*, .ui-button, .chat-column). Do not invent a parallel design system.
- Show Midnight (dark) and Daylight (light) at minimum.
- First viewport = one composition: app frame + sidebar + chat. Brand “Musterd” must be a hero-level signal on empty/onboarding, not only nav text.
- Local edition: no cloud buy / companion phone upsell in the primary empty state.
- Avoid purple-indigo AI SaaS gradients, cream+terracotta brochure look, and card grids in the hero.
- Density for all-day operators; 2–3 purposeful motions max.
- Visual cousin to a Kepler-style operator desk, not a clone.

Deliver in this project:
1) High-fidelity prototype of the P0 shell (sidebar + chat + composer) idle, streaming, and empty-team states.
2) Phone-narrow variant of the same shell.
3) One P1 screen: either bot settings or appearance/skins.
4) A short note listing which --color-* / shared classes you changed vs today’s src/styles.css.

When done, prepare export as standalone HTML + zip suitable for handoff into the React codebase under docs/design/handoff/.
```

## 3. Follow-ups (optional, one at a time)

```text
Tighten the empty chat state: one headline, one short line, one CTA group, dominant brand. Remove secondary promo chrome.
```

```text
Restyle .ui-button / composer pill only via tokens so all skins inherit. Show Atelier and Foundry too.
```

```text
Add an approval interrupt state in the chat column without turning the layout into a dashboard.
```

## 4. Bring it back to this repo

1. Export → **Download as .zip** and/or **Export as standalone HTML** (and Handoff to Claude Code if useful).
2. In this repo: create `docs/design/handoff/` and drop the export (or open a PR with HTML + screenshots).
3. In Cursor / Kepler: implement against real components listed in `docs/design/system/README.md`, using the export as visual truth.

## 5. Import troubleshooting

- App permissions are **read-only** (code, issues, metadata, PRs). Select only `Musterd` if scoping repos.
- Large repo: if Import asks for a subfolder, point at `src/` plus `docs/design/`.
- Design does not open PRs against the source; engineers map HTML → TSX here.
