import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const env = require("./environments.cjs");

test("origins are bare http(s) origins, nothing else", () => {
  assert.equal(env.normalizeOrigin("https://mini.tail1234.ts.net/pair#code=x"), "https://mini.tail1234.ts.net");
  assert.equal(env.normalizeOrigin("http://192.168.1.20:8799"), "http://192.168.1.20:8799");
  assert.equal(env.normalizeOrigin("HTTPS://Mini.Example:443/"), "https://mini.example");
  for (const bad of ["ftp://x", "mini.example", "https://user:pw@host", "", 42, null]) assert.equal(env.normalizeOrigin(bad), null, String(bad));
});

test("a pairing link keeps its code in the hash; a code anywhere else is refused", () => {
  assert.deepEqual(env.parsePairingLink("https://mini.example/pair#code=ABCD-EFGH-JKLM"), {
    origin: "https://mini.example",
    code: "ABCD-EFGH-JKLM",
    url: "https://mini.example/pair#code=ABCD-EFGH-JKLM",
  });
  assert.deepEqual(env.parsePairingLink("  https://mini.example  "), { origin: "https://mini.example", code: null, url: "https://mini.example" });
  assert.equal(env.parsePairingLink("https://mini.example/?code=ABCD"), null);
  assert.equal(env.parsePairingLink("not a link"), null);
});

test("self-hosted pairing supports custom HTTPS and Cloudflare names without Tailscale", () => {
  for (const origin of ["https://bots.example.com", "https://example.trycloudflare.com", "https://c-example.openmausbot.com"]) {
    const link = `${origin}/pair#code=ABCD-EFGH-JKLM`;
    assert.deepEqual(env.parsePairingLink(link), {
      origin, code: "ABCD-EFGH-JKLM", url: link,
    });
    const saved = env.withEnvironment({ environments: [], activeId: "local" }, { origin, name: "My server" }, () => "fixture");
    assert.equal(saved.environments[0].origin, origin);
    assert.ok(!env.serializeEnvironments(saved).includes("ABCD"), "pairing codes must not enter saved server records");
  }
});

test("persisted state parses defensively and never resurrects Local as a remote", () => {
  const parsed = env.parseEnvironments(
    JSON.stringify({
      environments: [
        { id: "a1", name: "  Cab   mini ", origin: "https://mini.example/" },
        { id: "local", name: "sneaky", origin: "https://evil.example" },
        { id: "dup", name: "again", origin: "https://mini.example" },
        { id: "b2", origin: "http://10.0.0.5:8799" },
        { id: "bad id!", origin: "https://x.example" },
        { id: "c3", origin: "ftp://nope" },
      ],
      activeId: "b2",
    }),
  );
  assert.deepEqual(parsed, {
    environments: [
      { id: "a1", kind: "remote", name: "Cab mini", origin: "https://mini.example" },
      { id: "b2", kind: "remote", name: "10.0.0.5:8799", origin: "http://10.0.0.5:8799" },
    ],
    activeId: "b2",
  });
  assert.deepEqual(env.parseEnvironments("{not json"), { environments: [], activeId: "local" });
  assert.deepEqual(env.parseEnvironments({ environments: [], activeId: "ghost" }), { environments: [], activeId: "local" });
  assert.deepEqual(env.parseEnvironments(env.serializeEnvironments(parsed)), parsed);
});

test("adding the same server twice updates the name instead of duplicating; forgetting the active one falls back to Local", () => {
  let ids = 0;
  const makeId = () => `id${++ids}`;
  let state = { environments: [], activeId: "local" };
  state = env.withEnvironment(state, { origin: "https://mini.example/pair#code=X", name: "" }, makeId);
  state = env.withEnvironment(state, { origin: "https://mini.example", name: "Cab mini" }, makeId);
  state = env.withEnvironment(state, { origin: "nonsense" }, makeId);
  assert.deepEqual(state.environments, [{ id: "id1", kind: "remote", name: "Cab mini", origin: "https://mini.example" }]);
  state = env.withActive(state, "id1");
  assert.equal(env.activeEnvironment(state)?.origin, "https://mini.example");
  assert.equal(env.withActive(state, "nope"), state);
  assert.deepEqual([...env.allowedOrigins(state, "http://127.0.0.1:8799")], ["http://127.0.0.1:8799", "https://mini.example"]);
  state = env.withoutEnvironment(state, "id1");
  assert.deepEqual(state, { environments: [], activeId: "local" });
  assert.equal(env.activeEnvironment(state), null);
});

