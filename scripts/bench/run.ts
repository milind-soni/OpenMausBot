// Headless bench driver (docs/plans/2026-09-14-phase-0-foundation.md, 0.8).
//
//   node --experimental-strip-types scripts/bench/run.ts \
//     --url http://127.0.0.1:PORT --bot BOT_ID --task "text" | --task @file \
//     [--cwd DIR] [--budget steps=200,tokens=400000,minutes=30] \
//     [--network allow=host1,host2] [--out DIR] [--poll-ms 500]
//
// Runs ONE task on ONE bot as an unattended launch (the way a routine runs),
// waits for it to settle or run out of budget, and writes result.json and
// trajectory.json under --out. Exit 0 when the run settled, 2 otherwise.
// The URL is explicit on purpose (see docs/verification/README.md): a bench
// must never find its way to the user's running app by accident.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Args {
  url: string;
  bot: string;
  task: string;
  cwd?: string;
  budget?: string;
  network?: { allow: string[] };
  out?: string;
  pollMs: number;
}

export function parseBenchArgs(argv: string[]): Args {
  const take = (i: number, flag: string) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  const args: Partial<Args> = { pollMs: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    switch (flag) {
      case "--url": args.url = take(i, flag).replace(/\/+$/, ""); i += 1; break;
      case "--bot": args.bot = take(i, flag); i += 1; break;
      case "--task": {
        const value = take(i, flag);
        args.task = value.startsWith("@") ? readFileSync(resolve(value.slice(1)), "utf8") : value;
        i += 1;
        break;
      }
      case "--cwd": args.cwd = resolve(take(i, flag)); i += 1; break;
      case "--budget": args.budget = take(i, flag); i += 1; break;
      case "--network": {
        const value = take(i, flag);
        const match = /^allow=(.*)$/.exec(value);
        if (!match) throw new Error("--network takes allow=host1,host2");
        args.network = { allow: match[1]!.split(",").map((h) => h.trim()).filter(Boolean) };
        i += 1;
        break;
      }
      case "--out": args.out = resolve(take(i, flag)); i += 1; break;
      case "--poll-ms": args.pollMs = Number(take(i, flag)) || 500; i += 1; break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!args.url || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(args.url)) throw new Error("--url must be an explicit loopback harness URL");
  if (!args.bot) throw new Error("--bot is required");
  if (!args.task?.trim()) throw new Error("--task is required (text, or @file)");
  return args as Args;
}

async function call(url: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: url, ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}`);
  return body;
}

export async function runBench(args: Args): Promise<{ result: any; trajectory: any }> {
  const started = await call(args.url, "/api/bench/run", {
    method: "POST",
    body: JSON.stringify({ botId: args.bot, task: args.task, cwd: args.cwd, budget: args.budget, network: args.network }),
  });
  const id = started.run.id as string;
  for (;;) {
    const current = await call(args.url, `/api/bench/runs/${id}`);
    if (current.run.status !== "running") {
      if (args.out) {
        mkdirSync(args.out, { recursive: true });
        writeFileSync(join(args.out, "result.json"), JSON.stringify(current.run, null, 2));
        writeFileSync(join(args.out, "trajectory.json"), JSON.stringify(current.trajectory ?? null, null, 2));
      }
      return { result: current.run, trajectory: current.trajectory };
    }
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
}

if (process.argv[1] && /scripts[\\/]bench[\\/]run\.ts$/.test(process.argv[1])) {
  runBench(parseBenchArgs(process.argv.slice(2)))
    .then(({ result }) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result.status === "settled" ? 0 : 2);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
