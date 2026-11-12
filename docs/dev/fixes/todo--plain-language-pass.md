---
status: todo
created: 2026-11-12
updated: 2026-11-12
scope: plain-language pass for non-developers
owner: Marty
related: [doing--first-run-ux-friction.md]
---

# Plain-language pass: make every screen understandable to non-developers

Gerer Build Studio is used by designers, editorial teams, authors, scientists, and researchers, not only developers. This task creates a glossary and rewrites user-facing words that assume technical knowledge. It does not change behavior.

---

## 1. Glossary

- [ ] **Write `docs/guide/glossary.md`** — Map each technical term to its plain replacement, and say when the technical term may still appear (for example, inside an "Advanced" section). Candidates:
  - engine / driver / harness → "AI app" or "AI model", or hidden entirely
  - repository / repo / clone → "project folder" / "copy from GitHub"
  - token / API key → "access key"
  - MCP / tools → "connected tools"
  - path → "folder location"
  - localhost / private address → "a page running on this computer"
  - rate limit / quota → "usage left"
- [ ] **Agree the glossary with Z and Yv** — One review pass before any copy changes.

## 2. Copy sweep

- [ ] **Onboarding** — `src/components/Onboarding.tsx`. Engine install instructions currently show terminal commands such as `npm i -g …`. Lead with what the tool is and a "How to install" link. Keep the command behind a "Show command" toggle.
- [ ] **Projects screen** — `src/components/ProjectsScreen.tsx`. Clone, repository, and path wording.
- [ ] **Settings** — `src/components/SettingsScreen.tsx`, `src/components/SettingsPanel.tsx`. Keys, engines, and permissions wording. Technical detail moves under "Advanced".
- [ ] **Chat activity and errors** — `src/components/ChatView.tsx` (`ErrorRow`, `ActivityChip`). Raw tool names and error text get a plain summary first, with details on expand.
- [ ] **Task board** — `src/components/TaskBoardScreen.tsx`. Field names and empty states.

## 3. Starter suggestions for more kinds of work

- [ ] **Add non-developer starter chips** — `src/lib/botIntro.ts:21`. Add role patterns and starters for writer/editor, researcher/scientist, and analyst. Make the default set role-neutral (for example "Summarize a document", "Plan a project", "Draft something for me").

## 4. Verification

- [ ] **QA read-through** — Dell walks through first run and each main screen using only the glossary, and lists any remaining jargon.