test("hosted workspace input accepts addresses and keeps valid codes only in the fragment", () => {
  for (const address of ["bots.company.com", " https://bots.company.com/ ", "https://bots.company.com:8443"]) {
    const parsed = env.parseHostedWorkspaceLink(address);
    assert.ok(parsed);
    assert.equal(parsed.code, null);
    assert.equal(parsed.url, parsed.origin);
  }
  const parsed = env.parseHostedWorkspaceLink("https://bots.company.com/pair#code=ABCD%2DEFGH%2DJKLM");
  assert.equal(parsed.code, "ABCD-EFGH-JKLM");
  assert.ok(parsed.url.includes("#code="));
  assert.ok(!parsed.origin.includes("ABCD"));
  assert.ok(env.parseHostedWorkspaceLink("http://127.0.0.1:19999"));
  for (const bad of ["", null, "ABCD-EFGH-JKLM", "https:example.com", "http://cloud.example.com", "https://a.example/other", "https://a.example/?code=SECRET", "https://a.example/pair#code=%", "https://a.example/pair#code=", "https://a.example/pair#code=%20", "https://user:password@a.example", "https://a.example\\@b.example", "javascript:alert(1)"]) {
    assert.equal(env.parseHostedWorkspaceLink(bad), null, String(bad));
  }
  assert.equal(env.parsePairingLink("https://a.example/pair#code=%"), null);
});

test("workspace shell exposes only current identity and rejects subframes and unrelated windows", () => {
  const state = { environments: [{ id: "cloud", name: "Acme", origin: "https://acme.example" }], activeId: "cloud" };
  assert.deepEqual(env.workspaceSummary(state), { local: false, name: "Acme", origin: "https://acme.example" });
  assert.deepEqual(env.workspaceSummary({ ...state, activeId: "local" }), { local: true, name: "This computer" });
  const local = "http://127.0.0.1:18799";
  const contents = { mainFrame: { url: "https://acme.example/" } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), true);
  assert.equal(env.workspaceSenderAllowed({ ...event, sender: {} }, contents, state, local), false);
  assert.equal(env.workspaceSenderAllowed({ ...event, senderFrame: { url: "https://acme.example/frame" } }, contents, state, local), false);
  contents.mainFrame.url = "https://untrusted.example";
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), false);
  contents.mainFrame.url = local;
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), false);
  assert.equal(env.workspaceSenderAllowed(event, contents, { ...state, activeId: "local" }, local), true);
});

test("renderer links and redirects cannot switch onto the local or another saved workspace", () => {
  const local = "http://127.0.0.1:18799";
  const state = { environments: [
    { id: "cloud", name: "Acme", origin: "https://acme.example" },
    { id: "other", name: "Other", origin: "https://other.example" },
  ], activeId: "cloud" };
  assert.equal(env.workspaceNavigationAllowed("https://acme.example/pair#code=ABCD-EFGH-JKLM", state, local), true);
  for (const url of [local, "https://other.example", "https://unknown.example", "javascript:void(0)"]) {
    assert.equal(env.workspaceNavigationAllowed(url, state, local), false);
  }
  const switched = env.withActive(state, "local");
  assert.equal(env.workspaceNavigationAllowed(`${local}/?desktop-settings=workspaces`, switched, local), true);
  assert.equal(env.workspaceNavigationAllowed("https://acme.example", switched, local), false);
});

