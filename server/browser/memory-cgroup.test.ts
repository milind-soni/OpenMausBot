import { describe, expect, it } from "vitest";

import { launcherScript } from "./chrome/wrapper.ts";
import {
  browserCgroupDir, browserCgroupProblem, browserMemoryMax, containInGroup, defaultBrowserMemoryMax, groupOomKills, ownCgroupDir, prepareBrowserCgroup, setUpBrowserCgroup,
  spawnInCgroup, type CgroupFs,
} from "./memory-cgroup.ts";

const MB = 1_048_576;

/** A cgroup tree in memory: files by path, with the writes in order. */
function tree(files: Record<string, string>, fail: Record<string, string> = {}, readOnly = false) {
  const writes: string[] = [], made: string[] = [], owned: string[] = [];
  const fs: CgroupFs = {
    exists: (path) => path in files,
    writable: () => !readOnly,
    read: (path) => { if (!(path in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[path]!; },
    write: (path, data) => { if (fail[path]) throw Object.assign(new Error(fail[path]), { code: fail[path] }); writes.push(`${path} ${data}`); },
    mkdir: (path) => { made.push(path); },
    chown: (path, uid, gid) => { owned.push(`${path} ${uid}:${gid}`); },
  };
  return { fs, writes, made, owned };
}

describe("the bots' browsers' kernel memory limit", () => {
  it("is off unless turned on; on, it leaves the server, edge and engines 30% of the machine, at least 900 MB", () => {
    expect(browserMemoryMax({}, 2048 * MB)).toEqual({ on: false });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "off" }, 2048 * MB)).toEqual({ on: false });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "0" }, 2048 * MB)).toEqual({ on: false });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "auto" }, 2048 * MB)).toEqual({ on: true, bytes: 1148 * MB });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: " AUTO " }, 4096 * MB)).toEqual({ on: true, bytes: Math.round(4096 * MB * 0.7) });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "auto" }, 8192 * MB)).toEqual({ on: true, bytes: Math.round(8192 * MB * 0.7) });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "1500" }, 2048 * MB)).toEqual({ on: true, bytes: 1500 * MB });
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "12" }, 2048 * MB)).toEqual({ on: true, bytes: 256 * MB });
    const warned: string[] = [];
    expect(browserMemoryMax({ OMB_BROWSER_MEMORY_MAX: "lots" }, 2048 * MB, (line) => warned.push(line))).toEqual({ on: false });
    expect(warned).toHaveLength(1);
    expect([defaultBrowserMemoryMax(2048 * MB), defaultBrowserMemoryMax(1024 * MB)]).toEqual([1148 * MB, null]);
    // What a 2 GB Cloud reports: about 1970 MB.
    expect(defaultBrowserMemoryMax(1970 * MB)).toBe(1070 * MB);
  });

  it("finds this process's cgroup, and takes only a plain folder under /sys/fs/cgroup as the browsers' one", () => {
    expect(ownCgroupDir("0::/\n")).toBe("/sys/fs/cgroup");
    expect(ownCgroupDir("0::/system.slice/omb.service\n")).toBe("/sys/fs/cgroup/system.slice/omb.service");
    expect(ownCgroupDir("12:memory:/docker/abc\n1:name=systemd:/docker/abc\n")).toBeNull();
    expect(browserCgroupDir("/sys/fs/cgroup/omb/browsers")).toBe("/sys/fs/cgroup/omb/browsers");
    for (const bad of [undefined, "", "/tmp/omb", "/sys/fs/cgroup/../etc", "/sys/fs/cgroup/omb browsers", "/sys/fs/cgroup/omb/$(id)", "/sys/fs/cgroup/omb'x"]) expect(browserCgroupDir(bad)).toBeNull();
  });

  it("is set up under the supervisor's cgroup: server and browsers leaves, the limit, and maus may move its own processes between them", () => {
    // The machine's root cgroup (no cgroup.type), with processes in it: the memory controller may be turned on for children.
    const t = tree({ "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids", "/sys/fs/cgroup/cgroup.subtree_control": "", "/sys/fs/cgroup/cgroup.procs": "1\n412\n" });
    const setup = setUpBrowserCgroup({ base: "/sys/fs/cgroup", limitBytes: 1126 * MB, ids: { uid: 1000, gid: 1000 }, fs: t.fs });
    expect(setup).toEqual({ ok: true, group: { base: "/sys/fs/cgroup", server: "/sys/fs/cgroup/omb/server", browsers: "/sys/fs/cgroup/omb/browsers", limitBytes: 1126 * MB } });
    expect(t.made).toEqual(["/sys/fs/cgroup/omb", "/sys/fs/cgroup/omb/server", "/sys/fs/cgroup/omb/browsers"]);
    expect(t.writes).toEqual([
      "/sys/fs/cgroup/cgroup.subtree_control +memory",
      "/sys/fs/cgroup/omb/cgroup.subtree_control +memory",
      `/sys/fs/cgroup/omb/browsers/memory.max ${1126 * MB}`,
      "/sys/fs/cgroup/omb/browsers/memory.swap.max 0",
    ]);
    // Only the move files: memory.max stays root's.
    expect(t.owned).toEqual(["/sys/fs/cgroup/omb/cgroup.procs 1000:1000", "/sys/fs/cgroup/omb/server/cgroup.procs 1000:1000", "/sys/fs/cgroup/omb/browsers/cgroup.procs 1000:1000"]);
  });

  it("changes nothing where it can't be set up, and says why, mostly from reading alone", () => {
    // A container's own cgroup (it has a cgroup.type) holding its processes: nothing is written at all.
    const container = tree({ "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids", "/sys/fs/cgroup/cgroup.subtree_control": "", "/sys/fs/cgroup/cgroup.type": "domain\n", "/sys/fs/cgroup/cgroup.procs": "1\n7\n" });
    expect(setUpBrowserCgroup({ base: "/sys/fs/cgroup", limitBytes: MB, ids: null, fs: container.fs })).toEqual({ ok: false, why: "processes share /sys/fs/cgroup (a container's own cgroup), and none are moved out of it" });
    expect([container.writes, container.made]).toEqual([[], []]);
    // The same refused by the kernel where the look could not tell.
    const busy = tree({ "/sys/fs/cgroup/cgroup.controllers": "cpu memory pids", "/sys/fs/cgroup/cgroup.subtree_control": "" }, { "/sys/fs/cgroup/cgroup.subtree_control": "EBUSY" });
    expect(setUpBrowserCgroup({ base: "/sys/fs/cgroup", limitBytes: MB, ids: null, fs: busy.fs })).toEqual({ ok: false, why: "processes share /sys/fs/cgroup (a container's own cgroup), and none are moved out of it" });
    expect(busy.made).toEqual([]);
    const v1 = tree({});
    expect(setUpBrowserCgroup({ base: "/sys/fs/cgroup", limitBytes: MB, ids: null, fs: v1.fs })).toMatchObject({ ok: false, why: expect.stringMatching(/^no cgroup v2 tree at \/sys\/fs\/cgroup/) });
    const noMemory = tree({ "/sys/fs/cgroup/cgroup.controllers": "cpu pids" });
    expect(browserCgroupProblem("/sys/fs/cgroup", noMemory.fs)).toBe("the memory controller is not offered at /sys/fs/cgroup");
    const readOnly = tree({ "/sys/fs/cgroup/cgroup.controllers": "memory", "/sys/fs/cgroup/cgroup.subtree_control": "" }, {}, true);
    expect(browserCgroupProblem("/sys/fs/cgroup", readOnly.fs)).toBe("/sys/fs/cgroup is read-only here");
    const failing = tree({ "/sys/fs/cgroup/cgroup.controllers": "memory", "/sys/fs/cgroup/cgroup.subtree_control": "memory" }, { "/sys/fs/cgroup/omb/cgroup.subtree_control": "EROFS" });
    expect(setUpBrowserCgroup({ base: "/sys/fs/cgroup", limitBytes: MB, ids: null, fs: failing.fs })).toEqual({ ok: false, why: "/sys/fs/cgroup/omb could not be set up (EROFS)" });
    // An empty cgroup of its own (a systemd service's leaf moved aside, or a test's): fine.
    expect(browserCgroupProblem("/sys/fs/cgroup/omb-test", tree({ "/sys/fs/cgroup/omb-test/cgroup.controllers": "memory", "/sys/fs/cgroup/omb-test/cgroup.type": "domain", "/sys/fs/cgroup/omb-test/cgroup.procs": "" }).fs)).toBeNull();
    // Already on (a machine's root cgroup under systemd): not written again.
    const on = tree({ "/sys/fs/cgroup/cgroup.controllers": "memory", "/sys/fs/cgroup/cgroup.subtree_control": "cpu memory" });
    expect(setUpBrowserCgroup({ base: "/sys/fs/cgroup", limitBytes: MB, ids: null, fs: on.fs }).ok).toBe(true);
    expect(on.writes[0]).toBe("/sys/fs/cgroup/omb/cgroup.subtree_control +memory");
  });

  it("logs one line at start: off with what a look found, writing nothing, or on with the limit and how long it took", () => {
    const clock = { t: 0 };
    const now = () => (clock.t += 0.4);
    const root = () => tree({ "/sys/fs/cgroup/cgroup.controllers": "memory", "/sys/fs/cgroup/cgroup.subtree_control": "", "/sys/fs/cgroup/cgroup.procs": "1\n" });
    const fly = root();
    expect(prepareBrowserCgroup({}, 2048 * MB, { uid: 1000, gid: 1000 }, { fs: fly.fs, procSelfCgroup: () => "0::/\n", now })).toEqual({ group: null,
      line: "browser memory limit: off (OMB_BROWSER_MEMORY_MAX=auto turns it on); it could be set here, in /sys/fs/cgroup/omb/browsers, 1148 MB (looked in 0.4 ms)" });
    expect([fly.writes, fly.made, fly.owned]).toEqual([[], [], []]);
    const docker = tree({ "/sys/fs/cgroup/cgroup.controllers": "memory", "/sys/fs/cgroup/cgroup.subtree_control": "", "/sys/fs/cgroup/cgroup.type": "domain", "/sys/fs/cgroup/cgroup.procs": "1\n" });
    expect(prepareBrowserCgroup({}, 4096 * MB, null, { fs: docker.fs, procSelfCgroup: () => "0::/\n", now }).line)
      .toBe("browser memory limit: off (OMB_BROWSER_MEMORY_MAX=auto turns it on); it could not be set here: processes share /sys/fs/cgroup (a container's own cgroup), and none are moved out of it (looked in 0.4 ms)");
    expect(prepareBrowserCgroup({}, 2048 * MB, null, { fs: fly.fs, procSelfCgroup: () => "1:name=systemd:/\n", now }).line).toMatch(/it could not be set here: this process is in no cgroup v2/);
    const on = root();
    const set = prepareBrowserCgroup({ OMB_BROWSER_MEMORY_MAX: "auto" }, 2048 * MB, { uid: 1000, gid: 1000 }, { fs: on.fs, procSelfCgroup: () => "0::/\n", now });
    expect(set.group?.browsers).toBe("/sys/fs/cgroup/omb/browsers");
    expect(set.line).toBe("browser memory limit: 1148 MB for the bots' Chrome together, in /sys/fs/cgroup/omb/browsers (set up in 0.4 ms)");
  });

  it("starts a child in a leaf by joining it for the spawn, then goes back", () => {
    const t = tree({});
    expect(spawnInCgroup("/sys/fs/cgroup/omb/server", "/sys/fs/cgroup", () => { t.writes.push("spawned"); return 7; }, t.fs)).toBe(7);
    expect(t.writes).toEqual([`/sys/fs/cgroup/omb/server/cgroup.procs ${process.pid}`, "spawned", `/sys/fs/cgroup/cgroup.procs ${process.pid}`]);
    const refused = tree({}, { "/sys/fs/cgroup/omb/server/cgroup.procs": "EACCES" });
    expect(spawnInCgroup("/sys/fs/cgroup/omb/server", "/sys/fs/cgroup", () => 8, refused.fs)).toBe(8);
    expect(refused.writes).toEqual([]);
  });

  it("moves into the group only a browser process that is not in it yet, and reads the kernel's kill count", () => {
    const t = tree({ "/proc/11/cgroup": "0::/omb/browsers\n", "/proc/12/cgroup": "0::/omb/server\n", "/sys/fs/cgroup/omb/browsers/memory.events": "low 0\nhigh 0\nmax 9\noom 2\noom_kill 2\n" });
    expect(containInGroup("/sys/fs/cgroup/omb/browsers", [11, 12, 13], t.fs)).toBe(1);
    expect(t.writes).toEqual(["/sys/fs/cgroup/omb/browsers/cgroup.procs 12"]);
    expect(groupOomKills("/sys/fs/cgroup/omb/browsers", t.fs.read)).toBe(2);
    expect(groupOomKills("/sys/fs/cgroup/none", t.fs.read)).toBeNull();
  });

  it("has Chrome join the group before anything else in its launcher, and only where one is given", () => {
    const settings = { chrome: "/opt/openmausbot-browser/chrome", userAgent: "UA", screen: { width: 1920, height: 1080 } };
    const lines = launcherScript({ ...settings, memoryGroup: "/sys/fs/cgroup/omb/browsers" }, "linux").split("\n");
    expect(lines.slice(0, 2)).toEqual(["#!/bin/sh", "{ echo $$ > '/sys/fs/cgroup/omb/browsers/cgroup.procs'; } 2>/dev/null"]);
    expect(launcherScript(settings, "linux")).not.toContain("cgroup");
  });
});
