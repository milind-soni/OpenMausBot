# Desktop branding repair — 2026-09-27

The reported terminal showed `cua@openmausbot-computer`. The managed desktop
launcher used its persistent container identity as its guest hostname. The
frontend asset guard cannot inspect desktop pixels, so it missed this path.

## Changes

- New Docker/Podman Local VMs and managed VPS desktops use `nation-computer`
  as their hostname. Existing container names, ownership labels, image versions,
  workspace mounts, driver sockets and executable paths remain compatible.
- Before a managed guest is used through MCP or a requested preview, a quiet
  installer adds a NATION Bash prompt/title hook as the existing desktop user.
  This reaches existing guests without deleting or recreating them, gaining
  privileges, changing their hostname at runtime or rewriting saved work.
  Status/readiness inspection remains observation-only.
- Existing terminals need to be reopened, or source their `.bashrc`, to load
  the hook. Old scrollback and history are deliberately not rewritten. The
  old guest's kernel hostname stays unchanged until it is recreated normally;
  it can still be observed by explicitly running `hostname` there.
- The settings page no longer renders raw image references, host workspace
  paths or generated image/container commands. Prepare, create, view, stop,
  remove and the durable guest-workspace explanation remain.
- Preview temporary filenames and checkpoint author addresses use NATION.
  Setup/credential diagnostics no longer tell people to use legacy product
  config paths or expose the old internal credential variable name. Accepted
  environment aliases and saved-data formats are unchanged.

The source audit found no remaining literal OpenMuse/OpenMaus product copy in
the frontend. Remaining source matches include compatibility formats, protocol
identifiers, internal container/image identities, comments, tests and legal
attribution. They were not blindly renamed. This is not a claim that arbitrary
user content, third-party applications, existing history or every provider's
desktop image has been scrubbed.

## Verification

Node 24.19.0, isolated temporary homes and owned fixtures only:

Results: 197 focused checks passed, one existing platform-dependent check
skipped; the selected credential diagnostic regression passed; all seven
verification-documentation checks passed.

```sh
./node_modules/.bin/vitest run server/desktop-branding.test.ts \
  server/container-computer.test.ts server/container-mcp.test.ts \
  server/vps-computer.test.ts server/vps-container-mcp.test.ts \
  server/checkpoints.test.ts server/drivers/boxagent.test.ts \
  server/drivers/openai-compat.test.ts server/drivers/grok.test.ts \
  src/components/LocalComputerSection.test.ts \
  src/components/LocalComputerSection.branding.test.ts scripts/brand-guard.test.ts
./node_modules/.bin/vitest run server/drivers/codex.test.ts -t 'names a missing Company API key'
./node_modules/.bin/tsc -b
./node_modules/.bin/tsc -p tsconfig.server.json
./node_modules/.bin/oxlint --deny-warnings .
node scripts/generate-locale.mjs --check
./node_modules/.bin/vite build
node scripts/brand-guard.mjs
./node_modules/.bin/tsc -p tsconfig.server.build.json
node scripts/bundle-server.mjs
node scripts/smoke-packaged-server.mjs
```

The real Bash regressions exercise both string and array prompt callbacks,
legacy hostname text, title control sequences, repeated installation and
preservation of saved files/history. The real subprocess test proves unchanged
MCP bytes, quoted arguments, umask and child exit status. Lifecycle/bridge tests
retain namespace/ownership checks and forwarding behavior. The rendered React
fixture supplies legacy metadata and verifies that it is absent from the UI
while the working controls remain.

UI build and brand guard pass (92 files, zero matches); the standalone backend
starts without node_modules, all 15 proxy paths resolve and the MCP smoke passes.
Typecheck, lint and translation validation pass. Existing inventory tests were
updated from old brand expectations; an existing malformed English separator
was corrected. No production settings, computers or accounts were touched.

## Live follow-up

This environment has no Docker/Podman desktop. Cloud Browser rejected the
local visual fixture's file URL under its URL policy; that restriction was
not bypassed. No after-screenshot of XFCE or Chrome is claimed. The user-provided
image is the before evidence; shell and rendered-React checks are the available
after evidence. The full repository suite was not rerun for this focused repair.

After the backend update, verify in an isolated desktop: use the computer once,
open a fresh terminal, and confirm its prompt and title have NATION wording.
On a newly created Docker/Podman/VPS computer, `hostname` must print
`nation-computer`. Confirm a previously saved workspace file still opens and
the agent can type, run commands and capture the screen. Do not delete an
existing VPS merely to change its hostname: its filesystem may not be durable.
