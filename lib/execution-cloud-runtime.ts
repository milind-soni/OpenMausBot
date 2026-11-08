import { createHash, randomUUID } from "node:crypto";
import { cloudAccountUsage, CloudProviderError, createCloudMachine, executeCloudCommand, extendCloudMachine, findCloudMachine, getCloudMachine, startCloudMachine, stopCloudMachine } from "./execution-cloud";
import { enrolledHost, observedExecutionHost, revalidateExecutionPrincipal, type StoredCloudProvider } from "./execution-common";
import { routeExecution } from "./execution-policy";
import { acquireExecutionLock, atomicExecution, cloudAllocations, executionAccounts, executionHosts, executionRuns, executionSetting, executionUnstoppedHostRuns, executionHostHasAttempt, readExecutionHost, readExecutionRun, releaseExecutionLock, saveCloudAllocation, patchCloudAllocation, saveExecutionRun, setExecutionSetting, type CloudAllocation, type ExecutionPrincipal, type PrivateRun } from "./execution-store";
import { openIntegration, sealIntegration } from "./githubConnection";
import { originUrl } from "./integration-bridge";

// Journal fields are intentionally persisted with the allocation, not process-local promises.
// A crash after admission of a create never authorizes a second create.
type Allocation = CloudAllocation & {
  enrollment?: { sealedToken: string; expiresAt: number };
  stopRequestedAt?: number;
  bootstrapVerified?: boolean;
  recoveryRequired?: boolean;
};
const ROOT = "/var/lib/origin-runner";
const CONFIG = `${ROOT}/.config/origin-runner/config.json`;
const DATA = `${ROOT}/.local/share/origin-runner`;
const TOOLS = `${DATA}/tools`;
const BUN = `${DATA}/runtime/bun-1.4.4`;
const WORKER_PATH = ["codex", "claude-code", "pi", "omp"].map(harness => `${TOOLS}/${harness}/current/node_modules/.bin`).concat(`${BUN}/node_modules/.bin`, `${ROOT}/.local/bin`, "/opt/origin-node/bin", "/usr/local/bin", "/usr/bin", "/bin").join(":");
const NODE = "/opt/origin-node/bin/node";
const CLI = `${ROOT}/runner/cli.mjs`;
const UNIT = "origin-cloud-runner.service";
const LOCK_MS = 45 * 60_000;
const IDLE_MS = 60_000;
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (run: PrivateRun) => `cloud:${hash(JSON.stringify([run.run.teamId, run.run.requestedBy, run.run.projectId, run.policy.cloudProvider]))}`;
const allocationLock = (allocation: Pick<Allocation, "teamId" | "ownerId" | "projectId" | "provider">) => `cloud:${hash(JSON.stringify([allocation.teamId, allocation.ownerId, allocation.projectId, allocation.provider]))}`;
function persist(allocation: Allocation, patch: Partial<Allocation>) {
  if (patch.status === "failed") patch.recoveryRequired = true;
  const current = patchCloudAllocation(allocation.id, patch);
  for (const key of Object.keys(allocation)) if (!(key in current)) Reflect.deleteProperty(allocation, key);
  Object.assign(allocation, current);
}
class CloudRuntimePrerequisiteError extends Error {}
function safeFailure(error: unknown) {
  if (error instanceof CloudRuntimePrerequisiteError) return error.message;
  return error instanceof CloudProviderError ? `${error.provider} ${error.operation}: ${error.category}; outcome ${error.outcome}. No provider switch was made.` : "Cloud operation unavailable; inspect the private worker and controller configuration. No credentials or provider response are exposed.";
}
function route(record: PrivateRun) {
  return routeExecution({ policy: record.policy, projectId: record.run.projectId, ownerId: record.run.requestedBy, hosts: executionHosts(record.run.teamId).map(host => observedExecutionHost(host)), accounts: executionAccounts(record.run.teamId, record.run.requestedBy), attempted: record.attempted });
}
function unchangedQueued(previous: PrivateRun) {
  const current = readExecutionRun(previous.run.id);
  return current && current.run.status === "queued" && current.run.processStopped && !current.cancelRequested && current.run.attempt === previous.run.attempt && current.run.hostId === previous.run.hostId && JSON.stringify(current.policy) === JSON.stringify(previous.policy) ? current : undefined;
}
function reason(record: PrivateRun, text: string, block = false) {
  atomicExecution(() => {
    const current = unchangedQueued(record);
    if (!current || current.run.reason === text && !block) return;
    if (block) current.run.status = "blocked";
    current.run.reason = text; current.run.updatedAt = Date.now(); saveExecutionRun(current);
  });
}
function pending(record: PrivateRun, allocation?: Allocation) {
  const current = unchangedQueued(record);
  if (!current) return undefined;
  const routing = route(current);
  // A heartbeat can make this host routable before an uncertain bootstrap is journaled ready.
  // Routing still enforces confirmed local-offline policy; it never authorizes another machine.
  return routing.needsCloud || allocation?.hostId && routing.host?.id === allocation.hostId && routing.host?.kind === allocation.provider ? current : undefined;
}
class CloudProvisionDeferred extends Error {}
async function authorizeProvision(record: PrivateRun, sealedKey: string, allocation?: Allocation): Promise<ExecutionPrincipal> {
  let principal: ExecutionPrincipal;
  try { principal = await revalidateExecutionPrincipal(record); }
  catch { throw new CloudProvisionDeferred("Cloud provisioning waits for current requester, issue and project authorization"); }
  if (!principal.admin) throw new CloudProvisionDeferred("A workspace administrator must authorize private cloud enrollment");
  const provider = executionSetting<StoredCloudProvider>(record.run.teamId, "cloud", record.policy.cloudProvider);
  if (!provider?.enabled || provider.sealedKey !== sealedKey) throw new CloudProvisionDeferred("Cloud provider consent or credentials changed; no new provisioning action was sent");
  if (!pending(record, allocation)) throw new CloudProvisionDeferred("Run policy or local availability changed; no new provisioning action was sent");
  if (allocation?.hostId) {
    const host = readExecutionHost(allocation.hostId);
    if (host?.revoked || host?.paused) throw new CloudProvisionDeferred("Cloud enrollment was revoked or paused; no new provisioning action was sent");
    if (executionUnstoppedHostRuns(allocation.hostId).length) throw new CloudProvisionDeferred("The existing private cloud worker has an executing or uncertain run; no restart is allowed");
  }
  return principal;
}
function cloudMaintenance(allocation: Allocation): "active" | "expired" | undefined {
  if (!allocation.hostId) return undefined;
  const request = executionSetting<{ requestedAt?: number }>(allocation.teamId, "maintenance", allocation.hostId);
  if (!request) return undefined;
  const age = typeof request.requestedAt === "number" ? Date.now() - request.requestedAt : NaN;
  return Number.isFinite(age) && age >= 0 && age < 30 * 60_000 ? "active" : "expired";
}
function credentials(allocation: Pick<Allocation, "teamId" | "provider">, requireEnabled: boolean) {
  const stored = executionSetting<StoredCloudProvider>(allocation.teamId, "cloud", allocation.provider);
  if (!stored?.sealedKey || requireEnabled && !stored.enabled) return undefined;
  return { stored, apiKey: openIntegration(stored.sealedKey, `execution-cloud:${allocation.teamId}:${allocation.provider}`) };
}
async function command(allocation: Allocation, apiKey: string, script: string, env?: Record<string, string>, timeoutSeconds = 120) {
  const result = await executeCloudCommand({ provider: allocation.provider, apiKey, id: allocation.machineId!, command: script, env, timeoutSeconds });
  if (result.exitCode !== 0) throw new CloudRuntimePrerequisiteError("Private worker setup/lifecycle command failed. Required: systemd Linux, root or passwordless sudo, runuser, git, public HTTPS access to Origin/nodejs.org/npm, and a compatible x64/arm64 runtime. Inspect the private origin-runner service journal; no authentication is assumed.");
  return result.stdout.trim();
}
const asRoot = (script: string) => `if [ "$(id -u)" -eq 0 ]; then bash -c ${q(script)}; else sudo -n bash -c ${q(script)}; fi`;
const asWorker = (script: string) => asRoot(`runuser -u origin-runner -- env -i HOME=${ROOT} USER=origin-runner LOGNAME=origin-runner PATH=${WORKER_PATH} bash -c ${q(script)}`);

