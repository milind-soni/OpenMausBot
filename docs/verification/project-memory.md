# Project-scoped native memory

Project memory is a local, noncanonical projection in the existing
`team-memory.json` file. Kanister remains the canonical shared-memory
authority. This adapter has no network client, promotion route or background
capture. It does not contact a memory backend.

The operator registers an explicit mapping:

```json
{
  "version": 1,
  "projects": [
    {
      "id": "acceptance-alpha",
      "sectionKey": "team:stable-native-section-id",
      "root": "/absolute/physical/project-alpha",
      "memberBotIds": ["native-bot-id"]
    }
  ]
}
```

`sectionKey` is the existing stable native memory identity, obtained from
`sectionMemoryKey(section)`. A section rename keeps that identity. Deletion
and recreation do not transfer its grant. Each request reads the current
policy, native membership and assigned working directory again. The working
directory must be the registered physical root or one of its physical
subdirectories; symlink aliases, lexical traversal, missing directories and
prefix siblings are refused. Ambiguous overlapping grants are refused.

The HTTP handler must take the caller identity from its current internal
capability and recompute context from current server-owned bot, thread and
assignment records. A request body cannot select a bot, project, path, scope
or provenance. Writes additionally require the existing direct-user
authorization check together with the native root's immutable `person`
origin. A denied write saves nothing. The policy is reread from the owner's private regular
`DATA_DIR/project-memory-policy.json` file; it cannot be a symlink.

In a shared room every current bot recipient must also be an admitted
member of the same current native project section. Adding a nonmember or
moving a recipient to another section closes the room's project recall.

`ProjectMemory.request(caller, input)` accepts these operations:

- `remember`: `kind`, `name`, `detail`, optional stable `key` and `aliases`.
- `recall`: optional `query`, exact `entryId`, current `revision` pin, and bounded `limit` of 1–25.
- `forget`: exact `entryId` and current `revision` from a remembered entry.

A recall revision pin must be a 64-character lowercase hexadecimal hash.
A stale revision or foreign project entry returns no result; a pin never
expands the caller's project scope.

Remembered notes require `kind`, a 1–120 character `name`, and a 1–600
character `detail`. Store a concise decision or schema summary with a reference
to the full project artifact. Oversized content is rejected without saving or
truncating it. Validation errors identify the field, limit and supplied string
length so a caller can deliberately summarize a refused note. They do not echo
note content or unknown field names. Scope and write authorization remain
server-owned; a validation repair never grants access.

Results identify the project, caller and original native source. Every
projection reports `canonical: false`, `promoted: false` and
`untrusted_context: true`. A remembered entry includes its content hash and
a revision-bound `forget` receipt. Forgetting removes that current entry;
it does not restore a superseded version or provide the ordinary team
proposal card's Undo workflow. Original versions and provenance remain in
the native memory history.

Project entries occupy a separate `projects` dictionary in the same native
memory file. Ordinary team search, automatic team prompts, team proposals
and their cards retain their existing behavior and do not include project
entries. The project namespace includes project identity, stable section
identity and physical root, so repointing a mapping cannot inherit notes
from its former root.

The native memory file becomes version 3 after its first project entry.
Older runtimes reject that version and preserve the file instead of dropping
the project namespace during a team save. A rollback must retain this file
for the updated runtime, or explicitly restore the matching pre-deployment
data backup; older runtimes cannot serve the new project notes.

## HEL1 verification

Run these in an isolated fixture on the execution worker:

```sh
pnpm exec vitest run server/project-memory.test.ts server/team-memory.test.ts server/team-memory-integrity.e2e.test.ts
pnpm exec vitest run server/project-memory-api.e2e.test.ts
pnpm typecheck
```

The focused tests cover trusted source provenance, separate native team
prompts, authorized shared membership, guessed foreign entry IDs, forged
scope and path fields, sender substitution, working-directory changes,
revocation, section rename/deletion, lexical and symlink aliases,
overlapping mappings, root changes, persisted native-file reloads,
revision-bound deletion, redaction and failed/damaged-file preservation.
The HTTP fixture uses actual native Ask task records and internal turn
capabilities, proves identity/scope forgery denial, undriven write refusal
and current member revocation, restarts its server, refuses the old bearer and verifies the
same source/revision in a fresh authorized conversation capability.

The live acceptance uses only synthetic canaries in two explicitly
registered projects through Your office. It must record actual native tool
receipts before and after the worker restart, including a denied
cross-project request and a revoked membership request. Fixture test output
alone does not establish live model recall quality.

## Boundary

This is an authorization boundary for the native project-memory API and
tool. Agents that share an operating-system account can still have shell or
filesystem permissions outside it. Project memory does not provide an
operating-system sandbox, make personal/team memory project-scoped, or
qualify backend availability while Goliath remains suspended.
