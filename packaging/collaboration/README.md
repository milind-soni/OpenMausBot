# Secure headless service templates

These templates intentionally contain paths and references only. They never
contain DingTalk credential values. Replace `/opt/openmausbot/current` and, in
the launchd template, every `__HOME__` placeholder before installation.

For the system unit, create `/etc/openmausbot-collaboration/dingtalk.json` as
root and set its owner and mode to `root:root` and `0600`. `LoadCredential`
copies that file into systemd's protected per-service credential directory.

For the user unit, install the credential with mode `0600` at
`~/.config/openmausbot-collaboration/dingtalk.json`. The service receives only
systemd's `%d/dingtalk.json` reference. Install independent, stable random keys
at `containment-hmac.key` and `backup-encryption.key`, also mode `0600`.

For launchd, install the credential with mode `0600` at the absolute path
referenced by `OMB_DINGTALK_CREDENTIAL_FILE`. launchd has no equivalent of
`LoadCredential`; the service's secure credential-file provider rejects
symlinks, non-regular files, and files broader than `0600`.
Install the independent backup encryption key with mode `0600` at the path
referenced by `OMB_BACKUP_KEY_FILE`.

Before enabling either Linux unit, the operator must provision and delegate a
real cgroup v2 subtree at `/sys/fs/cgroup/openmausbot` to the service identity.
The service is deliberately scoped to that subtree and must never receive the
whole `/sys/fs/cgroup` tree. `/proc/sys/kernel/random/boot_id` supplies the real
boot generation. The stable containment verifier key must survive service
restarts but remain separate from the ledger and backups. These host controls
require real-environment verification before execute mode is enabled.

Before loading the launchd plist, create its Application Support and Logs
directories with mode `0700`; its `Umask` keeps newly created state and log
files private.

The macOS template is deliberately restricted to `observe_plan_only` and sets
`OMB_EXECUTION_ENABLED=0`. Do not enable execution on macOS: process groups are
not a strong containment boundary. Linux execution additionally requires the
separately verified cgroup v2 containment setup.
