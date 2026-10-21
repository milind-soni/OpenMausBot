---
name: reverse-engineer-anything
description: "Reverse engineer, decompile, disassemble, or inspect an app, APK, archive, or native binary the user owns with REA - through its MCP tools when the server is mounted, or its CLI - and report findings with the evidence behind them."
---

# Reverse engineering with REA

REA ("Reverse Engineer Anything", npm package `rea-agents`) inspects a target
app or binary and returns findings with the evidence behind them: modules and
IPC boundaries for JavaScript/Electron, pseudocode and assembly for native
binaries, manifest and method details for APKs and .NET assemblies. Analysis
runs locally on this machine; nothing is uploaded.

Use it when the person asks how a piece of software works, wants a feature
reimplemented from observed behavior, or needs a binary or format understood —
and the target is software they own or are authorized to examine. If that
authorization is unclear, stop and ask before analyzing.

## Two ways in

**MCP tools (preferred).** When this turn's tools include `binary_session`,
`open_binary`, or `close_binary`, REA's server is already mounted. Call
`binary_session` with `{}` FIRST: it works before a target is open and reports
per-operation availability and requirements for the current session. Then
`open_binary` the target, make the analysis calls, and finish with
`close_binary` — export the evidence first (`export_evidence_bundle`) when the
findings should be kept.

**CLI (when the server is not mounted).** REA's CLI needs Node 22.19+, 24.11+,
or 26+, plus npm. Prefer the installed `rea` command; otherwise use the package
runner:

```sh
rea doctor --json                          # read-only readiness report
npx -y rea-agents@latest doctor --json     # if `rea` is not installed
npx -y rea-agents@latest analyze-javascript-application /absolute/path --json
```

`analyze-javascript-application` needs no native analysis engine and is the
right first move for an Electron/JavaScript app. Native deep analysis
(pseudocode/assembly) additionally needs Hopper, Ghidra, or IDA configured on
this machine: run `rea doctor --json` for the exact task and report a missing
prerequisite instead of guessing.

When a tool's description ends with "argument schema omitted here for size",
pass the arguments you believe it takes — REA validates them and its error
message states exactly what is required, so one corrective call resolves it.

## Connecting the MCP server

The server is not mounted by default. The person adds it under
Plugins → MCP servers, then enables it for that bot in its Access section:

- name: `rea`
- command: `npx`
- args: `-y rea-agents@latest mcp`
- env: (empty)

The app resolves `npx` to the Node script it wraps, so the plain command works
on Windows without a `cmd.exe` wrapper. Pin the args to an exact version
(`rea-agents@6.7.0`) to keep one registration stable across upgrades.

REA's catalog is large — 207 tools in 6.7.0, with a substantial argument
schema. Scope it to the bots that need it: an unmounted server costs nothing,
a 207-tool catalog on every turn taxes every request.

If the tools are absent, do NOT run setup or install anything on your own
initiative. Say which route is missing, offer the CLI path (it needs no
server at all), and let the person decide.

## Route the target first

Pick the first tool from the target the person supplied. `open_binary` binds an
archive or native target for the active-target tools; target-free tools take
their own path and never need it.

| Target | First tools | Needs |
| --- | --- | --- |
| ASAR or extracted JavaScript/Electron tree | `analyze_javascript_application`, then `trace_application_feature`, `recover_javascript_sources` | Node + npm |
| Archive or package inventory (ZIP, APK, IPA, DMG) | `open_binary` with the local path, then `inspect_artifact` | nothing extra |
| Android APK code, classes, methods | `inspect_android_package`, then `search_android_classes`, `inspect_android_method` | JADX + full JDK |
| Managed .NET assembly | `inspect_managed_artifact`, then `inspect_managed_members` | nothing extra |
| Native executable or library | `open_binary`, then `binary_overview`, `analyze_function`, `procedure_pseudo_code`, `xrefs` | Hopper / Ghidra / IDA |
| Website open in a browser | `list_browser_targets`, then `inspect_web_page`, `capture_browser_scenario` | Chrome-family browser |
| Saved HAR / SAZ capture | `inspect_web_network_capture` | the capture file |
| Firmware image | `inspect_firmware_regions`; `extract_firmware` when extraction is requested | Binwalk / Unblob on Linux |
| Go, Rust, WASM, EVM, or SQLite artifact | `inspect_go_binary`, `inspect_rust_binary`, `inspect_wasm_artifact`, `inspect_evm_interface`, `inspect_sqlite_database` | varies; check `rea doctor` |
| Running process behavior | `capture_process_scenario` | Linux/macOS with a native PTY |

MCP tool names are snake_case; the CLI commands for the same work are
kebab-case (`analyze_javascript_application` ↔
`analyze-javascript-application`).

If the person says only "my app" with no name or path, ask which app before
searching for artifacts — never choose an example on their behalf.

## Working style

- State the question before the probe: what behavior are you trying to
  explain, and which artifact would prove it.
- Cite evidence: file/offset/symbol/module names from results. If a conclusion
  rests on inference rather than a returned artifact, say so.
- Surface REA's own limitations fields instead of smoothing them over.
- Keep the target's authorization scope: analyze the requested target, not
  whatever else is nearby on disk or the network.
- Do not repeat a rejected call without a changed input or a resolved
  blocker; each retry costs the person's time.
- If `rea` errors, update first (`rea update`, or rerun with `@latest`), then
  retry the same task before reporting a bug.
