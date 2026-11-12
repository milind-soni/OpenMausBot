---
created: 2026-11-12
updated: 2026-11-12
owner: Yv (CEO / project lead)
---

# Roadmap: November 2026 product expansion

Gerer Build Studio is not only for software developers. Designers, editorial
teams, authors, scientists, and researchers use it too. Every item below must
read and work well for someone who has never opened a terminal: plain words,
no unexplained jargon, safe defaults.

This document is the index. Each initiative has an implementation plan in
`docs/dev/plans/` and a task document in `docs/dev/fixes/`.

## Initiatives

| # | Initiative | Plan | Task document | Lead | Support |
|---|---|---|---|---|---|
| 0 | Keep typed messages when switching bots (bug) | n/a (small fix) | shipped in `1930420` | Yv | Dell verifies |
| 1 | First-run friction, remaining items | `implementation` not needed (scoped fixes) | `doing--first-run-ux-friction.md` | SoSo | Z, Marty, Dell |
| 2 | Plain-language pass for non-developers | n/a (copy work) | `todo--plain-language-pass.md` | Marty | Z, SoSo, Dell |
| 3 | Remove the cloud computer integration | `implementation--remove-cloud-computer.md` | `todo--remove-cloud-computer.md` | SoSo | Dell |
| 4 | Preview Studio (better quick preview + full Preview page with canvas mode) | `implementation--preview-studio.md` | `todo--preview-studio.md` | SoSo | Z, Dell |
| 5 | Scheduled runs, auto-resume, and backup model | `implementation--scheduled-runs-and-backup-model.md` | `todo--scheduled-runs-and-backup-model.md` | SoSo | Z, Marty, Dell |
| 6 | Remaining-usage rings in the top bar | `implementation--usage-rings.md` | `todo--usage-rings.md` | SoSo | Z, Dell |

Initiatives 5 and 6 share one foundation: a normalized "usage limit" signal
from each AI engine (what is left, when it resets, and whether a turn failed
because credits ran out). That foundation is built once, in phase A of plan 6,
and plan 5 consumes it.

## Sequence

1. **Now**
   - Ship the draft-persistence fix (done).
   - Start the work that needs no plan approval: design explorations (Z), the
     plain-language glossary (Marty), and the engine usage-data spike (SoSo).
2. **Build, in this order** (all plans approved 2026-11-12):
   1. Remove the cloud computer. This shrinks the surface area before new
      features land.
   2. Build the usage-limit foundation, then the usage rings.
   3. Build scheduled runs, then auto-resume and the backup model on top of
      that foundation.
   4. Build Preview Studio. It is independent and can run in parallel with
      step 3 once design is ready.
3. **Every initiative ends with**:
   - QA by Dell in both the desktop app and the browser.
   - A short user guide page in `docs/guide/`.
   - The task document moved to `review--`.

## Definition of done (all initiatives)

- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- New behavior has automated tests, plus manual QA notes in the task document.
- All user-facing words pass the plain-language glossary
  (`docs/guide/glossary.md`, created in initiative 2).
- The work is documented for users (`docs/guide/`) and for maintainers (the
  plan is updated to match what shipped).
- It is committed locally. Nothing is pushed without the user asking.
