import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(root, name), "utf8");

describe("secure collaboration service-manager templates", () => {
  for (const unit of ["openmausbot-collaboration.service", "openmausbot-collaboration-user.service"]) {
    it(`${unit} is restartable, bounded, hardened, and credential-reference only`, () => {
      const source = read(unit);
      expect(source).toContain("WorkingDirectory=/opt/openmausbot/current");
      expect(source).toContain("dist-server/collaboration-headless.js");
      expect(source).toContain("Restart=on-failure");
      expect(source).toContain("KillSignal=SIGTERM");
      expect(source).toMatch(/TimeoutStopSec=\d+s/);
      expect(source).toContain("UMask=0077");
      expect(source).toContain("NoNewPrivileges=true");
      expect(source).toContain("ProtectSystem=strict");
      expect(source).toContain("Delegate=yes");
      expect(source).toContain("ProtectControlGroups=false");
      expect(source).toContain("CapabilityBoundingSet=\n");
      expect(source).toMatch(/LoadCredential=dingtalk\.json:/);
      expect(source).toMatch(/LoadCredential=containment-hmac\.key:/);
      expect(source).toMatch(/LoadCredential=backup-encryption\.key:/);
      expect(source).toContain("OMB_DINGTALK_CREDENTIAL_FILE=%d/dingtalk.json");
      expect(source).toContain("OMB_CONTAINMENT_VERIFIER_KEY_FILE=%d/containment-hmac.key");
      expect(source).toContain("OMB_BACKUP_KEY_FILE=%d/backup-encryption.key");
      expect(source).toContain("OMB_CGROUP_ROOT=/sys/fs/cgroup/openmausbot");
      expect(source).not.toContain("OMB_CGROUP_ROOT=/sys/fs/cgroup\n");
      expect(source).not.toContain("ReadWritePaths=/sys/fs/cgroup\n");
      expect(source).toContain("OMB_BOOT_GENERATION_FILE=/proc/sys/kernel/random/boot_id");
      expect(source).toMatch(/(?:StateDirectory|OMB_DATA_DIR)=.*openmausbot-collaboration/);
      expect(source).toMatch(/(?:LogsDirectory|StandardOutput)=.*openmausbot-collaboration/);
      expect(source).not.toContain("OMB_DINGTALK_CLIENT_SECRET");
      expect(source).not.toContain("OMB_DINGTALK_CLIENT_ID");
    });
  }

  it("the system unit runs with a dedicated unprivileged identity", () => {
    const source = read("openmausbot-collaboration.service");
    expect(source).toContain("User=openmausbot");
    expect(source).toContain("Group=openmausbot");
    expect(source).toContain("ProtectHome=true");
    expect(source).toContain("WantedBy=multi-user.target");
  });

  it("the launchd template restarts failures, uses private paths, and fails execution closed", () => {
    const source = read("com.openmausbot.collaboration.plist");
    expect(source).toContain("<key>WorkingDirectory</key>");
    expect(source).toContain("/opt/openmausbot/current");
    expect(source).toContain("dist-server/collaboration-headless.js");
    expect(source).toMatch(/<key>KeepAlive<\/key>[\s\S]*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(source).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
    expect(source).toContain("__HOME__/Library/Logs/OpenMausBot/");
    expect(source).toContain("__HOME__/Library/Application Support/OpenMausBot/Collaboration");
    expect(source).toMatch(/<key>OMB_EXECUTION_MODE<\/key>\s*<string>observe_plan_only<\/string>/);
    expect(source).toMatch(/<key>OMB_EXECUTION_ENABLED<\/key>\s*<string>0<\/string>/);
    expect(source).toMatch(
      /<key>OMB_DINGTALK_CREDENTIAL_FILE<\/key>\s*<string>[^<]+\/credentials\/dingtalk\.json<\/string>/,
    );
    expect(source).toMatch(
      /<key>OMB_BACKUP_KEY_FILE<\/key>\s*<string>[^<]+\/credentials\/backup-encryption\.key<\/string>/,
    );
    expect(source).not.toContain("OMB_CGROUP_ROOT");
    expect(source).not.toContain("OMB_CONTAINMENT_VERIFIER_KEY_FILE");
    expect(source).not.toContain("OMB_DINGTALK_CLIENT_SECRET");
    expect(source).not.toContain("OMB_DINGTALK_CLIENT_ID");
  });

  it("documents strict credential modes and the macOS containment boundary", () => {
    const source = read("README.md");
    expect(source).toMatch(/credential.+mode `0600`/s);
    expect(source).toMatch(/process groups are\s+not a strong containment boundary/);
    expect(source).toContain("Do not enable execution on macOS");
    expect(source).toContain("/proc/sys/kernel/random/boot_id");
    expect(source).toContain("/sys/fs/cgroup/openmausbot");
    expect(source).toContain("must never receive the");
  });
});
