// The bot's own MCP servers: a local command the user chose, spawned for
// this bot's turns and handed to whichever engine it runs on.
//
// The renderer never holds an env VALUE — the server sends `KEY: true`,
// and sending that back means "keep what is stored". So editing a server's
// name or command carries its secrets across without them ever having been
// here, and the only way to change a value is to type a new one.
import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { useStore, type Bot, type McpServer } from "@/state/store";
import { cn } from "@/lib/cn";

/** "-y @scope/pkg --root ~/work" → argv. Quoting is deliberately not
 * supported: a path with spaces belongs in env, and a half-implemented
 * shell parser is worse than none. */
export function parseArgs(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/** "KEY=value" per line → env. A line with no `=` is ignored rather than
 * saved as an empty variable. */
export function parseEnvLines(value: string) {
  const env: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) env[key] = line.slice(at + 1).trim();
  }
  return env;
}

type Draft = { name: string; command: string; args: string; env: string };
const EMPTY: Draft = { name: "", command: "", args: "", env: "" };

export function McpServersCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const servers = bot.mcpServers ?? [];

  const save = (next: McpServer[]) => {
    setError(null);
    dispatch({ type: "updateBot", botId: bot.id, patch: { mcpServers: next } });
  };

  const add = () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.command.trim()) {
      setError("A server needs a name and a command.");
      return;
    }
    save([
      ...servers,
      {
        // the server assigns the real id; this one is replaced on the way in
        id: "",
        name: draft.name.trim(),
        command: draft.command.trim(),
        args: parseArgs(draft.args),
        env: parseEnvLines(draft.env),
        enabled: true,
      },
    ]);
    setDraft(null);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-ink">MCP servers</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Tools of your own for this bot. Each one is a command on this computer, started when the bot works.
          </div>
        </div>
        {!draft && (
          <button
            onClick={() => setDraft(EMPTY)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
          >
            <Plus size={14} /> Add
          </button>
        )}
      </div>

      {servers.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {servers.map((server, i) => (
            <div key={server.id || i} className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] text-ink">{server.name}</div>
                <div className="truncate font-mono text-[11.5px] text-ink-secondary">
                  {server.command} {server.args.join(" ")}
                </div>
                {Object.keys(server.env).length > 0 && (
                  <div className="mt-0.5 truncate text-[11px] text-ink-secondary">
                    {Object.keys(server.env).join(", ")} · set
                  </div>
                )}
              </div>
              <button
                role="switch"
                aria-checked={server.enabled}
                aria-label={`${server.name} enabled`}
                onClick={() => save(servers.map((s, j) => (j === i ? { ...s, enabled: !s.enabled } : s)))}
                className={cn(
                  "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
                  server.enabled ? "bg-accent" : "bg-control",
                )}
              >
                <span
                  className={cn(
                    "absolute top-[3px] size-4 rounded-full bg-white transition-all",
                    server.enabled ? "left-[19px]" : "left-[3px]",
                  )}
                />
              </button>
              <button
                onClick={() => save(servers.filter((_, j) => j !== i))}
                aria-label={`Remove ${server.name}`}
                className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg bg-inset p-3">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium text-ink">New server</div>
            <button onClick={() => setDraft(null)} aria-label="Cancel" className="rounded p-1 text-ink-secondary hover:text-ink">
              <X size={14} />
            </button>
          </div>
          {(
            [
              ["name", "Name", "Filesystem"],
              ["command", "Command", "npx"],
              ["args", "Arguments", "-y @modelcontextprotocol/server-filesystem ~/work"],
            ] as const
          ).map(([field, label, placeholder]) => (
            <label key={field} className="flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-secondary">{label}</span>
              <input
                value={draft[field]}
                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                placeholder={placeholder}
                className="rounded-lg bg-control px-2.5 py-1.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
              />
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-secondary">Environment — one KEY=value per line</span>
            <textarea
              value={draft.env}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })}
              rows={2}
              placeholder="API_TOKEN=…"
              className="resize-none rounded-lg bg-control px-2.5 py-1.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
            />
          </label>
          <div className="text-[11px] text-ink-secondary">
            Values are kept on this computer, in the same file as your other credentials, and are never shown again.
          </div>
          {error && <div className="text-[12px] text-danger">{error}</div>}
          <button
            onClick={add}
            className="mt-1 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white hover:brightness-110"
          >
            Add server
          </button>
        </div>
      )}
    </div>
  );
}