// This setup never uses a fleet user's HOME, shell profile, OAuth cache, or npm config.
// Checksums are pinned from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
const prepareMachine = asRoot(`set -eu
command -v systemctl >/dev/null
command -v runuser >/dev/null
command -v git >/dev/null
test -d /run/systemd/system
id origin-runner >/dev/null 2>&1 || useradd --create-home --home-dir ${ROOT} --shell /bin/bash origin-runner
test "$(getent passwd origin-runner | cut -d: -f6)" = ${ROOT}
install -d -m 700 -o origin-runner -g origin-runner ${ROOT} ${ROOT}/.config ${ROOT}/.config/origin-runner ${DATA}
if ! test -x ${NODE} || ! test -x /opt/origin-node/bin/npm || ! ${NODE} -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  existing=$(command -v node || true)
  existing_npm=$(command -v npm || true)
  case "$existing:$existing_npm" in *"/home/"*|*"/root/"*) existing=; existing_npm=;; esac
  if test -n "$existing" && test -n "$existing_npm" && "$existing" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
    install -d -m 755 /opt/origin-node/bin
    ln -sfn "$existing" ${NODE}
    ln -sfn "$existing_npm" /opt/origin-node/bin/npm
  else
    command -v curl >/dev/null; command -v sha256sum >/dev/null; command -v tar >/dev/null
    case "$(uname -m)" in
      x86_64) arch=x64; sha=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c;;
      aarch64) arch=arm64; sha=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3;;
      *) exit 72;;
    esac
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-$arch.tar.gz" -o "$tmp/node.tar.gz"
    printf '%s  %s\\n' "$sha" "$tmp/node.tar.gz" | sha256sum -c - >/dev/null
    install -d -m 755 /opt/origin-node
    tar -xzf "$tmp/node.tar.gz" --strip-components=1 -C /opt/origin-node
  fi
fi`);

