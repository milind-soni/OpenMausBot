# Firefox sandbox in Podman Local VMs

Fixes #853. Podman's default seccomp policy gates `chroot` on `SYS_CHROOT`;
Firefox uses this syscall while establishing its own Linux sandbox. Managed
Podman desktops now retain that capability alongside `SETUID` and `SETGID`.
Effective and bounding capability validation requires the same exact set.
Docker and VPS policies remain unchanged.

Existing Podman desktops with the old capability set require recreation through
the normal Local VM lifecycle. Retain the workspace bind mount; do not delete
user files or silently recreate a busy desktop. Privileged mode and unconfined
security profiles are not required or accepted by this repair.

An old container is reported as unsafe/not ready with a request to recreate it;
status checks and chat turns do not automatically replace it. Once its current
work has finished, save any needed files under `/home/cua/workspace`. For a
per-bot desktop, use that bot's Computer panel to recreate it and confirm the
existing prompt. For the shared desktop, use **Delete and recreate** in the
Local VM settings. The existing remove/run lifecycle retains the same workspace
bind mount. Files elsewhere in the container, including Firefox profiles outside
the workspace, are discarded; copy anything needed into the workspace first.
Restarting the old container does not add the new capability.

## Isolated before/after acceptance

Set `OMB_VERIFY_PODMAN` and `OMB_VERIFY_MACHINE` explicitly, with the managed
image already prepared on that test engine, then run:

```sh
node --experimental-strip-types scripts/verify-podman-firefox.ts
```

The script creates disposable desktops and engine-host temporary workspaces.
It compares identical generated arguments with and without `SYS_CHROOT`, runs
Firefox headlessly with a fresh profile and validates PNG bytes. The patched
container also runs `scripts/testing/firefox-sandbox.py` with Python's standard
library and Firefox's bundled Marionette server on guest loopback; no debug
port is published. It reads the [about:support sandbox fields](https://searchfox.org/firefox-main/source/toolkit/content/aboutSupport.js)
and requires a positive effective content-process sandbox level. A separate
fresh-profile control sets `MOZ_DISABLE_CONTENT_SANDBOX=1`, requires level zero,
and must fail the same enabled-sandbox assertion. Both levels are recorded in
`receipt.json`. The script cleans up only
the containers and workspaces it created. Logs and receipt remain under
`.omb-scratch/firefox` (override with `OMB_VERIFY_OUTPUT`).

2026-09-06: Windows/WSL2 Linux x86_64, rootless Podman 5.8.3, managed driver
0.20.0-v4 image. Baseline: `chroot: EPERM`, timeout exit 124, no PNG. Patched:
Firefox exit 0, valid PNG, no `chroot: EPERM`. Firefox reported configured/effective content sandbox levels 6/6; the disabled
control reported 6/0 and was rejected by the enabled-sandbox assertion.
Related container/VPS tests: 71 passed; server TypeScript checking passed.

This is browser startup/rendering evidence, not an interactive-input test.
Native Linux, ARM64, SELinux enforcing and other runtime versions were not
certified by this run; the full repository suite was not repeated.