test("native workspace choices use saved IDs and connect opens settings without changing state", () => {
  const state = { environments: [{ id: "cloud", name: "Acme", origin: "https://acme.example" }], activeId: "cloud" };
  const calls = [];
  const items = env.workspaceMenuTemplate(state, { onSwitch: (id) => calls.push(["switch", id]), onConnect: () => calls.push(["settings"]), onForget: (id) => calls.push(["forget", id]) });
  assert.equal(items.find((item) => item.id === "workspace-cloud").checked, true);
  // The menu id stays "workspace-connect"; the label uses the product word.
  assert.equal(items.find((item) => item.id === "workspace-connect").label, "Connect to a server…");
  items.find((item) => item.id === "workspace-local").click();
  items.find((item) => item.id === "workspace-connect").click();
  items.find((item) => item.id === "workspace-forget").click();
  assert.deepEqual(calls, [["switch", "local"], ["settings"], ["forget", "cloud"]]);
  assert.equal(state.activeId, "cloud");
});

test("Add a Cloud… sits just under the saved servers only where main offers it, and My Cloud's line can say Always on", () => {
  const state = { environments: [{ id: "cloud", name: "My Cloud", origin: "https://omb-u-1.fly.dev" }, { id: "office", name: "Office", origin: "https://office.example" }], activeId: "local" };
  const calls = [];
  const base = { onSwitch: (id) => calls.push(["switch", id]), onConnect: () => calls.push(["settings"]), onForget: () => {} };
  // Without onAddCloud (a dev build, companion mode, a branded build): today's menu, hosts as sublabels.
  const plain = env.workspaceMenuTemplate(state, base);
  assert.equal(plain.some(item => item.id === "workspace-add-cloud"), false);
  assert.deepEqual(plain.filter(item => item.sublabel).map(item => item.sublabel), ["omb-u-1.fly.dev", "office.example"]);
  const items = env.workspaceMenuTemplate(state, { ...base, onAddCloud: () => calls.push(["add-cloud"]), sublabels: { cloud: "Free trial until 15 Oct" } });
  assert.deepEqual(items.map(item => item.id ?? item.type), ["workspace-local", "workspace-cloud", "workspace-office", "workspace-add-cloud", "separator", "workspace-connect"]);
  const add = items.find(item => item.id === "workspace-add-cloud");
  assert.deepEqual([add.label, add.sublabel, add.type], ["Add a Cloud…", "Keeps your bots running 24/7", undefined]);
  add.click();
  assert.deepEqual(items.find(item => item.id === "workspace-cloud").sublabel, "Free trial until 15 Oct");
  assert.deepEqual(items.find(item => item.id === "workspace-office").sublabel, "office.example");
  assert.deepEqual(calls, [["add-cloud"]]);
});

test("native window identity distinguishes hosted HTML, companion data, and the local workspace", () => {
  const state = { environments: [{ id: "old", name: "Old team", origin: "https://old.example" }], activeId: "old" };
  assert.equal(env.workspaceWindowTitle(state), "OpenMausBot — Hosted: Old team (old.example)");
  assert.equal(env.workspaceWindowTitle(state, { serverName: "Office", endpoint: "https://c-office.openmausbot.com" }), "OpenMausBot — Connected to: Office (c-office.openmausbot.com)");
  assert.equal(env.workspaceWindowTitle(env.withActive(state, "local")), "OpenMausBot");
});

test("a version 1 file parses as all-remote with kind stamped and activeId preserved, and serializes back as version 2", () => {
  const v1 = JSON.stringify({
    version: 1,
    environments: [{ id: "a1", name: "Cab mini", origin: "https://mini.example" }],
    activeId: "a1",
  });
  const parsed = env.parseEnvironments(v1);
  assert.deepEqual(parsed, {
    environments: [{ id: "a1", kind: "remote", name: "Cab mini", origin: "https://mini.example" }],
    activeId: "a1",
  });
  assert.equal(JSON.parse(env.serializeEnvironments(parsed)).version, 2);
  assert.deepEqual(env.parseEnvironments(env.serializeEnvironments(parsed)), parsed);
});

