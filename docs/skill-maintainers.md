# Shared skill assignments and maintainers

A library skill is shared; a bot cannot own it. A maintainer is a responsibility label, not an access grant or a change in ownership. The existing skill package, provenance, assignments, enabled state, and bot execution permissions remain unchanged.

With the skills library enabled, `skills_list` shows shared scope (`all_bots` or `selected_bots`), this bot's assignment and enabled state, the SKILL.md content revision, the companion-files revision when present, a management revision, and the maintainer's ID and access status when visible. The management revision covers the library entry and assigned bot IDs. It is distinct from the content revision used for shared skill edits.

Management requires the current Chief's powers, an active eligible conversation, and authority over the target under the existing team, ownership, visibility and peer rules. Extra managed departments follow those same rules. A maintainer label never grants these powers. Role, reach and target availability are checked on every request, even when the tool was listed before a role changed.

For a requested assignment, first call `skills_list` with `target_bot_id`. This lists the target's explicit `assignedSkills` and per-skill `management_revision`, including stale assignments missing from the index. Other candidate skills are limited to shared library skills available to the Chief. Copy the exact name and revision into:

```json
{
  "action": "assign",
  "skill_name": "order-audit",
  "target_bot_id": "target-id",
  "base_revision": "management_revision from the target listing"
}
```

`share` and `assign` both add this one existing formal library skill to one target, preserving every other assignment, including stale names. They require the Chief's access to the enabled, intact shared skill and refuse a private namesake on the target. They do not promote or move a private skill, rewrite its package or provenance, enable it, change its scope, or grant execution permissions. The existing learned-skill Share receipt remains a separate operation.

`unassign` removes only this explicit name, even when its library entry is missing, disabled or damaged, or a private namesake shadows it. It preserves other assignments and all skill files. For an `all_bots` (`everyBot`) skill, removing an explicit assignment does **not** revoke library access. A private namesake still wins resolution and is never removed. Readback distinguishes `assigned`, `shadowed`, `enabled`, `available`, `in_library` and `scope`; `available` describes library resolution outside conversation-prefix withholding, not a new execution grant.

The assignment receipt returns the target ID, complete remaining assignments and the resulting skill state. Call `skills_list` again with the same `target_bot_id` and compare it with the receipt. A stale `base_revision` is refused before any assignment write; list again rather than retrying blindly. The legacy public assignment PUT still replaces a whole list and is not used by these native single-skill operations.

When the person explicitly asks to designate a maintainer, use `skill_manage` with `action: "transfer_maintainer"`, the exact `skill_name`, `target_bot_id`, and the latest shared skill `management_revision` as `base_revision`. The target must be a visible managed bot already able to use the enabled shared library skill, without a private skill of the same name shadowing it. This operation does not assign a skill. If the skill, its assignments, or the package changed, list and verify it again. The applied receipt includes the resulting state; list the skill again for readback before considering the change complete. Do not delete a prior copy based on an enable receipt.

Private, unassigned, disabled, tampered, or unavailable skills cannot be transferred through this operation. A conversation that cannot apply shared-skill changes receives an explicit refusal rather than a confirmation card. If a designated bot is removed, loses visibility or access, the readback reports an unavailable or no-access maintainer. Moving a workspace does not currently transfer this designation. Older versions do not preserve it when rewriting the library index.

The isolated fake-engine recipe is [shared skill management](verification/skill-management.md).
