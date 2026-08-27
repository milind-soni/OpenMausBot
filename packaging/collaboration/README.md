# Secure headless service templates

These templates intentionally contain paths and references only. They never
contain DingTalk credential values. Replace `/opt/openmausbot/current` and, in
the launchd template, every `__HOME__` placeholder before installation.

For the system unit, create `/etc/openmausbot-collaboration/dingtalk.json` as
root and set its owner and mode to `root:root` and `0600`. `LoadCredential`
copies that file into systemd's protected per-service credential directory.

For the user unit, install the credential with mode `0600` at
`~/.config/openmausbot-collaboration/dingtalk.json`. The service receives only
systemd's `%d/dingtalk.json` reference. Install the independent backup key and
private Owner alert relay endpoint at `backup-encryption.key` and
`owner-alert-webhook.url`, also mode `0600`.

For launchd, install the credential with mode `0600` at the absolute path
referenced by `OMB_DINGTALK_CREDENTIAL_FILE`. launchd has no equivalent of
`LoadCredential`; the service's secure credential-file provider rejects
symlinks, non-regular files, and files broader than `0600`.
Install the independent backup encryption key with mode `0600` at the path
referenced by `OMB_BACKUP_KEY_FILE`, and the private Owner alert relay endpoint
at the protected path referenced by `OMB_OWNER_ALERT_WEBHOOK_FILE`.

The shipped Linux units are also observe/plan-only. They set
`ProtectControlGroups=true` and never delegate `/sys/fs/cgroup` to the same
identity that launches untrusted Agent descendants. Execute mode requires a
separately privileged supervisor that owns only a dedicated subtree such as
`/sys/fs/cgroup/openmausbot`, reads the real boot generation from
`/proc/sys/kernel/random/boot_id`, keeps a stable verifier key outside Agent
reach, and proves a child cannot migrate after registration. Ticket 009 must
verify that privilege boundary on a real host before a separate execute unit
is enabled.

Before loading the launchd plist, create its Application Support and Logs
directories with mode `0700`; its `Umask` keeps newly created state and log
files private.

The macOS template is deliberately restricted to `observe_plan_only` and sets
`OMB_EXECUTION_ENABLED=0`. Do not enable execution on macOS: process groups are
not a strong containment boundary. Linux execution additionally requires the
separately verified cgroup v2 containment setup.
