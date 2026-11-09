# Shared skill management

Follow [the isolation rules](README.md). Run the fixture directly; it launches its own disposable home/data directory and fake engine and never discovers a live app:

```sh
pnpm exec vitest run server/skill-maintainer.e2e.test.ts
```

The fixture seeds a formal library package with a reference attachment and a visible managed target with other assignments. Through an active Chief turn capability it assigns, unassigns and shares one skill; reads each result back; removes an assignment whose library item has been retired; and designates a maintainer without granting execution permissions. It checks unchanged library bytes during assignment operations, preserves unrelated assignments and the attachment, and hashes config, bot registry and library around wrong-revision, demoted-Chief and invisible-target refusals.

The fake engine stays in its controlled slow mode until the fixture closes it. The output names the fixture URL, PID, temporary data directory, retained server log and `.skill-management.json` request/result evidence. Keep that evidence and the command's terminal exit status. If port reservation or server startup fails, the workflow is unverified; unit tests do not replace it.

Additional focused checks:

```sh
pnpm exec vitest run server/skill-assignment.test.ts server/skills-library.test.ts server/drivers/agents-proxy.test.ts server/drivers/agents-catalog-wire.test.ts
pnpm exec tsc -p tsconfig.server.json
pnpm lint
```

The unit fixture also covers every-bot access after unassign, private shadowing, disabled and tampered packages, immediate Chief/peer/department authority changes, unrelated-library visibility, and failed registry persistence. These checks do not establish native shell handle recovery after an external transport deadline or delegated terminal completion delivery.
