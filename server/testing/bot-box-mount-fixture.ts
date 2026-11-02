import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BotBox } from "../bot-box/box.ts";
import { closeMountFds } from "../bot-box/pin.ts";
import { bwrapArgs, planBox, type BoxPlan, type BoxRequest } from "../bot-box/plan.ts";

const scenario = process.argv[2];
const realData = "/var/lib/openmausbot";
const home = "/home/fixture";
mkdirSync(realData, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(realData, "messages.db"), "private fixture");

const probe = (options: string[], script: string, seccomp?: string | null, fds: number[] = []) => {
  const fd = seccomp ? openSync(seccomp, "r") : null;
  try {
    const result = spawnSync("/usr/bin/bwrap", [...options, "--", "/bin/sh", "-c", script],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe", ...(fd === null ? [] : [fd]), ...fds] });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim().split("\n");
  } finally { if (fd !== null) closeSync(fd); }
};
const probePlan = (plan: BoxPlan, script: string) => {
  const fds: number[] = [];
  try { return probe(bwrapArgs(plan, fds), script, null, fds); }
  finally { closeMountFds(fds); }
};
const setup = { dataDir: realData, home, codeRoots: [], engineRoots: [], bridges: [] };
const request: BoxRequest = { command: "/bin/sh", args: [], env: {}, net: "shared" };

if (scenario === "browser" || scenario === "browser-read-only") {
  const uploads = scenario === "browser" ? "/srv/browser-uploads" : join(realData, "browser-uploads");
  mkdirSync(uploads);
  writeFileSync(join(uploads, "upload.txt"), "upload fixture");
  writeFileSync(join(home, "private.txt"), "home fixture");
  const box = new BotBox();
  try {
    await box.start({ ...setup, port: 8799, denyEnv: new Set(), env: {}, log: () => {},
      detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: null } }) });
    const browser = box.browserBox(3, [uploads])!;
    const launch = browser.launch!;
    const result = spawnSync(launch.command, [...launch.args, "", "--", "/bin/sh", "-c",
      `for file in /var/lib/openmausbot/messages.db /home/fixture/private.txt; do if test -r "$file"; then echo exposed; else echo hidden; fi; done; cat ${uploads}/upload.txt`],
      { encoding: "utf8", timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    if (result.status !== 0) throw new Error(result.stderr);
    console.log(JSON.stringify(result.stdout.trim().split("\n")));
  } finally { await box.stop(); }
} else if (scenario === "symlink" || scenario === "symlink-home") {
  const alias = scenario === "symlink" ? "/srv/omb" : "/srv/linked-home/openmausbot";
  const boxHome = scenario === "symlink" ? "/srv" : "/srv/linked-home";
  if (scenario === "symlink") symlinkSync(realData, alias);
  else symlinkSync("/var/lib", boxHome);
  const cwd = join(alias, "task-workspaces", "bot-a", "thread-1");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "task.txt"), "task fixture\n");
  mkdirSync(join(realData, "workspaces", "bot-a"), { recursive: true });
  writeFileSync(join(realData, "workspaces", "bot-a", "memory.txt"), "memory fixture\n");
  const plan = planBox({ ...setup, dataDir: alias, home: boxHome }, { ...request, cwd });
  console.log(JSON.stringify({ botId: plan.botId, files: probePlan(plan,
    `for file in ${alias}/messages.db /var/lib/openmausbot/messages.db; do if test -r "$file"; then echo exposed; else echo hidden; fi; done; cat task.txt; cat /var/lib/openmausbot/workspaces/bot-a/memory.txt`) }));
} else if (scenario === "symlink-read-only" || scenario === "symlink-home-read-only") {
  const boxHome = scenario === "symlink-read-only" ? home : "/srv/linked-home";
  const alias = scenario === "symlink-read-only" ? join(home, ".openmausbot") : join(boxHome, "openmausbot");
  if (scenario === "symlink-read-only") symlinkSync(realData, alias);
  else symlinkSync("/var/lib", boxHome);
  const skills = join(realData, "claude-user-skills"), linkedSkills = join(alias, "claude-user-skills");
  mkdirSync(skills);
  writeFileSync(join(skills, "skill.txt"), "skill fixture\n");
  const results: string[][] = [];
  for (const path of [linkedSkills, skills]) {
    for (const access of [{ args: ["--add-dir", path] }, { ro: [path] }]) {
      const plan = planBox({ ...setup, dataDir: alias, home: boxHome }, { ...request, env: { HOME: boxHome }, ...access });
      results.push(probePlan(plan,
        `for file in ${path}/skill.txt ${skills}/skill.txt; do if test -r "$file"; then cat "$file"; else echo missing; fi; if (echo changed > "$file") 2>/dev/null; then echo writable; else echo read-only; fi; done; for file in ${alias}/messages.db ${realData}/messages.db; do if test -r "$file"; then echo exposed; else echo hidden; fi; done`));
    }
  }
  console.log(JSON.stringify(results));
} else if (scenario?.startsWith("readonly-alias-")) {
  const otherBot = join(realData, "workspaces", "bot-b"), alias = join(home, "skills");
  mkdirSync(otherBot, { recursive: true });
  writeFileSync(join(otherBot, "private.txt"), "other bot fixture");
  const intoData = scenario.endsWith("-data");
  symlinkSync(intoData ? realData : otherBot, alias);
  const access = scenario.includes("-argv-") ? { args: ["--add-dir", alias] } : { ro: [alias] };
  const plan = planBox(setup, { ...request, ...access });
  console.log(JSON.stringify(probePlan(plan,
    `for file in ${realData}/messages.db ${otherBot}/private.txt ${alias}/${intoData ? "messages.db" : "private.txt"}; do if test -r "$file"; then echo exposed; else echo hidden; fi; done`)));
} else if (scenario?.startsWith("hostile-cwd-")) {
  const cwd = join(realData, "task-workspaces", "bot-a", "thread-1");
  const otherBot = join(realData, "workspaces", "bot-b"), otherThread = join(realData, "task-workspaces", "bot-a", "thread-2");
  for (const folder of [cwd, otherBot, otherThread, join(realData, "workspaces", "bot-a")]) mkdirSync(folder, { recursive: true });
  const alias = scenario.includes("-outside-") ? "/srv/granted" : join(scenario.includes("-task-") ? cwd : home, "granted");
  const target = scenario.endsWith("-data") ? realData : scenario.endsWith("-bot") ? otherBot : scenario.endsWith("-thread") ? otherThread : "/var/lib";
  symlinkSync(target, alias);
  writeFileSync(join(target, "cwd-private.txt"), "private fixture");
  const result: { error: string | null; files?: string[] } = { error: null };
  try {
    const plan = planBox(setup, { ...request, cwd: alias });
    result.files = probePlan(plan, 'cat cwd-private.txt; echo; echo changed > cwd-private.txt');
  } catch (caught) { result.error = (caught as Error).message; }
  console.log(JSON.stringify(result));
} else if (scenario?.startsWith("dotdot-alias-")) {
  const secret = join(realData, "..x"), alias = "/srv/granted";
  mkdirSync(secret);
  writeFileSync(join(secret, "private.txt"), "private fixture");
  symlinkSync(secret, alias);
  const grant = scenario.slice("dotdot-alias-".length);
  const access = grant === "env" ? { env: { CODEX_HOME: alias } } : grant === "rw" ? { rw: [alias] } : grant === "ro" ? { ro: [alias] } : { args: [alias] };
  const plan = planBox(setup, { ...request, ...access });
  const files = probePlan(plan,
    `for file in ${secret}/private.txt ${alias}/private.txt; do if test -r "$file"; then echo exposed; else echo hidden; fi; (echo changed >> "$file") 2>/dev/null || :; done`);
  console.log(JSON.stringify({ files, hostFile: readFileSync(join(secret, "private.txt"), "utf8") }));
} else if (scenario === "home-cwd") {
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "messages.db"), "private fixture");
  const plan = planBox({ ...setup, dataDir }, { ...request, cwd: home });
  console.log(JSON.stringify(probePlan(plan,
    `if test -r ${dataDir}/messages.db; then echo exposed; else echo hidden; fi; if (echo changed > cwd-probe) 2>/dev/null; then echo writable; else echo unwritable; fi`)));
} else if (scenario?.startsWith("hostile-")) {
  const otherBot = join(realData, "workspaces", "bot-b");
  const alias = scenario.includes("outside") ? "/srv/granted" : join(home, ".codex");
  const cwd = join(realData, "task-workspaces", "bot-a", "thread-1");
  for (const folder of [otherBot, cwd, join(realData, "workspaces", "bot-a")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(otherBot, "private.txt"), "other bot fixture");
  symlinkSync(scenario.endsWith("-data") ? realData : scenario.endsWith("-ancestor") ? "/var/lib" : otherBot, alias);
  const plan = planBox(setup, { ...request, cwd,
    ...(scenario.includes("-env-") ? { env: { HOME: home, CODEX_HOME: alias } } : { rw: [alias] }),
  });
  const database = join(realData, "messages.db"), otherFile = join(otherBot, "private.txt");
  const aliasedFile = join(alias, scenario.endsWith("-data") ? "messages.db" : scenario.endsWith("-ancestor") ? "openmausbot/messages.db" : "private.txt");
  const paths = [database, otherFile, aliasedFile].join(" ");
  const files = probePlan(plan,
    `for file in ${paths}; do if test -r "$file"; then echo exposed; else echo hidden; fi; done; for file in ${paths}; do (echo changed >> "$file") 2>/dev/null || :; done; for folder in ${alias} ${realData} ${otherBot}; do (echo changed > "$folder/alias-write-probe") 2>/dev/null || :; done`);
  console.log(JSON.stringify({ files, hostFiles: [database, otherFile].map((file) => readFileSync(file, "utf8")),
    created: [realData, otherBot].map((folder) => existsSync(join(folder, "alias-write-probe"))),
  }));
} else if (scenario === "symlink-private-env") {
  writeFileSync("/tmp/private.txt", "private fixture");
  symlinkSync("/tmp", "/srv/scratch");
  const plan = planBox({ ...setup, home: "/srv" }, { ...request, env: { TMPDIR: "/srv/scratch" } });
  console.log(JSON.stringify(probePlan(plan, 'if test -r /tmp/private.txt; then echo exposed; else echo hidden; fi')));
} else if (scenario === "read-only") {
  const skills = join(realData, "claude-user-skills");
  mkdirSync(skills);
  writeFileSync(join(skills, "skill.txt"), "skill fixture\n");
  const plan = planBox(setup, { ...request, args: ["--add-dir", skills] });
  console.log(JSON.stringify(probePlan(plan,
    'cat /var/lib/openmausbot/claude-user-skills/skill.txt; if (echo changed > /var/lib/openmausbot/claude-user-skills/skill.txt) 2>/dev/null; then echo writable; else echo read-only; fi; if test -r /var/lib/openmausbot/messages.db; then echo exposed; else echo hidden; fi')));
} else if (scenario === "home") {
  const results: unknown[] = [];
  for (const ownHome of ["/srv/omb/home", "/srv/omb"]) {
    mkdirSync(join(ownHome, ".claude"), { recursive: true });
    writeFileSync(join(ownHome, ".claude", "settings.json"), "settings fixture\n");
    writeFileSync("/srv/omb/messages.db", "private fixture");
    try {
      const plan = planBox({ ...setup, dataDir: "/srv/omb", home: ownHome }, { ...request, env: { HOME: ownHome } });
      results.push({ files: probePlan(plan,
        `if test -r ${ownHome}/.claude/settings.json; then cat ${ownHome}/.claude/settings.json; else echo missing; fi; if (echo changed > ${ownHome}/.claude/settings.json) 2>/dev/null; then echo writable; else echo unwritable; fi; if test -r /srv/omb/messages.db; then echo exposed; else echo hidden; fi`) });
    } catch (error) { results.push({ error: (error as Error).message }); }
  }
  try {
    const audience = planBox({ ...setup, dataDir: "/srv/omb" }, { ...request, home: "/srv/omb" });
    results.push({ files: probePlan(audience, 'if test -r /srv/omb/messages.db; then echo exposed; else echo hidden; fi') });
  } catch (error) { results.push({ error: (error as Error).message }); }
  const browser = planBox({ ...setup, dataDir: "/srv/omb", home: "/srv/omb" }, { ...request, home: false });
  results.push(probePlan(browser, 'if test -r /srv/omb/messages.db; then echo exposed; else echo hidden; fi'));
  console.log(JSON.stringify(results));
} else throw new Error("Unknown mount fixture");
