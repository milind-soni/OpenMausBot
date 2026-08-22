import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import * as Sentry from "@sentry/node";

import { protectedEnvironmentValues, redactKnownValues, redactSecrets } from "./redact.ts";
import type { TelemetryEnvelope, TelemetryErrorEnvelope, TelemetryTraceEnvelope } from "./telemetry-protocol.ts";

interface RuntimeConfig {
  schema: "openmaus.telemetry-sink-runtime.v1";
  kind: "sentry" | "langfuse";
  release: string;
  environment: string;
  langfuseBaseUrl: string;
}

function loadRuntimeConfig(): RuntimeConfig {
  const value = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Partial<RuntimeConfig>;
  if (
    value.schema !== "openmaus.telemetry-sink-runtime.v1" ||
    !["sentry", "langfuse"].includes(String(value.kind)) ||
    typeof value.release !== "string" ||
    typeof value.environment !== "string" ||
    typeof value.langfuseBaseUrl !== "string"
  ) {
    throw new Error("invalid telemetry sink runtime configuration");
  }
  return value as RuntimeConfig;
}

const runtime = loadRuntimeConfig();
const kind = runtime.kind;
const protectedValues = protectedEnvironmentValues();

function sanitize<T>(input: T): T {
  return redactKnownValues(redactSecrets(input), protectedValues) as T;
}

function status(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(sanitize(value))}\n`);
}

let sdk: NodeSDK | null = null;
let langfuseProcessor: LangfuseSpanProcessor | null = null;

if (kind === "sentry") {
  if (!process.env.SENTRY_DSN) throw new Error("Sentry telemetry credential was not injected");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: runtime.release,
    environment: runtime.environment,
    sendDefaultPii: false,
    beforeSend: (event) => sanitize(event),
  });
} else if (kind === "langfuse") {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    throw new Error("Langfuse telemetry credentials were not injected");
  }
  langfuseProcessor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: runtime.langfuseBaseUrl,
    environment: runtime.environment,
    release: runtime.release,
    mediaUploadEnabled: false,
    exportMode: "immediate",
    mask: ({ data }) => sanitize(data),
  });
  sdk = new NodeSDK({ spanProcessors: [langfuseProcessor] });
  sdk.start();
} else {
  throw new Error("unknown telemetry sink kind");
}

function sentryError(envelope: TelemetryErrorEnvelope): void {
  const clean = sanitize(envelope);
  const error = new Error(clean.message);
  error.name = clean.name || "OpenMausBotError";
  if (clean.stack) error.stack = clean.stack;
  Sentry.withScope((scope) => {
    scope.setTags({
      application: clean.application,
      component: clean.component,
      bot_id: clean.botId ?? "",
      thread_id: clean.threadId ?? "",
      turn_id: clean.turnId ?? "",
      engine: clean.engine ?? "",
      model: clean.model ?? "",
      release: clean.release,
      source_sha: clean.sourceSha,
      correlation_id: clean.correlationId,
      trace_id: clean.traceId ?? "",
    });
    scope.setContext("openmausbot", {
      diagnostic_summary: clean.message.slice(0, 1_000),
      ...(clean.diagnostics ? { diagnostics: clean.diagnostics } : {}),
      at: clean.at,
    });
    Sentry.captureException(error);
  });
}

function langfuseTrace(envelope: TelemetryTraceEnvelope): void {
  const clean = sanitize(envelope);
  const release = runtime.release || clean.release;
  const metadata = {
    application: clean.application,
    botId: clean.botId,
    botName: clean.botName,
    threadId: clean.threadId,
    turnId: clean.turnId,
    sourceSha: clean.sourceSha,
    traceId: clean.traceId,
    correlationId: clean.correlationId,
    engine: clean.engine,
    outcome: clean.outcome,
    release,
  };
  const tags = [
    `application=${clean.application}`,
    `bot_id=${clean.botId}`,
    `thread_id=${clean.threadId}`,
    `turn_id=${clean.turnId}`,
    `source_sha=${clean.sourceSha}`,
    `openmaus_trace_id=${clean.traceId}`,
  ];
  propagateAttributes(
    {
      traceName: "openmausbot-turn",
      sessionId: clean.threadId,
      tags,
      metadata,
      version: clean.sourceSha,
      environment: runtime.environment,
    },
    () => {
      const root = startObservation(
        "openmausbot-turn",
        {
          input: { summary: clean.promptSummary },
          output: { summary: clean.responseSummary, outcome: clean.outcome },
          metadata,
          version: clean.sourceSha,
          environment: runtime.environment,
          level: clean.outcome === "failed" ? "ERROR" : "DEFAULT",
          ...(clean.errorSummary ? { statusMessage: clean.errorSummary } : {}),
        },
        { asType: "agent", startTime: new Date(clean.startedAt) },
      );
      const generation = startObservation(
        "model-generation",
        {
          input: { summary: clean.promptSummary },
          output: { summary: clean.responseSummary },
          model: clean.model,
          metadata: { engine: clean.engine },
          ...(clean.usage ? { usageDetails: { input: clean.usage.input, output: clean.usage.output } } : {}),
          level: clean.outcome === "failed" ? "ERROR" : "DEFAULT",
        },
        {
          asType: "generation",
          startTime: new Date(clean.startedAt),
          parentSpanContext: root.otelSpan.spanContext(),
        },
      );
      generation.end(new Date(clean.endedAt));
      for (const tool of clean.tools) {
        const observation = startObservation(
          tool.name || "tool",
          {
            input: { itemId: tool.id },
            output: { ok: tool.ok },
            metadata: { itemId: tool.id },
            level: tool.ok ? "DEFAULT" : "ERROR",
          },
          {
            asType: "tool",
            startTime: new Date(tool.startedAt),
            parentSpanContext: root.otelSpan.spanContext(),
          },
        );
        observation.end(new Date(tool.endedAt));
      }
      root.end(new Date(clean.endedAt));
    },
  );
}

async function handle(envelope: TelemetryEnvelope): Promise<void> {
  if (kind === "sentry" && envelope.kind === "error") sentryError(envelope);
  if (kind === "langfuse" && envelope.kind === "trace") langfuseTrace(envelope);
  if (kind === "sentry") await Sentry.flush(5_000);
  else await langfuseProcessor?.forceFlush();
}

status({ kind: "ready", sink: kind });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    try {
      const envelope = JSON.parse(line) as TelemetryEnvelope;
      await handle(sanitize(envelope));
      status({ kind: "sent", sink: kind, correlationId: envelope.correlationId });
    } catch (error) {
      status({ kind: "error", sink: kind, message: error instanceof Error ? error.message : String(error) });
    }
  })();
});

async function shutdown(): Promise<void> {
  lines.close();
  if (kind === "sentry") await Sentry.close(5_000);
  if (sdk) await sdk.shutdown();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown().finally(() => process.exit(0)));
}
process.stdin.once("end", () => void shutdown().finally(() => process.exit(0)));
