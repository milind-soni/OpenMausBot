# `docs/dev/fixes/` — project board

This directory is the source of truth for audits, fixes, and improvements. Each work document has a status in both its filename and frontmatter; each concrete action has a checkbox status.

## Status model

| Filename prefix | Frontmatter | Line item | Meaning |
|---|---|---|---|
| `todo--` | `status: todo` | `- [ ]` | Not started |
| `doing--` | `status: doing` | `- [~]` | Being implemented |
| `review--` | `status: review` | `- [?]` | Implemented; awaiting human verification |
| `done--` | `status: done` | `- [x]` | Human-verified and complete |

Use lowercase kebab-case after the prefix: `todo--checkout-validation.md`. Only the prefix changes during a status transition.

## Required document shape

Start from `TASK-TEMPLATE.md`. Every task has frontmatter, a specific title, a short scope statement, and one concrete action per checkbox. Code-touching items include a `file:line` reference.

Keep `status:` consistent with the filename. Update `updated:` whenever status or line-item state changes. Preserve rejected items with strikethrough and a rationale instead of deleting history.

## Roles

### Auditor

An auditor investigates and creates `todo--<scope>.md` with `[ ]` actions. It does not implement code and does not move the document out of todo.

### Implementer

An implementer:

1. Picks a `todo--` or existing `doing--` document.
2. Uses `git mv` to change `todo--` to `doing--`, updates frontmatter and owner, and changes selected items from `[ ]` to `[~]`.
3. For complex work, writes a plan under `docs/dev/plans/` and obtains explicit approval before changing application code.
4. Implements and verifies each selected item.
5. Changes implemented items from `[~]` to `[?]`.
6. When no `[ ]` or `[~]` items remain, uses `git mv` to change `doing--` to `review--` and updates frontmatter.
7. Commits the scoped changes locally and asks the user to review.

The implementer never changes `[?]` to `[x]` and never moves a task to `done--` without explicit user verification.

### Reviewer

The user or designated reviewer verifies review items. Approved items change from `[?]` to `[x]`. When every item is `[x]`, the reviewer moves `review--` to `done--`. A rejected item returns to `[~]` with a note explaining what remains.

## Relationship and history rules

- Link related task filenames in the `related:` frontmatter list.
- Never delete completed documents; they are the project history.
- Split very large audits into independently actionable scopes and link them.
- If an old, nonconforming task is adopted, migrate its actionable work into a new status-prefixed document instead of silently overwriting it.
