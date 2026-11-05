import { timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { sha256 } from "./wire.ts";

const COUNTERS = {
  relay_upgrades_total: { help: "WebSocket upgrades accepted, by route", label: "route" },
  relay_refused_total: { help: "Connections refused before or at the upgrade, by reason", label: "reason" },
  relay_closes_total: { help: "Sockets the relay closed, by close code", label: "code" },
  relay_token_rejected_total: { help: "Host tokens rejected, by reason", label: "reason" },
  relay_bytes_total: { help: "Payload bytes forwarded, up = phone to host, down = host to phone", label: "dir" },
  relay_sessions_total: { help: "Phone sessions spliced to a host", label: undefined },
  relay_backpressure_pauses_total: { help: "Times a source was paused because its destination was behind", label: undefined },
  relay_throttled_sessions_total: { help: "Sessions held to the heavy-session rate", label: undefined },
  relay_host_budget_exceeded_total: { help: "Hosts that used their daily byte budget", label: undefined },
  relay_pong_timeouts_total: { help: "Sockets cut for not answering a ping", label: undefined },
} as const;

export type CounterName = keyof typeof COUNTERS;

export interface Gauge {
  name: string;
  help: string;
  value: number;
}

export class Metrics {
  private readonly counts = new Map<string, number>();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });

  constructor() {
    this.loopDelay.enable();
  }

  inc(name: CounterName, label?: string | number, by = 1): void {
    const key = label === undefined ? name : `${name}\u0000${label}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  count(name: CounterName, label?: string | number): number {
    return this.counts.get(label === undefined ? name : `${name}\u0000${label}`) ?? 0;
  }

  /** Prometheus text format. The event-loop lag window restarts at each render, so it covers one scrape interval. */
  render(gauges: Gauge[]): string {
    const lines: string[] = [];
    for (const [name, { help, label }] of Object.entries(COUNTERS)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      const series = [...this.counts].filter(([key]) => key === name || key.startsWith(`${name}\u0000`));
      if (series.length === 0 && label === undefined) lines.push(`${name} 0`);
      for (const [key, value] of series) {
        const at = key.indexOf("\u0000");
        lines.push(at < 0 ? `${name} ${value}` : `${name}{${label}="${key.slice(at + 1)}"} ${value}`);
      }
    }
    const usage = process.cpuUsage();
    const memory = process.memoryUsage();
    const all: Gauge[] = [
      ...gauges,
      { name: "relay_event_loop_lag_p99_seconds", help: "Event-loop delay p99 since the last scrape", value: this.loopDelay.percentile(99) / 1e9 },
      { name: "relay_event_loop_lag_max_seconds", help: "Event-loop delay max since the last scrape", value: this.loopDelay.max / 1e9 },
      { name: "process_resident_memory_bytes", help: "Resident memory", value: memory.rss },
      { name: "process_heap_used_bytes", help: "V8 heap in use", value: memory.heapUsed },
      { name: "process_cpu_seconds_total", help: "User and system CPU time", value: (usage.user + usage.system) / 1e6 },
      { name: "process_start_time_seconds", help: "Start time, Unix seconds", value: Math.round(Date.now() / 1000 - process.uptime()) },
    ];
    this.loopDelay.reset();
    for (const { name, help, value } of all) {
      const type = name.endsWith("_total") ? "counter" : "gauge";
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${Number.isFinite(value) ? value : 0}`);
    }
    return `${lines.join("\n")}\n`;
  }

  close(): void {
    this.loopDelay.disable();
  }
}

/** Compares a bearer header with the configured token in constant time; both sides are hashed to one length first. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(sha256(presented), sha256(token)) && presented.length > 0;
}
