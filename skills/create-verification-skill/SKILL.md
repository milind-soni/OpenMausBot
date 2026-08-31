---
name: create-verification-skill
description: "Create one reviewed skill that teaches a bot how to launch, drive, and verify a specific app or project. Use only when the user explicitly asks for a verification skill."
---

# Create a verification skill

Create one compact, project-specific `SKILL.md` through OpenMausBot's normal
skill review flow. Do not install files directly, enable a skill yourself, or
silently add scripts to the user's project.

## 1. Inspect before drafting

Use the tools already mounted on this bot to establish:

- the exact project or app being verified;
- its existing launch command and reliable ready signal;
- the safest available control surface: existing project CLI, browser,
  computer, phone, or shell;
- one read-only health check;
- up to three important user workflows and the observable result that proves
  each one worked;
- how to stop only the process or resource started by the verification run.

Prefer an existing control surface. If the project has no dependable way to
launch or drive the relevant workflow, report that prerequisite instead of
inventing commands, selectors, APIs, or a new control program.

## 2. Prove one workflow

Run the real launch, health check, one representative workflow, evidence
capture, and cleanup once. Use an isolated test profile or temporary data when
available; never drive the user's live data merely to author the skill. If the
workflow cannot be proved with the tools currently mounted, stop and explain
which capability is missing.

## 3. Draft one self-contained skill

The proposed `SKILL.md` must contain YAML frontmatter and these sections:

1. **Launch** — exact command, isolated data/profile, ready signal.
2. **Doctor** — one read-only check with an actionable failure message.
3. **Drive** — stable names, accessibility targets, routes, refs, or commands;
   never recorded screen coordinates.
4. **Evidence** — action plus resulting state and any important side effect.
5. **Cleanup** — stop only what this run started; preserve the evidence.
6. **Feature map** — at most three proven workflows, each with the user path,
   control recipe, success proof, and known gotcha.
7. **Maintenance** — re-run Doctor and the affected workflow when the app
   changes; update drifted instructions but never hide a product failure.

Keep it concise. A recording from Teach a skill may provide evidence for the
user path, but it is input to the draft—not permission to retain secrets,
audio, screenshots, or coordinates.

## 4. Stage it for review

Call `skills_list` first. If an existing skill already covers the project,
report that and do not overwrite it. Otherwise call `skill_manage` with
`action="create"`, the complete `skill_md`, a short `gist`, and the exact
source used (repository path, URL, or `conversation`).

`skill_manage` only stages the proposal. Tell the user its name and that it is
inactive until they approve the in-app review card. Never claim it was enabled
or scheduled automatically.
