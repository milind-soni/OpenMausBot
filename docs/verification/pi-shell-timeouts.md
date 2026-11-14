# Pi shell timeouts

Pi 1.5.0's native `bash` and `powershell` tools take `timeout` in seconds and
have no default. OpenMausBot supplies 120 seconds when omitted and refuses
values outside `(0, 900]` with a tool error explaining the unit. A refused
command never starts, and Pi can continue the conversation after the error.
Services that must outlive a command should run in the background and be
checked with bounded commands.

Run the extension and driver regressions:

```sh
pnpm exec vitest run server/drivers/pi-mcp-extension.test.ts server/drivers/pi.test.ts server/drivers/pi-lifecycle.test.ts
```

For the native CLI contract, pass an installed Pi executable explicitly:

```sh
node --experimental-strip-types scripts/verify-pi-shell-timeouts.ts /absolute/path/to/pi
```

This launches the verification server from `control-omb` with a disposable
home and data directory, then selects the supplied Pi CLI through the engine
settings route. Pi uses a synthetic model hosted on loopback with a fixture
key. No user data, provider credentials or remote SSH hosts are involved.

The fixture sends a conversation through `control-omb` and checks that:

- `timeout: 90000` returns a seconds/limit error without creating its marker;
- a valid seconds timeout and an omitted timeout allow successful commands;
- a hanging local process with `timeout: 0.5` stops and leaves no running child;
- Pi receives the tool errors, replies again and the conversation settles.

The unit tests also check the actual default argument, fractional seconds,
PowerShell, invalid values and tool-selection enforcement. The native fixture
does not wait for the full default deadline or execute PowerShell.

Evidence is written to `.omb-scratch/verify-evidence/pi-shell-timeouts.json`,
including the server log path, wait result and bounded transcript. The fixture
server, temporary home and model endpoint are closed afterwards. This check
does not interrupt or recover an already-running user conversation; an
existing Pi process keeps the extension it loaded when it started.
