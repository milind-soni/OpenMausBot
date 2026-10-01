# Local VM stop and resume

Run the focused lifecycle checks in disposable homes:

```sh
pnpm exec vitest run server/container-computer.test.ts server/local-vm-stop-reason.test.ts server/local-vm-idle.test.ts server/group-local-vm.e2e.test.ts server/routes/desktop-viewer.test.ts src/components/LocalComputerSection.test.ts src/components/ComputerPanel.test.ts src/components/ComputerPanel.i18n.test.ts
node --experimental-strip-types scripts/verify-local-vm-resume.ts
```

The browser recipe uses `launchVerificationServer`, the fake engine and a
private browser profile. It mounts the real ComputerPanel with synthetic
desktop transport; it never contacts the host Docker daemon. Set
`OMB_AGENT_BROWSER_PATH` and `AGENT_BROWSER_EXECUTABLE_PATH` to reuse installed
tools. Its receipt prints the isolated server URL and persistent log path;
screenshots remain beside that log unless `OMB_UI_EVIDENCE_DIR` selects another
directory. Set `OMB_UI_RECORD=1` with ffmpeg on PATH to also save `resume.mp4`.
The readiness assertion waits for two actual status reads while the desktop is
held unready; it uses no fixed delay.

The browser check proves an existing shared VM shows “stopped” and an idle
explanation, Start issues exactly one request, the button stays disabled and
busy after that request returns while Cua is still warming up, and the ready
desktop replaces the empty state without a remove or recreate request. It also
checks that Settings offers Start for a stopped VM and waits for readiness.

The server fixture runs the actual HTTP routes and idle timer, replacing only
the container boundary and shortening the idle window through a test-only
loader. It verifies idle shutdown stops without deleting, the stop reason
survives a server restart, shared and per-bot starts work, and an Auto turn
resumes an existing desktop even when the per-bot capacity limit is reached.
The reason record matches the runtime's finish timestamp; a later external
stop or an unknown timestamp gets the neutral stopped explanation.

2026-10-01, Docker on Linux: a separately created, disposable container using
the pinned driver-0.20.0-v5 image passed two stop/start cycles. Each cycle
passed the production readiness probe (driver version, health report, and
complete screenshot) and preserved marker files under `/home/cua` and `/opt`.
Two additional abrupt-shutdown cycles used `docker kill --signal KILL` and
confirmed with `docker cp` that `/tmp/.X1-lock` remained in the stopped
container before invoking production Start. Both resumes passed the same
readiness and marker checks. The pinned image's `/usr/local/bin/start-vnc.sh`
removes `/tmp/.X1-lock` and `/tmp/.X11-unix/X1` before launching VNC, addressing
the stale-lock concern behind the earlier blanket refusal to resume.
The fixtures used empty temporary workspaces and were removed afterward.
No image rebuild was required. That live acceptance does not cover Podman,
Apple container, native iOS, or persistence across image replacement.

## Review evidence

The [before screenshot](evidence/local-vm-resume/before.png) was captured with
unchanged production code at upstream
`9f0c33d00fc490491bf794704fd192046d2f31eb`, using the same disposable fixture
and an inspected stopped-VM response. The fixture's status text reflects the
baseline server's refusal to resume. Only the fixture transport was copied
into that checkout.

The [stopped](evidence/local-vm-resume/stopped.png),
[starting](evidence/local-vm-resume/starting.png) and
[ready](evidence/local-vm-resume/ready.png) screenshots show the changed panel.
The [startup video](evidence/local-vm-resume/resume.mp4) records Start, two
readiness polls with the button disabled, then the ready preview. Screenshots
capture the real panel element; video hides only the fixture controls.
The desktop preview is explicitly synthetic and does not claim a live remote
session or native mobile acceptance.
