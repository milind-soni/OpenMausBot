// The fake `bw` as its own process, for a server that runs the tool it installed: the launcher a test writes at the
// tool's path sets FAKE_BW_VAULT to a JSON account (fake-bw.ts FakeBwAccount) and imports this. What the tool keeps
// between calls (its server, who is signed in, the open sessions) lives in its settings folder, as the real one's does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeBw, type FakeBwAccount } from "./fake-bw.ts";

const account = JSON.parse(readFileSync(process.env.FAKE_BW_VAULT!, "utf8")) as FakeBwAccount;
const folder = process.env.BITWARDENCLI_APPDATA_DIR!;
const stateFile = join(folder, "fake-bw-state.json");
const fake = fakeBw(account);
const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as { server?: string | null; signedIn?: string | null; sessions?: string[] } : {};
fake.state.server = saved.server ?? null;
fake.state.signedIn = saved.signedIn ?? null;
for (const session of saved.sessions ?? []) fake.state.sessions.add(session);
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].startsWith("BW_") && typeof entry[1] === "string"));
const result = await fake.run(process.argv.slice(2), env);
mkdirSync(folder, { recursive: true });
writeFileSync(stateFile, JSON.stringify({ server: fake.state.server, signedIn: fake.state.signedIn, sessions: [...fake.state.sessions] }));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