test("version 2 keeps locals with an absolute dataDir and drops relative, dir-less and unknown-version ones", () => {
  const parsed = env.parseEnvironments(JSON.stringify({
    version: 2,
    environments: [
      { id: "l1", kind: "local", name: "APRS Chat", dataDir: "/Users/me/.openmausbot-aprs" },
      { id: "l2", kind: "local", name: "relative", dataDir: "bots/relative" },
      { id: "l3", kind: "local", name: "no dir at all" },
      { id: "r1", kind: "remote", name: "Office", origin: "https://box.example" },
      { id: "l4", kind: "local", name: "same dir again", dataDir: "/Users/me/.openmausbot-aprs" },
    ],
    activeId: "l1",
  }));
  assert.deepEqual(parsed, {
    environments: [
      { id: "l1", kind: "local", name: "APRS Chat", dataDir: "/Users/me/.openmausbot-aprs" },
      { id: "r1", kind: "remote", name: "Office", origin: "https://box.example" },
    ],
    activeId: "l1",
  });
  const future = { version: 3, environments: [{ id: "a1", kind: "remote", name: "x", origin: "https://x.example" }], activeId: "a1" };
  assert.deepEqual(env.parseEnvironments(future), { environments: [], activeId: "local" });
});

test("withLocalEnvironment registers absolute, non-default, non-nested directories only", () => {
  const DEFAULT = "/Users/me/.openmausbot";
  const added = env.withLocalEnvironment({ environments: [], activeId: "local" }, { name: "APRS Chat", dataDir: "/Users/me/.openmausbot-aprs" }, () => "id1", DEFAULT);
  assert.equal(added.ok, true);
  assert.deepEqual(added.state.environments, [{ id: "id1", kind: "local", name: "APRS Chat", dataDir: "/Users/me/.openmausbot-aprs" }]);
  assert.equal(added.state.activeId, "local");
  const error = (name, dataDir) => env.withLocalEnvironment(added.state, { name, dataDir }, () => "unused", DEFAULT).error;
  assert.equal(error("APRS", "bots/relative"), "path");
  assert.equal(error("   ", "/Users/me/.openmausbot-x"), "name");
  assert.equal(error("x".repeat(61), "/Users/me/.openmausbot-x"), "name");
  assert.equal(error("Same as default", DEFAULT), "nested");
  assert.equal(error("Inside default", `${DEFAULT}/nested`), "nested");
  assert.equal(error("Same as entry", "/Users/me/.openmausbot-aprs"), "duplicate");
  assert.equal(error("Same entry with a slash", "/Users/me/.openmausbot-aprs/"), "duplicate");
  assert.equal(error("Inside the entry", "/Users/me/.openmausbot-aprs/sub"), "nested");
  assert.equal(error("Almost a sibling", "/Users/me/.openmausbot-aprsx"), undefined);
});

test("activeLocalDataDir reports only an active local environment's directory", () => {
  const DEFAULT = "/Users/me/.openmausbot";
  const state = {
    environments: [
      { id: "l1", kind: "local", name: "APRS", dataDir: "/Users/me/.openmausbot-aprs" },
      { id: "r1", kind: "remote", name: "Office", origin: "https://box.example" },
    ],
    activeId: "l1",
  };
  assert.equal(env.activeLocalDataDir(state, DEFAULT), "/Users/me/.openmausbot-aprs");
  assert.equal(env.activeLocalDataDir({ ...state, activeId: "local" }, DEFAULT), null);
  assert.equal(env.activeLocalDataDir({ ...state, activeId: "r1" }, DEFAULT), null);
});