// Official package identities and exact initial releases. A valid managed current release is
// preserved on resume: only the runner's explicit idle update action advances its symlink.
const pinnedTools = [
  { harness: "codex", package: "@openai/codex", version: "0.166.0", cli: "codex", integrity: "sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q==" },
  { harness: "claude-code", package: "@anthropic-ai/claude-code", version: "2.1.316", cli: "claude", integrity: "sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==" },
  { harness: "pi", package: "@earendil-works/pi-coding-agent", version: "1.5.0", cli: "pi", integrity: "sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==" },
  { harness: "omp", package: "@oh-my-pi/pi-coding-agent", version: "18.18.0", cli: "omp", integrity: "sha512-OJlxyXCX/hz2cjS1vqd7+UEjnm8Jh/JHE8xnUL/DisqVLxCB6hJCCc7xa3d7lm80AUYhwDClazWk/FgZxE998g==" },
];
const installHarnesses = asWorker(`set -eu
export npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null npm_config_registry=https://registry.npmjs.org npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
${NODE} --input-type=module -e ${q(`import {readFile,writeFile,mkdir,rename,symlink,realpath,lstat,stat,access,rm} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const root=${JSON.stringify(TOOLS)},configPath=${JSON.stringify(CONFIG)},bun=${JSON.stringify(BUN)},pins=${JSON.stringify(pinnedTools)};
const json=async p=>JSON.parse(await readFile(p,'utf8'));
async function exists(p){try{await lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function install(target,name,version,integrity){
  await mkdir(target,{recursive:true,mode:448});
  await writeFile(target+'/package.json',JSON.stringify({name:'origin-private-tool',private:true,version:'1.0.0',dependencies:{[name]:version}}),{mode:384});
  execFileSync('/opt/origin-node/bin/npm',['install','--prefix',target,'--omit=dev','--no-audit','--no-fund','--loglevel=error'],{env:process.env,stdio:'inherit',timeout:110000});
  const lock=await json(target+'/package-lock.json'),pkg=await json(target+'/node_modules/'+name+'/package.json');
  if(pkg.version!==version||lock.packages?.['node_modules/'+name]?.integrity!==integrity)throw Error('Pinned package integrity mismatch');
}
if(!await exists(bun+'/node_modules/.bin/bun'))await install(bun,'bun','1.4.4','sha512-hj0ASdG6PNjLZGFAXktWb3Uaj/dcv/1wCsIttoEXADNIQBsGjTr+5uLKYbrDkuc7NT0Tkj4yPIqJI2jDxXdvVg==');
for(const pin of pins){
  const base=root+'/'+pin.harness,current=base+'/current',releases=base+'/releases';
  await mkdir(releases,{recursive:true,mode:448});
  if(await exists(current)){
    if(!(await lstat(current)).isSymbolicLink())throw Error('Managed current must be a symlink');
    const release=await realpath(current),m=await json(release+'/release.json'),pkg=await json(release+'/node_modules/'+pin.package+'/package.json');
    if(!release.startsWith(releases+'/')||m.schemaVersion!==1||m.managedBy!=='origin-runner'||m.harness!==pin.harness||m.package!==pin.package||m.version!==pkg.version||m.executable!=='node_modules/.bin/'+pin.cli||typeof m.integrity!=='string'||!m.integrity.startsWith('sha512-'))throw Error('Unrecognized managed release');
    await access(release+'/'+m.executable,1);continue;
  }
  const release=releases+'/'+pin.version;
  if(await exists(release)){
    const m=await json(release+'/release.json');
    if(m.schemaVersion!==1||m.managedBy!=='origin-runner'||m.harness!==pin.harness||m.package!==pin.package||m.version!==pin.version||m.integrity!==pin.integrity||m.executable!=='node_modules/.bin/'+pin.cli)throw Error('Unrecognized existing release');
  }else{
    const stage=releases+'/.install-'+randomUUID();
    try{
      await install(stage,pin.package,pin.version,pin.integrity);
      await access(stage+'/node_modules/.bin/'+pin.cli,1);
      await writeFile(stage+'/release.json',JSON.stringify({schemaVersion:1,harness:pin.harness,package:pin.package,version:pin.version,integrity:pin.integrity,executable:'node_modules/.bin/'+pin.cli,managedBy:'origin-runner'}),{mode:384});
      await rename(stage,release);
    }finally{await rm(stage,{recursive:true,force:true});}
  }
  await symlink('releases/'+pin.version,current);
}
let config={};
if(await exists(configPath)){if(((await stat(configPath)).mode&63)!==0)throw Error('Config must be private');config=await json(configPath);}
if(config.managedTools&&(config.managedTools.schemaVersion!==1||config.managedTools.root!==root))throw Error('Managed tool scope already differs');
config.managedTools={schemaVersion:1,root};const temporary=configPath+'.'+randomUUID();await writeFile(temporary,JSON.stringify(config),{mode:384});await rename(temporary,configPath);
`)}
`);

type Bundle = { version: string; sha256: string; files: { path: string; content: string; sha256: string }[] };
function validateBundle(value: unknown): Bundle {
  const bundle = value as Bundle;
  if (!bundle || bundle.version !== "1.0.0" || !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 100) throw new Error("Unsupported runner bundle");
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of bundle.files) {
    if (!file || typeof file.path !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(file.path) || typeof file.content !== "string" || hash(file.content) !== file.sha256) throw new Error("Invalid runner bundle");
    bytes += Buffer.byteLength(file.content); paths.add(file.path);
  }
  if (bytes > 2_000_000 || !paths.has("cli.mjs") || !paths.has("security.mjs")) throw new Error("Incomplete runner bundle");
  const manifest = bundle.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (hash(JSON.stringify(manifest)) !== bundle.sha256) throw new Error("Runner bundle checksum mismatch");
  return bundle;
}
async function publicBundle() {
  const origin = new URL(originUrl());
  if (origin.protocol !== "https:" || origin.username || origin.password) throw new CloudRuntimePrerequisiteError("Cloud workers require a configured public HTTPS Origin URL without embedded credentials.");
  const url = new URL("/api/execution/runner", origin).href;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || Number(response.headers.get("content-length")) > 3_000_000) throw new Error("Runner bundle unavailable");
  const text = await response.text();
  if (Buffer.byteLength(text) > 3_000_000) throw new Error("Runner bundle too large");
  return { bundle: validateBundle(JSON.parse(text)), url, origin: origin.origin };
}
function bundleInstaller(url: string, bundle: Bundle) {
  // Re-fetch in the VM, bind it to the verified controller digest, and verify every file.
  // No cloud API key, session token or controller bearer is ever passed to this script.
  return asWorker(`${NODE} --input-type=module -e ${q(`import {createHash} from 'node:crypto'; import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
const h=s=>createHash('sha256').update(s).digest('hex');
const response=await fetch(${JSON.stringify(url)},{redirect:'error',signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Bundle unavailable');
const text=await response.text();if(Buffer.byteLength(text)>3000000)throw Error('Bundle too large');const b=JSON.parse(text);
if(b.version!==${JSON.stringify(bundle.version)}||b.sha256!==${JSON.stringify(bundle.sha256)}||!Array.isArray(b.files)||b.files.length>100)throw Error('Release changed');
const manifest=b.files.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
if(h(JSON.stringify(manifest))!==b.sha256)throw Error('Manifest mismatch');
const paths=new Set();for(const f of b.files){if(typeof f.path!=='string'||!(/^[a-zA-Z0-9_./-]+$/).test(f.path)||f.path.startsWith('/')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||paths.has(f.path)||typeof f.content!=='string'||h(f.content)!==f.sha256)throw Error('File mismatch');paths.add(f.path);}
if(!paths.has('cli.mjs')||!paths.has('security.mjs'))throw Error('Incomplete release');
const stage=${JSON.stringify(`${ROOT}/runner-stage-`)}+b.sha256;await rm(stage,{force:true,recursive:true});await mkdir(stage,{mode:448});
for(const f of b.files){const p=stage+'/'+f.path;await mkdir(p.slice(0,p.lastIndexOf('/')),{recursive:true,mode:448});await writeFile(p,f.content,{mode:384});}
await rm(${JSON.stringify(`${ROOT}/runner`)},{force:true,recursive:true});await rename(stage,${JSON.stringify(`${ROOT}/runner`)});`)}`);
}
const service = `[Unit]\nDescription=Origin private cloud worker\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=origin-runner\nGroup=origin-runner\nEnvironment=HOME=${ROOT}\nEnvironment=PATH=${WORKER_PATH}\nWorkingDirectory=${ROOT}\nExecStart=${NODE} ${DATA}/installation/launcher.mjs run --config ${CONFIG}\nRestart=on-failure\nRestartSec=15\nKillMode=control-group\nTimeoutStopSec=90\nUMask=0077\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nReadWritePaths=${ROOT}\nPrivateTmp=yes\n[Install]\nWantedBy=multi-user.target\n`;
async function bootstrap(allocation: Allocation, apiKey: string, authorize: () => Promise<ExecutionPrincipal>) {
  const execute = async (script: string, env?: Record<string, string>, timeoutSeconds?: number) => {
    await authorize();
    const result = await command(allocation, apiKey, script, env, timeoutSeconds);
    await authorize();
    return result;
  };
  const host = allocation.hostId ? readExecutionHost(allocation.hostId) : undefined;
  if (host?.revoked) { persist(allocation, { status: "failed", error: "Cloud enrollment was revoked. An administrator must deliberately replace the scoped enrollment; existing private CLI credentials are retained." }); return; }
  const release = await publicBundle();
  await authorize();
  persist(allocation, { status: "bootstrapping" });
  await execute(prepareMachine, undefined, 240);
  // A previously enrolled service must not be overwritten while it could still be running.
  const running = await execute(asRoot(`if systemctl is-active --quiet ${UNIT}; then printf active; else printf inactive; fi`));
  if (running === "active") {
    if (!allocation.hostId) throw new Error("Unrecognized worker service");
    persist(allocation, { status: "ready", enrollment: undefined, runnerStoppedAt: undefined, stopRequestedAt: undefined, stopProof: undefined, error: undefined, lastActiveAt: Date.now() }); return;
  }
  await execute(installHarnesses, undefined, 600);
  if (!allocation.bootstrapVerified) {
    await execute(bundleInstaller(release.url, release.bundle));
    persist(allocation, { bootstrapVerified: true });
  }
  const configState = await execute(asWorker(`${NODE} --input-type=module -e ${q(`import {readFile,stat} from 'node:fs/promises';try{const s=await stat(${JSON.stringify(CONFIG)});const c=JSON.parse(await readFile(${JSON.stringify(CONFIG)},'utf8'));if((s.mode&63)!==0||c.hostToken&&c.hostId!==${JSON.stringify(allocation.hostId ?? "")})throw Error('Invalid config');console.log(c.hostToken?'enrolled':'absent');}catch(e){if(e.code==='ENOENT')console.log('absent');else throw e;}`)}`));
  if (configState === "absent") {
    if (allocation.hostId && !allocation.enrollment) {
      persist(allocation, { status: "failed", error: "Previously enrolled host config is missing. An administrator must inspect the private disk and deliberately replace the scoped enrollment; no duplicate host was enrolled." }); return;
    }
    if (!allocation.enrollment) {
      const principal = await authorize();
      // Mint and journal atomically before exposing the single-use token to a provider exec.
      atomicExecution(() => {
        const enrollment = enrolledHost(principal, { name: allocation.name, kind: allocation.provider, projectIds: [allocation.projectId] }, allocation.id);
        persist(allocation, { hostId: enrollment.hostId, enrollment: { sealedToken: sealIntegration(enrollment.enrollmentToken, `cloud-enrollment:${allocation.id}`), expiresAt: enrollment.expiresAt } });
      });
    }
    if (allocation.enrollment!.expiresAt <= Date.now()) {
      persist(allocation, { status: "failed", error: "Cloud enrollment expired or its result was lost. Inspect private config and deliberately issue a new scoped enrollment; automatic duplicate enrollment is disabled." }); return;
    }
    // The shell expands only the env variable into stdin. It never enters argv or the service environment.
    const token = openIntegration(allocation.enrollment!.sealedToken, `cloud-enrollment:${allocation.id}`);
    await execute(`printf '%s' "$ORIGIN_ENROLLMENT_TOKEN" | ${asWorker(`${NODE} ${CLI} enroll --url ${q(release.origin)} --name ${q(allocation.name)} --kind ${allocation.provider} --config ${CONFIG}`)}`, { ORIGIN_ENROLLMENT_TOKEN: token });
  }
  await execute(asWorker(`if ! test -L ${DATA}/installation/current; then ${NODE} ${CLI} install --files-only --config ${CONFIG}; fi`));
  await execute(asWorker(`${NODE} ${CLI} resume --config ${CONFIG}`));
  await execute(asRoot(`set -eu; printf '%s' ${q(service)} > /etc/systemd/system/${UNIT}; chmod 644 /etc/systemd/system/${UNIT}; systemctl daemon-reload; systemctl start ${UNIT}; systemctl is-active --quiet ${UNIT}`));
  persist(allocation, { status: "ready", enrollment: undefined, runnerStoppedAt: undefined, stopRequestedAt: undefined, stopProof: undefined, error: undefined, lastActiveAt: Date.now() });
}
async function provision(record: PrivateRun) {
  const lockName = identity(record), owner = acquireExecutionLock(lockName, LOCK_MS);
  if (!owner) return;
  let allocation: Allocation | undefined;
  try {
    const rows = cloudAllocations(record.run.teamId).filter(row => row.ownerId === record.run.requestedBy && row.projectId === record.run.projectId && row.provider === record.policy.cloudProvider) as Allocation[];
    if (rows.length > 1) { reason(record, "Multiple cloud allocation journals require administrator reconciliation; no machine was created"); return; }
    allocation = rows[0];
    if (!pending(record, allocation)) return;
    let principal: ExecutionPrincipal;
    try { principal = await revalidateExecutionPrincipal(record); }
    catch { reason(record, "Cloud provisioning blocked: requester, issue or project authorization could not be revalidated"); return; }
    if (!principal.admin) { reason(record, "A workspace administrator must authorize the private cloud worker enrollment"); return; }
    if (!pending(record, allocation)) return;
    if (allocation?.recoveryRequired) { reason(record, allocation.error || "Private worker requires deliberate administrator recovery", true); return; }
    if (allocation?.hostId && executionUnstoppedHostRuns(allocation.hostId).length) {
      reason(record, "The existing private cloud worker still has an executing or uncertain run; no restart or duplicate enrollment is allowed"); return;
    }
    const maintenance = allocation ? cloudMaintenance(allocation) : undefined;
    if (maintenance) {
      reason(record, maintenance === "active"
        ? "The private cloud worker is performing requested maintenance; this run waits without provisioning a replacement"
        : "Cloud maintenance exceeded its thirty-minute allowance or has no valid timestamp. Inspect the worker and explicitly request maintenance again before resuming.", maintenance === "expired");
      return;
    }
    if (allocation?.hostId && readExecutionHost(allocation.hostId)?.revoked) { reason(record, "Cloud enrollment was revoked. An administrator must deliberately replace the scoped enrollment; no restart is allowed.", true); return; }
    if (allocation?.hostId && readExecutionHost(allocation.hostId)?.paused) { reason(record, "The existing private cloud worker is paused; resume it explicitly before resuming this run", true); return; }
    if (record.policy.machine !== "auto" && (!allocation || allocation.hostId !== record.policy.machine)) { reason(record, "Pinned cloud worker has no matching allocation; no replacement was created"); return; }
    if (!allocation && executionHosts(record.run.teamId).some(host => host.ownerId === record.run.requestedBy && host.kind === record.policy.cloudProvider && host.projectIds.includes(record.run.projectId))) {
      reason(record, "An existing cloud host has no allocation journal. An administrator must reconcile its provider identity; no duplicate private worker was created.", true); return;
    }
    const keys = credentials({ teamId: record.run.teamId, provider: record.policy.cloudProvider }, true);
    if (!keys) { reason(record, `${record.policy.cloudProvider} is disabled or its server-side API key is missing`); return; }
    const authorize = () => authorizeProvision(record, keys.stored.sealedKey!, allocation);
    let usage: StoredCloudProvider["usage"];
    try { usage = { ...await cloudAccountUsage({ provider: record.policy.cloudProvider, apiKey: keys.apiKey }), observedAt: Date.now() }; }
    catch { usage = { status: "unknown", observedAt: Date.now(), error: "Provider balance is unavailable; this is not confirmed exhaustion" }; }
    const latestProvider = executionSetting<StoredCloudProvider>(record.run.teamId, "cloud", record.policy.cloudProvider);
    if (!latestProvider || latestProvider.sealedKey !== keys.stored.sealedKey || !latestProvider.enabled) return;
    setExecutionSetting(record.run.teamId, "cloud", record.policy.cloudProvider, { ...latestProvider, usage });
    if (record.policy.cloudProvider === "boxd" && usage.status === "available" && typeof usage.balance === "number" && usage.balance <= 0) { reason(record, "Boxd reports zero remaining wallet credits; no account, subscription or Boat fallback was created"); return; }
    await authorize();
    if (!allocation) {
      const now = Date.now(), id = randomUUID();
      allocation = { id, teamId: record.run.teamId, ownerId: record.run.requestedBy, projectId: record.run.projectId, provider: record.policy.cloudProvider, status: "creating", name: `origin-${id}`, idempotencyKey: `origin-${id}`, createdAt: now, updatedAt: now, lastActiveAt: now };
      saveCloudAllocation(allocation);
      reason(record, `Creating one private ${allocation.provider} worker on the selected existing account. Native account login will still be required.`);
      // No other code path invokes create, including a known error or a missing find result.
      const machine = await createCloudMachine({ provider: allocation.provider, apiKey: keys.apiKey, name: allocation.name, idempotencyKey: allocation.idempotencyKey });
      persist(allocation, { machineId: machine.id, status: "starting" });
    } else if (!allocation.machineId) {
      const machine = await findCloudMachine({ provider: allocation.provider, apiKey: keys.apiKey, name: allocation.name, idempotencyKey: allocation.idempotencyKey });
      if (!machine) { persist(allocation, { status: "unknown", error: "Creation outcome unresolved. Provider lookup found no unambiguous private machine; automatic recreation is forbidden." }); reason(record, allocation.error!); return; }
      persist(allocation, { machineId: machine.id, status: "starting", error: undefined });
    }
    await authorize();
    if (allocation.status === "failed") { reason(record, allocation.error || "Private worker requires administrator recovery"); return; }
    if (allocation.status === "stopping") { reason(record, "Private worker stop is awaiting lifecycle confirmation"); return; }
    const machine = await getCloudMachine({ provider: allocation.provider, apiKey: keys.apiKey, id: allocation.machineId! });
    await authorize();
    if (machine.state === "unknown") { persist(allocation, { status: "unknown", error: "Provider machine state is unknown; no duplicate worker or replacement was created" }); reason(record, allocation.error!); return; }
    if (machine.state === "stopped") {
      if (!pending(record, allocation)) return;
      persist(allocation, { status: "starting", stopProof: undefined });
      await startCloudMachine({ provider: allocation.provider, apiKey: keys.apiKey, id: allocation.machineId! });
      await authorize();
      reason(record, `Starting the existing private ${allocation.provider} worker; native CLI login is preserved on its disk`); return;
    }
    if (machine.state === "starting") { reason(record, `${allocation.provider} private machine is starting`); return; }
    if (allocation.status !== "ready") {
      reason(record, `Bootstrapping the existing private ${allocation.provider} worker: verified runner release, Node 24, pinned coding CLIs and scoped enrollment. This does not authenticate a model account.`);
      await bootstrap(allocation, keys.apiKey, authorize);
    }
    if (blockIdleSetup(record, allocation)) return;
    const currentHost = allocation.hostId ? readExecutionHost(allocation.hostId) : undefined;
    reason(record, allocation.error || (currentHost?.lastSeenAt ? `Private ${allocation.provider} worker is available; the exact selected account, harness and model must be installed and logged in on this worker. No local OAuth tokens were copied.` : `Private ${allocation.provider} worker is awaiting its first heartbeat. Install the selected coding CLI and sign in on this private worker; enrollment is not model authentication.`));
  } catch (error) {
    if (error instanceof CloudProvisionDeferred) { reason(record, error.message); return; }
    const message = safeFailure(error);
    if (allocation) persist(allocation, { status: !allocation.machineId || error instanceof CloudProviderError && error.outcome === "unknown" ? "unknown" : "failed", error: message });
    reason(record, message);
  } finally { releaseExecutionLock(lockName, owner); }
}

function blockIdleSetup(record: PrivateRun, allocation: Allocation) {
  if (allocation.status !== "ready") return false;
  const current = unchangedQueued(record);
  if (!current || !route(current).needsCloud) return false;
  const host = allocation.hostId ? readExecutionHost(allocation.hostId) : undefined;
  if (host && Date.now() - host.lastSeenAt <= 45_000 && !host.activeRunIds.length && !host.paused && !host.revoked) {
    const accounts = executionAccounts(current.run.teamId, current.run.requestedBy);
    const bound = current.policy.fallback.some(selection => host.capabilities.includes(selection.harness) && accounts.some(account => account.id === selection.accountId && account.authenticated && account.hostIds.includes(host.id)));
    reason(current, bound
      ? "The private worker reports the account but no configured fallback is eligible. Check selected model/effort, confirmed quota reserves and previously attempted selections, then resume."
      : `Pinned coding CLIs are installed on the private ${allocation.provider} worker, but the selected native account is not authenticated there. Sign in as origin-runner in ${ROOT} and configure its local account binding; no Nix OAuth credentials were copied. Resume after setup.`, true);
    return true;
  }
  if (Date.now() - allocation.lastActiveAt > 5 * 60_000 && (!host || Date.now() - host.lastSeenAt > 45_000)) {
    reason(current, "Private worker did not establish a current heartbeat within five minutes. Check its systemd journal, public HTTPS controller reachability and scoped host config before resuming; it will not remain paid-idle indefinitely.", true);
    return true;
  }
  return false;
}

async function maintainAllocation(allocation: Allocation) {
  const name = allocationLock(allocation), owner = acquireExecutionLock(name, LOCK_MS);
  if (!owner) return;
  const latest = cloudAllocations(allocation.teamId).find(row => row.id === allocation.id);
  if (!latest) { releaseExecutionLock(name, owner); return; }
  allocation = latest as Allocation;
  try {
    const keys = credentials(allocation, false);
    if (!keys) return;
    if (!allocation.machineId) {
      const found = await findCloudMachine({ provider: allocation.provider, apiKey: keys.apiKey, name: allocation.name, idempotencyKey: allocation.idempotencyKey });
      if (!found) { persist(allocation, { status: "unknown", error: "Creation outcome unresolved. No unambiguous private machine was found; automatic recreation is forbidden." }); return; }
      persist(allocation, { machineId: found.id, status: "starting" });
    }
    if (!allocation.machineId) return;
    const input = { provider: allocation.provider, apiKey: keys.apiKey, id: allocation.machineId };
    const machine = await getCloudMachine(input);
    const observed = cloudAllocations(allocation.teamId).find(row => row.id === allocation.id);
    if (!observed || observed.machineId !== input.id || observed.provider !== input.provider) return;
    allocation = observed as Allocation;
    if (machine.state === "stopped") {
      const stopProof: CloudAllocation["stopProof"] = allocation.provider === "boxd"
        ? { kind: "provider-cold-stop", observedAt: Date.now(), machineId: allocation.machineId!, environmentClean: Boolean(allocation.runnerStoppedAt) }
        : allocation.runnerStoppedAt
          ? { kind: "guest-supervisor-stop", observedAt: allocation.runnerStoppedAt, machineId: allocation.machineId!, environmentClean: true }
          : undefined;
      // Boat can retain the machine after archival; archival alone is not process-stop proof.
      persist(allocation, { status: allocation.recoveryRequired ? "failed" : "stopped", stopProof });
      return;
    }
    if (allocation.stopProof) persist(allocation, { stopProof: undefined, ...(allocation.status === "stopped" ? { status: "starting" } : {}) });
    if (machine.state !== "running") return;
    const records = executionRuns(allocation.teamId, true);
    const executing = allocation.hostId ? executionUnstoppedHostRuns(allocation.hostId) : [];
    if (executing.length) {
      const record = executing[0];
      if (!allocation.runDeadline || allocation.runDeadline.runId !== record.run.id || allocation.runDeadline.attempt !== record.run.attempt) {
        // The attempt timestamp is immutable; heartbeat activity must never move this deadline.
        const startBound = Math.min(Date.now(), record.attemptStartedAt ?? record.run.createdAt);
        persist(allocation, { runDeadline: { runId: record.run.id, attempt: record.run.attempt, deadline: startBound + record.policy.timeoutSeconds * 1000 + 300_000 }, lastActiveAt: Date.now() });
      }
      const deadline = allocation.runDeadline!.deadline;
      if (Date.now() >= deadline) {
        persist(allocation, { status: "stopping", error: "Run deadline elapsed; awaiting verified process-stop evidence. Execution and environment cleanup are not yet confirmed." });
        await stopCloudMachine(input);
        return;
      }
      if (allocation.provider === "boat" && record.leaseHash && record.leaseExpiresAt > Date.now() && (!allocation.ttlRefreshedAt || Date.now() - allocation.ttlRefreshedAt > 60_000)) {
        await extendCloudMachine({ ...input, provider: "boat", ttlSeconds: Math.max(1, Math.floor((deadline - Date.now()) / 1000)) });
        persist(allocation, { ttlRefreshedAt: Date.now(), lastActiveAt: Date.now() });
      }
      return;
    }
    const maintenance = cloudMaintenance(allocation);
    if (maintenance === "active") return;
    let demand = false;
    const host = allocation.hostId ? readExecutionHost(allocation.hostId) : undefined;
    if (maintenance !== "expired" && keys.stored.enabled && !host?.revoked && !host?.paused) for (const record of records.filter(record => record.run.requestedBy === allocation.ownerId && record.run.projectId === allocation.projectId && record.policy.cloudProvider === allocation.provider && (record.policy.machine === "auto" || record.policy.machine === allocation.hostId) && record.run.status === "queued" && !record.cancelRequested)) {
      try { if (!(await revalidateExecutionPrincipal(record)).admin) continue; } catch { continue; }
      const currentHost = allocation.hostId ? readExecutionHost(allocation.hostId) : undefined;
      const current = pending(record, allocation);
      if (current && !currentHost?.revoked && !currentHost?.paused && executionSetting<StoredCloudProvider>(allocation.teamId, "cloud", allocation.provider)?.enabled && !blockIdleSetup(current, allocation)) { demand = true; break; }
    }
    if (maintenance !== "expired" && demand && allocation.status !== "stopping" && allocation.status !== "failed") return;
    if (maintenance !== "expired" && allocation.status !== "stopping" && Date.now() - allocation.lastActiveAt < IDLE_MS) return;
    // Claim checks this durable fence inside its own transaction before granting a lease.
    persist(allocation, { status: "stopping", stopRequestedAt: allocation.stopRequestedAt ?? Date.now() });
    if (allocation.hostId && executionUnstoppedHostRuns(allocation.hostId).length) return;
    if (!allocation.hostId || !allocation.bootstrapVerified || allocation.recoveryRequired && !executionHostHasAttempt(allocation.hostId)) {
      // The claim fence and absence of any attempted run prove no run environment was delivered.
      await stopCloudMachine(input); return;
    }
    if (Date.now() - allocation.stopRequestedAt! >= 5 * 60_000) {
      persist(allocation, { runnerStoppedAt: undefined, error: "Idle worker did not acknowledge cleanup within five minutes. Provider stop was requested; environment cleanup is unconfirmed. Boat archival alone cannot prove process termination." });
      await stopCloudMachine(input); return;
    }
    const requestedAt = Date.now();
    await command(allocation, keys.apiKey, asWorker(`${NODE} ${CLI} stop --config ${CONFIG}`));
    const receipt = await command(allocation, keys.apiKey, asWorker(`${NODE} --input-type=module -e ${q(`import {readFile} from 'node:fs/promises';const s=JSON.parse(await readFile(${JSON.stringify(`${DATA}/status.json`)},'utf8'));console.log(JSON.stringify({stopped:s.stopped===true,activeRunId:s.activeRunId,updatedAt:s.updatedAt}));`)}`));
    const status = JSON.parse(receipt) as { stopped?: boolean; activeRunId?: string | null; updatedAt?: number };
    // Old receipts do not prove the current service stopped. systemd state is checked as well.
    const inactive = await command(allocation, keys.apiKey, asRoot(`if systemctl is-active --quiet ${UNIT}; then printf active; else printf inactive; fi`));
    if (!status.stopped || status.activeRunId || typeof status.updatedAt !== "number" || status.updatedAt < allocation.lastActiveAt || inactive !== "inactive") return;
    persist(allocation, { runnerStoppedAt: Math.min(requestedAt, status.updatedAt) });
    await stopCloudMachine(input);
    // A subsequent provider observation records the separate Boxd or verified guest receipt.
  } catch (error) { persist(allocation, { error: safeFailure(error) }); }
  finally { releaseExecutionLock(name, owner); }
}

export async function maintainCloudExecution(teamId: string): Promise<void> {
  if (!teamId.trim()) throw new CloudRuntimePrerequisiteError("A controller workspace is required");
  for (const allocation of cloudAllocations(teamId) as Allocation[]) if (allocation.teamId === teamId) await maintainAllocation(allocation);
  for (const record of executionRuns(teamId, true)) {
    if (record.run.teamId !== teamId || record.run.status !== "queued" || !record.run.processStopped || record.cancelRequested) continue;
    const routing = route(record);
    if (!routing.needsCloud && !cloudAllocations(teamId).some(allocation => allocation.ownerId === record.run.requestedBy && allocation.projectId === record.run.projectId && allocation.provider === record.policy.cloudProvider && allocation.status !== "ready" && allocation.hostId === routing.host?.id && routing.host?.kind === allocation.provider)) continue;
    await provision(record);
  }
}

export function cloudExecutionStopProof(teamId: string, hostId: string) {
  if (!teamId.trim()) return undefined;
  const matches = (cloudAllocations(teamId) as Allocation[]).filter(row => row.teamId === teamId && row.hostId === hostId);
  if (matches.length !== 1) return undefined;
  const allocation = matches[0], proof = allocation.stopProof;
  if (!proof || proof.machineId !== allocation.machineId || !["stopped", "failed"].includes(allocation.status)) return undefined;
  return { ...proof, ...(allocation.runDeadline ? { runId: allocation.runDeadline.runId, attempt: allocation.runDeadline.attempt } : {}) };
}
