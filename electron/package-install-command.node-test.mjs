// The command handed to a Linux user is the whole deliverable of the .deb
// update path: the app deliberately does not run it. If it is wrong, the user
// is stuck with a downloaded package and no way to finish.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  shellQuote,
  stagedInstallFile,
} from "./package-install-command.mjs";

test("the Ubuntu command resolves dependencies", () => {
  const command = packageInstallCommand("deb", "/home/u/.cache/astra-updater/pending/x.deb");

  assert.equal(
    command,
    "sudo apt-get install -y '/home/u/.cache/astra-updater/pending/x.deb'",
  );
  // `dpkg -i` is what electron-updater ran, and it installs nothing when a
  // release adds a dependency. Ubuntu also satisfies ours through virtual
  // Provides, which only apt resolves.
  assert.doesNotMatch(command, /dpkg/);
});

test("every hand-off package type has a command", () => {
  for (const packageType of HAND_OFF_PACKAGE_TYPES) {
    assert.match(packageInstallCommand(packageType, "/tmp/pkg"), /^sudo \S+/);
  }
  assert.throws(() => packageInstallCommand("snap", "/tmp/pkg"), /No install command/);
});

test("inherited Object names are not install commands", () => {
  for (const name of ["toString", "constructor", "__proto__"]) {
    assert.throws(() => packageInstallCommand(name, "/tmp/pkg"), /No install command/);
  }
});

test("a staged path that is gone is not used", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-staged-"));
  try {
    const present = join(workspace, "Astra.deb");
    writeFileSync(present, "x");
    const missing = join(workspace, "gone.deb");

    assert.equal(stagedInstallFile([present]), present);
    assert.equal(stagedInstallFile([missing, present]), present);
    assert.equal(stagedInstallFile([missing]), undefined);
    assert.equal(stagedInstallFile([]), undefined);
    assert.equal(stagedInstallFile(undefined), undefined);
    assert.throws(
      () => packageInstallCommand("deb", stagedInstallFile([missing])),
      /no longer available/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a missing download is reported instead of building a broken command", () => {
  assert.throws(() => packageInstallCommand("deb", undefined), /no longer available/);
  assert.throws(() => packageInstallCommand("deb", ""), /no longer available/);
});

// These two proofs use a POSIX shell as the referee: only the shell itself
// can say what the quoting parses into. Windows CI has no /bin/sh, and no
// Windows user is ever handed this command.
const posixShell = existsSync("/bin/sh") ? false : "needs /bin/sh";

// The path lives under $HOME, so it can carry whatever a directory name can.
// A mis-quoted command would either fail to install or run something else.
test("the quoted path survives a shell round-trip", { skip: posixShell }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-quote-"));
  try {
    for (const name of ["plain.deb", "with space.deb", "o'brien.deb", "a;b&c.deb", "$(echo bad).deb"]) {
      const file = join(workspace, name);
      writeFileSync(file, "x");
      // `printf %s` echoes exactly one argument: what the shell parsed out of
      // our quoting has to be the path we meant, byte for byte.
      const parsed = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(file)}`], {
        encoding: "utf8",
      });
      assert.equal(parsed, file, `quoting mangled ${name}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the whole command parses into the arguments apt-get would receive", { skip: posixShell }, () => {
  const file = "/home/o'brien/.cache/astra-updater/pending/Astra-0.1.44-amd64.deb";
  const command = packageInstallCommand("deb", file);

  // Replace the privileged verb with a printer, then confirm the shell hands
  // it exactly the flags and the one path.
  const printed = execFileSync(
    "/bin/sh",
    ["-c", `set -- ${command.replace("sudo apt-get", "")}; for a in "$@"; do printf '%s\\n' "$a"; done`],
    { encoding: "utf8" },
  );

  assert.deepEqual(printed.split("\n").filter(Boolean), ["install", "-y", file]);
});

// The routing decides everything: a .deb that resolves to "AppImage" would
// quit and let electron-updater run dpkg under the live app, and an AppImage
// that resolves to "deb" would offer a command instead of updating itself.
test("the package marker decides the install path", () => {
  const marker = (declared) => (file) => (file.endsWith("package-type") ? declared : null);

  assert.equal(
    linuxPackageType({ platform: "linux", resourcesPath: "/opt/app/resources", readMarker: marker("deb\n") }),
    "deb",
  );
  // An AppImage ships no marker, so the env probe is what identifies it.
  assert.equal(
    linuxPackageType({
      platform: "linux",
      resourcesPath: "/tmp/squashfs-root/resources",
      appImage: "/home/u/Astra.AppImage",
      readMarker: marker(null),
    }),
    "AppImage",
  );
  // The marker wins, matching electron-updater's own precedence. If packaging
  // ever wrote it into the shared tree before the AppImage was sealed, both
  // would say "deb" — which is why verify-linux-package.mjs pins it.
  assert.equal(
    linuxPackageType({
      platform: "linux",
      resourcesPath: "/opt/app/resources",
      appImage: "/home/u/Astra.AppImage",
      readMarker: marker("deb"),
    }),
    "deb",
  );
});

test("a build with nothing to identify it keeps the restart path", () => {
  const none = () => null;

  assert.equal(
    linuxPackageType({ platform: "linux", resourcesPath: "/opt/app/resources", appImage: undefined, readMarker: none }),
    null,
  );
  // No resourcesPath means no marker to read — an explicit answer, not one
  // reached by throwing into the fallback.
  assert.equal(linuxPackageType({ platform: "linux", resourcesPath: undefined, readMarker: none }), null);
  assert.equal(
    linuxPackageType({ platform: "linux", resourcesPath: undefined, appImage: "/a.AppImage", readMarker: none }),
    "AppImage",
  );
  assert.equal(linuxPackageType({ platform: "darwin", readMarker: none }), null);
  assert.equal(linuxPackageType({ platform: "win32", readMarker: none }), null);
  // An empty or unreadable marker must not become a package type.
  assert.equal(
    linuxPackageType({
      platform: "linux",
      resourcesPath: "/opt/app/resources",
      appImage: undefined,
      readMarker: () => "  \n",
    }),
    null,
  );
  assert.equal(
    linuxPackageType({
      platform: "linux",
      resourcesPath: "/opt/app/resources",
      appImage: undefined,
      readMarker: () => {
        throw new Error("EACCES");
      },
    }),
    null,
  );
});
