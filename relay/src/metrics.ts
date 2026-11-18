import { timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
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

/** Gauges whose highest value of each UTC day this node keeps, today's and the day before's. */
export type PeakName = "hosts_connected" | "sessions_spliced" | "sockets_open";
const PEAKS: Record<PeakName, string> = {
  hosts_connected: "Most hosts with a control socket at once on this node, by UTC day (today and the day before)",
  sessions_spliced: "Most phone sessions spliced at once on this node, by UTC day (today and the day before)",
  sockets_open: "Most WebSockets held at once on this node, by UTC day (today and the day before)",
};
/** The gauge each peak follows; a scrape counts toward the peak too, so a day with no rise still starts from what is held. */
const PEAK_OF: Record<string, PeakName> = {
  relay_hosts_connected: "hosts_connected",
  relay_sessions_spliced: "sessions_spliced",
  relay_sockets_open: "sockets_open",
};
const DAY_S = 86_400;

/**
 * A gauge's highest value per UTC day. A scraper that misses minutes (or scrapes rarely) still reads the day's true peak
 * since this process started; the day before is kept so the last minutes of a day are not lost at midnight.
 */
class DailyPeak {
  private day = -1;
  private today = 0;
  private yesterday: { day: number; value: number } | undefined;

  see(value: number, day: number): void {
    this.roll(day);
    if (value > this.today) this.today = value;
  }

  values(day: number): { day: number; value: number }[] {
    this.roll(day);
    return [...(this.yesterday && this.yesterday.day === day - 1 ? [this.yesterday] : []), { day, value: this.today }];
  }

  private roll(day: number): void {
    if (day === this.day) return;
    this.yesterday = this.day === day - 1 ? { day: this.day, value: this.today } : undefined;
    this.day = day;
    this.today = 0;
  }
}

const isoDay = (day: number) => new Date(day * DAY_S * 1000).toISOString().slice(0, 10);

const LAG_TICK_MS = 100;
const LAG_SAMPLES_MAX = 4_096;

/** How late a 100 ms timer fires, sample by sample: the time the event loop was busy with something else. */
class LoopLag {
  private samples: number[] = [];
  private last = performance.now();
  private readonly timer = setInterval(() => {
    const now = performance.now();
    if (this.samples.length < LAG_SAMPLES_MAX) this.samples.push(Math.max(0, now - this.last - LAG_TICK_MS));
    this.last = now;
  }, LAG_TICK_MS);

  constructor() {
    this.timer.unref();
  }

  /** p99 and max in seconds since the last call. */
  take(): { p99: number; max: number } {
    const sorted = this.samples.sort((a, b) => a - b);
    this.samples = [];
    if (sorted.length === 0) return { p99: 0, max: 0 };
    return { p99: sorted[Math.floor(0.99 * (sorted.length - 1))]! / 1000, max: sorted.at(-1)! / 1000 };
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

export class Metrics {
  private readonly counts = new Map<string, number>();
  private readonly lag = new LoopLag();
  private readonly peaks = new Map<PeakName, DailyPeak>();
  private readonly utcDay: () => number;

  /** `wallSeconds` is the clock the daily peaks are bucketed by. */
  constructor(wallSeconds: () => number = () => Date.now() / 1000) {
    this.utcDay = () => Math.floor(wallSeconds() / DAY_S);
  }

  inc(name: CounterName, label?: string | number, by = 1): void {
    const key = label === undefined ? name : `${name}\u0000${label}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  count(name: CounterName, label?: string | number): number {
    return this.counts.get(label === undefined ? name : `${name}\u0000${label}`) ?? 0;
  }

  /** Records a gauge's current value toward today's peak. Call it where the gauge goes up. */
  peak(name: PeakName, value: number): void {
    let peak = this.peaks.get(name);
    if (!peak) this.peaks.set(name, (peak = new DailyPeak()));
    peak.see(value, this.utcDay());
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
    for (const { name, value } of gauges) if (PEAK_OF[name]) this.peak(PEAK_OF[name], value);
    const day = this.utcDay();
    for (const [name, help] of Object.entries(PEAKS) as [PeakName, string][]) {
      lines.push(`# HELP relay_${name}_peak ${help}`, `# TYPE relay_${name}_peak gauge`);
      const values = this.peaks.get(name)?.values(day) ?? [{ day, value: 0 }];
      for (const { day: at, value } of values) lines.push(`relay_${name}_peak{day="${isoDay(at)}"} ${value}`);
    }
    const usage = process.cpuUsage();
    const memory = process.memoryUsage();
    const lag = this.lag.take();
    const all: Gauge[] = [
      ...gauges,
      { name: "relay_event_loop_lag_p99_seconds", help: "Event-loop lag p99 since the last scrape", value: lag.p99 },
      { name: "relay_event_loop_lag_max_seconds", help: "Event-loop lag max since the last scrape", value: lag.max },
      { name: "process_resident_memory_bytes", help: "Resident memory", value: memory.rss },
      { name: "process_heap_used_bytes", help: "V8 heap in use", value: memory.heapUsed },
      { name: "process_cpu_seconds_total", help: "User and system CPU time", value: (usage.user + usage.system) / 1e6 },
      { name: "process_start_time_seconds", help: "Start time, Unix seconds", value: Math.round(Date.now() / 1000 - process.uptime()) },
    ];
    for (const { name, help, value } of all) {
      const type = name.endsWith("_total") ? "counter" : "gauge";
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${Number.isFinite(value) ? value : 0}`);
    }
    return `${lines.join("\n")}\n`;
  }

  close(): void {
    this.lag.stop();
  }
}

/** Compares a bearer header with the configured token in constant time; both sides are hashed to one length first. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return timingSafeEqual(sha256(presented), sha256(token)) && presented.length > 0;
}