test("startupEnvironmentDir boots on the active local dir and falls back to the default", () => {
  const DEFAULT = "/Users/me/.openmausbot";
  const state = {
    environments: [
      { id: "l1", kind: "local", name: "APRS", dataDir: "/Users/me/.openmausbot-aprs" },
      { id: "r1", kind: "remote", name: "Office", origin: "https://box.example" },
    ],
    activeId: "l1",
  };
  assert.equal(env.startupEnvironmentDir(state, DEFAULT), "/Users/me/.openmausbot-aprs");
  assert.equal(env.startupEnvironmentDir({ ...state, activeId: "r1" }, DEFAULT), DEFAULT);
  assert.equal(env.startupEnvironmentDir({ environments: [], activeId: "local" }, DEFAULT), DEFAULT);
});

test("bootEnvironmentDir refuses to boot onto a missing named env dir — the default dir instead, flagged", () => {
  const DEFAULT = "/Users/me/.openmausbot";
  const gone = { environments: [{ id: "l1", kind: "local", name: "APRS", dataDir: "/Volumes/gone/.openmausbot-aprs", missing: true }], activeId: "l1" };
  assert.deepEqual(env.bootEnvironmentDir(gone, DEFAULT), { dataDir: DEFAULT, fellBack: true, missingDir: "/Volumes/gone/.openmausbot-aprs" });
  const present = { environments: [{ ...gone.environments[0], missing: false }], activeId: "l1" };
  assert.deepEqual(env.bootEnvironmentDir(present, DEFAULT), { dataDir: "/Volumes/gone/.openmausbot-aprs", fellBack: false, missingDir: null });
  // The default dir is never a fallback: a first boot is allowed to create it.
  assert.deepEqual(env.bootEnvironmentDir({ environments: [], activeId: "local" }, DEFAULT), { dataDir: DEFAULT, fellBack: false, missingDir: null });
  const remote = { environments: [{ id: "r1", kind: "remote", name: "Office", origin: "https://box.example", missing: false }], activeId: "r1" };
  assert.deepEqual(env.bootEnvironmentDir(remote, DEFAULT), { dataDir: DEFAULT, fellBack: false, missingDir: null });
});

test("data dirs are absolute in POSIX, drive-letter and UNC shape; relative and drive-relative are refused", () => {
  const kept = (dataDir) => env.parseEnvironments(JSON.stringify({
    version: 2,
    environments: [{ id: "l1", kind: "local", name: "n", dataDir }],
    activeId: "local",
  })).environments.length;
  for (const good of ["/Users/me/.openmausbot-aprs", "C:\\Users\\me\\.openmausbot-aprs", "D:/envs/aprs", "\\\\nas\\share\\.openmausbot-x"]) {
    assert.equal(kept(good), 1, good);
  }
  for (const bad of ["bots/relative", "C:bots", "~/.openmausbot-x", "\\single\\backslash", "./x", ""]) {
    assert.equal(kept(bad), 0, bad);
  }
});

test("withLocalEnvironment rejects a candidate that contains a registered local dir, accepts siblings", () => {
  const DEFAULT = "/Users/me/.openmausbot";
  const added = env.withLocalEnvironment({ environments: [], activeId: "local" }, { name: "APRS", dataDir: "/Users/me/bots/aprs" }, () => "id1", DEFAULT);
  assert.equal(added.ok, true);
  const error = (dataDir) => env.withLocalEnvironment(added.state, { name: "x", dataDir }, () => "unused", DEFAULT).error;
  assert.equal(error("/Users/me/bots"), "nested");
  assert.equal(error("/Users/me"), "nested");
  assert.equal(error("/"), "nested");
  // Siblings share a parent but neither contains the other.
  assert.equal(error("/Users/me/bots/other"), undefined);
  assert.equal(error("/Users/me/botsx"), undefined);
  const sibling = env.withLocalEnvironment(added.state, { name: "Other", dataDir: "/Users/me/bots/other" }, () => "id2", DEFAULT);
  assert.equal(sibling.ok, true);
});

test("a named local environment is this computer with its path, and gets its own menu row", () => {
  const localEntry = { id: "l1", kind: "local", name: "APRS Chat", dataDir: "/Users/me/.openmausbot-aprs" };
  const state = { environments: [localEntry, { id: "r1", kind: "remote", name: "Office", origin: "https://box.example" }], activeId: "l1" };
  assert.deepEqual(env.workspaceSummary(state), { local: true, name: "APRS Chat", localPath: "/Users/me/.openmausbot-aprs", missing: false });
  assert.deepEqual(env.workspaceSummary({ ...state, environments: [{ ...localEntry, missing: true }, ...state.environments.slice(1)] }),
    { local: true, name: "APRS Chat", localPath: "/Users/me/.openmausbot-aprs", missing: true });
  assert.deepEqual(env.workspaceSummary({ ...state, activeId: "local" }), { local: true, name: "This computer" });
  assert.deepEqual(env.workspaceSummary({ ...state, activeId: "r1" }), { local: false, name: "Office", origin: "https://box.example" });
  const calls = [];
  const items = env.workspaceMenuTemplate(state, { onSwitch: (id) => calls.push(id), onConnect: () => {}, onForget: () => {} });
  assert.equal(items[0].id, "workspace-local");
  const row = items.find((item) => item.id === "workspace-l1");
  assert.equal(row.label, "APRS Chat");
  assert.equal(row.type, "radio");
  assert.equal(row.checked, true);
  assert.equal(items.find((item) => item.id === "workspace-r1").checked, false);
  row.click();
  assert.deepEqual(calls, ["l1"]);
});


test("withLocalEnvironment compares Windows-shaped paths by separators and case", () => {
  const winDefault = "C:\\Users\\me\\.openmausbot";
  const state = env.withLocalEnvironment({ environments: [], activeId: "local" }, { name: "Site", dataDir: "C:\\Bots\\Site" }, () => "site", winDefault);
  assert.equal(state.ok, true);
  const again = (name, dataDir) => env.withLocalEnvironment(state.state, { name, dataDir }, () => "x", winDefault).error;
  // Same folder written differently (separator style, drive case, trailing slash).
  assert.equal(again("Copy", "c:/bots/site/"), "duplicate");
  // A child of an environment — written with either separator.
  assert.equal(again("Child", "C:\\Bots\\Site\\sub"), "nested");
  assert.equal(again("Child2", "C:/BOTS/SITE/sub"), "nested");
  // A folder inside the default dir, with mixed separators.
  assert.equal(again("Inside default", "c:\\users\\me\\.openmausbot\\envs\\x"), "nested");
  // UNC containment.
  const unc = env.withLocalEnvironment({ environments: [], activeId: "local" }, { name: "Share", dataDir: "\\\\NAS\\omb" }, () => "share", "\\\\nas\\other");
  assert.equal(unc.ok, true);
  assert.equal(env.withLocalEnvironment(unc.state, { name: "Under", dataDir: "\\\\NAS\\omb\\deep" }, () => "x", "\\\\NAS\\elsewhere").error, "nested");
});

test("parseEnvironments dedups local dirs on the same normalized key", () => {
  const parse = (entries) => env.parseEnvironments(JSON.stringify({ version: 2, environments: entries, activeId: "local" })).environments;
  // Trailing slash is the same folder.
  assert.deepEqual(parse([
    { id: "l1", kind: "local", name: "A", dataDir: "/Users/me/.openmausbot-aprs" },
    { id: "l2", kind: "local", name: "B", dataDir: "/Users/me/.openmausbot-aprs/" },
  ]).map((entry) => entry.id), ["l1"]);
  // Windows separator style and drive case are the same folder.
  assert.deepEqual(parse([
    { id: "l1", kind: "local", name: "A", dataDir: "C:\\Bots\\Site" },
    { id: "l2", kind: "local", name: "B", dataDir: "c:/bots/site" },
  ]).map((entry) => entry.id), ["l1"]);
  // Distinct siblings survive.
  assert.equal(parse([
    { id: "l1", kind: "local", name: "A", dataDir: "/Users/me/.openmausbot-a" },
    { id: "l2", kind: "local", name: "B", dataDir: "/Users/me/.openmausbot-b" },
  ]).length, 2);
});
