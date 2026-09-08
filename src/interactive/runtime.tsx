import React, { useEffect, useId } from "react";
import { createRoot } from "react-dom/client";
import {
  createLibrary,
  defineComponent,
  Renderer,
  reactive,
  useStateField,
  createParser,
} from "@openuidev/react-lang";
import { z } from "zod";
import { usesComparisonColumns, validateInteractiveSource } from "../../shared/interactive-reply";

const str = z.string().max(4000);
const num = z.number().finite().min(-1e12).max(1e12);
const children = z.array(z.any()).max(64);
const labels = z.array(str).min(1).max(100);
const matrix = z.array(z.array(num).max(100)).max(100);
let token = "";
let words = { draft: "Add to reply", drafted: "Added to your reply", table: "View data" };
/** Send a nonce-tagged runtime event to the parent; the host validates its source. */
const post = (type: string, value?: unknown) =>
  parent.postMessage({ channel: "omb-interactive-v1", token, type, value }, "*");
/** Format evaluated display values without interpreting markup or executable text. */
const format = (value: unknown) =>
  typeof value === "number"
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
    : String(value ?? "");

/** Report persistent invalid props after reactive defaults have had time to settle. */
function InvalidProps({ name }: { name: string }) {
  // OpenUI initializes reactive defaults in an effect. An unresolved first
  // render is transient; report only if validation still fails afterwards.
  useEffect(() => {
    const timer = setTimeout(() => reportError(`Invalid ${name} properties`), 0);
    return () => clearTimeout(timer);
  }, [name]);
  return null;
}

// Every renderer validates evaluated props. No prop spreading, HTML, URLs,
// arbitrary styles, event source, or tool provider crosses into these views.
/** Wrap a catalog view with validation of every evaluated non-binding property. */
function component<T extends z.ZodObject>(
  name: string,
  props: T,
  render: React.FC<{ props: z.infer<T>; renderNode: (value: unknown) => React.ReactNode }>,
) {
  const View = render;
  return defineComponent({
    name,
    props,
    description: name,
    component: (input) => {
      const result = props.safeParse(input.props);
      if (!result.success) return <InvalidProps name={name} />;
      return <View props={result.data} renderNode={input.renderNode} />;
    },
  });
}
// Reactive props are interpreter binding objects. They are resolved only by
// useStateField; the typed schema retains the expected primitive for the parser.
/** Annotate a cloned schema as a mutable OpenUI binding without altering its caller. */
function field<T extends z.ZodType>(schema: T) {
  return reactive(schema.clone());
}
const Stack = component("Stack", z.object({ children }), ({ props, renderNode }) => (
  <div className="stack">
    {props.children.map((child, i) => (
      <React.Fragment key={i}>{renderNode(child)}</React.Fragment>
    ))}
  </div>
));
const Grid = component("Grid", z.object({ children }), ({ props, renderNode }) => {
  // Columns communicate comparison, not arbitrary adjacency. A generated
  // slider + result, or unlike form fields, stays one readable vertical flow.
  const peers = usesComparisonColumns(props.children);
  return (
    <div className={peers ? "grid" : "stack"} data-layout={peers ? "comparison" : "flow"}>
      {props.children.map((child, i) => (
        <div key={i}>{renderNode(child)}</div>
      ))}
    </div>
  );
});
const Card = component("Card", z.object({ title: str, children }), ({ props, renderNode }) => (
  <section className="card stack">
    <h3>{props.title}</h3>
    {props.children.map((child, i) => (
      <React.Fragment key={i}>{renderNode(child)}</React.Fragment>
    ))}
  </section>
));
const Text = component("Text", z.object({ text: str }), ({ props }) => <p>{props.text}</p>);
const Heading = component("Heading", z.object({ text: str }), ({ props }) => <h3>{props.text}</h3>);
const Details = component("Details", z.object({ title: str, children }), ({ props, renderNode }) => (
  <details>
    <summary>{props.title}</summary>
    <div className="stack">
      {props.children.map((child, i) => (
        <React.Fragment key={i}>{renderNode(child)}</React.Fragment>
      ))}
    </div>
  </details>
));

// Zod's reactive annotation is prompt metadata, not a runtime union. Validate
// binding descriptors separately while keeping scalar schemas in the catalog.
/** Validate control props while letting useStateField resolve binding descriptors. */
function control<T extends z.ZodObject>(name: string, props: T, render: React.FC<{ props: z.infer<T> }>) {
  const View = render;
  return defineComponent({
    name,
    props,
    description: name,
    component: ({ props: values }) => {
      const binding = values.value;
      const isBinding = binding && typeof binding === "object" && "__reactive" in binding;
      const rest = props.omit({ value: true }).safeParse(values);
      if (!rest.success || (!isBinding && !props.shape.value.safeParse(binding).success))
        return <InvalidProps name={name} />;
      return <View props={values} />;
    },
  });
}
const Choice = control(
  "Choice",
  z.object({ label: str, options: labels, value: field(str) }),
  ({ props }) => {
    const state = useStateField(props.label, props.value);
    return (
      <fieldset>
        <legend>{props.label}</legend>
        <div className="choices">
          {props.options.map((option, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={state.value === option}
              onClick={() => state.setValue(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </fieldset>
    );
  },
);
const MultiChoice = control(
  "MultiChoice",
  z.object({ label: str, options: labels, value: field(z.array(str).max(100)) }),
  ({ props }) => {
    const state = useStateField(props.label, props.value);
    const selected = Array.isArray(state.value) ? state.value : [];
    return (
      <fieldset>
        <legend>{props.label}</legend>
        <div className="choices">
          {props.options.map((option, i) => (
            <label className="check" key={i}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() =>
                  state.setValue(
                    selected.includes(option)
                      ? selected.filter((item) => item !== option)
                      : [...selected, option],
                  )
                }
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>
    );
  },
);
const Input = control("Input", z.object({ label: str, value: field(str) }), ({ props }) => {
  const state = useStateField(props.label, props.value);
  const id = useId();
  return (
    <label htmlFor={id}>
      {props.label}
      <input
        id={id}
        type="text"
        maxLength={4000}
        value={String(state.value ?? "")}
        onChange={(e) => state.setValue(e.target.value)}
      />
    </label>
  );
});
const numericProps = z.object({ label: str, min: num, max: num, step: num.positive(), value: field(num) });
/** Share bounded numeric editing between sliders and number fields; invalid
 * ranges produce a source fallback rather than throwing during rendering. */
function Numeric({ props, range }: { props: z.infer<typeof numericProps>; range: boolean }) {
  const state = useStateField(props.label, props.value);
  const id = useId();
  if (props.max <= props.min) return <InvalidProps name="input range" />;
  const value =
    typeof state.value === "number" && Number.isFinite(state.value)
      ? Math.max(props.min, Math.min(props.max, state.value))
      : props.min;
  return (
    <label htmlFor={id}>
      <span className="label-row">
        {props.label}
        {range && <output>{format(value)}</output>}
      </span>
      <input
        id={id}
        type={range ? "range" : "number"}
        min={props.min}
        max={props.max}
        step={props.step}
        value={value}
        onChange={(e) => {
          const value = Number(e.target.value);
          if (Number.isFinite(value)) state.setValue(Math.max(props.min, Math.min(props.max, value)));
        }}
      />
    </label>
  );
}
const Slider = control("Slider", numericProps, ({ props }) => <Numeric props={props} range />);
const NumberInput = control("NumberInput", z.object({ ...numericProps.shape }), ({ props }) => (
  <Numeric props={props} range={false} />
));
const Toggle = control("Toggle", z.object({ label: str, value: field(z.boolean()) }), ({ props }) => {
  const state = useStateField(props.label, props.value);
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={state.value === true}
        onChange={(e) => state.setValue(e.target.checked)}
      />
      {props.label}
    </label>
  );
});
const Metric = component(
  "Metric",
  z.object({ label: str, value: z.union([num, str]), unit: str }),
  ({ props }) => (
    <div className="metric">
      <p>{props.label}</p>
      <output aria-live="polite">
        {format(props.value)} <small>{props.unit}</small>
      </output>
    </div>
  ),
);
const Table = component(
  "Table",
  z.object({
    columns: labels,
    rows: z.array(z.array(z.union([str, num, z.boolean(), z.null()])).max(100)).max(100),
  }),
  ({ props }) => (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            {props.columns.map((name, i) => (
              <th key={i} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{format(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
);
const Chart = component(
  "Chart",
  z.object({
    title: str,
    labels,
    series: z
      .array(z.object({ name: str, values: z.array(num).min(1).max(100) }))
      .min(1)
      .max(6),
    kind: z.enum(["bar", "line"]),
  }),
  ({ props }) => {
    const state = useStateField<string[]>(`chart:${props.title}`, []);
    const hidden = Array.isArray(state.value) ? state.value : [];
    if (props.series.some((s) => s.values.length !== props.labels.length))
      return <InvalidProps name="Chart dimensions" />;
    const series = props.series.map((s, i) => ({ ...s, i })).filter((s) => !hidden.includes(s.name));
    const values = series.flatMap((s) => s.values);
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values);
    const x = (i: number) => 52 + ((i + 0.5) / props.labels.length) * 520;
    const y = (v: number) => 220 - ((v - min) / (max - min)) * 200;
    const colors = ["var(--accent)", "#0b9880", "#b47a26", "#b76587", "#7561b2", "#4081a1"];
    return (
      <section className="stack">
        <h4>{props.title}</h4>
        <div className="choices">
          {props.series.map((s, i) => (
            <label className="check" key={i}>
              <input
                type="checkbox"
                checked={!hidden.includes(s.name)}
                onChange={() =>
                  state.setValue(
                    hidden.includes(s.name) ? hidden.filter((n) => n !== s.name) : [...hidden, s.name],
                  )
                }
              />
              {s.name}
            </label>
          ))}
        </div>
        <svg viewBox="0 0 600 265" role="img" aria-label={props.title}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1="52"
                x2="580"
                y1={y(min + f * (max - min))}
                y2={y(min + f * (max - min))}
                stroke="var(--border)"
              />
              <text x="45" y={y(min + f * (max - min)) + 4} textAnchor="end">
                {format(min + f * (max - min))}
              </text>
            </g>
          ))}
          {props.labels.map(
            (label, i) =>
              i % Math.max(1, Math.ceil(props.labels.length / 8)) === 0 && (
                <text key={i} x={x(i)} y="247" textAnchor="middle">
                  {label.slice(0, 12)}
                </text>
              ),
          )}
          {series.map((s, j) => (
            <g key={s.i}>
              {props.kind === "line" ? (
                <polyline
                  points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
                  fill="none"
                  stroke={colors[s.i]}
                  strokeWidth="2.5"
                />
              ) : (
                s.values.map((v, i) => {
                  const width = 390 / props.labels.length / series.length;
                  return (
                    <rect
                      key={i}
                      x={x(i) - (width * series.length) / 2 + j * width}
                      y={Math.min(y(0), y(v))}
                      width={Math.max(0.5, width - 2)}
                      height={Math.abs(y(v) - y(0))}
                      rx="2"
                      fill={colors[s.i]}
                    >
                      <title>{`${props.labels[i]}, ${s.name}: ${format(v)}`}</title>
                    </rect>
                  );
                })
              )}
            </g>
          ))}
        </svg>
        <details>
          <summary>{words.table}</summary>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th />
                  {props.series.map((s, i) => (
                    <th key={i}>{s.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {props.labels.map((label, i) => (
                  <tr key={i}>
                    <th>{label}</th>
                    {props.series.map((s, j) => (
                      <td key={j}>{format(s.values[i])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    );
  },
);
const Heatmap = component(
  "Heatmap",
  z.object({ title: str, rows: labels, columns: labels, values: matrix, threshold: num }),
  ({ props }) => {
    if (
      props.values.length !== props.rows.length ||
      props.values.some((row) => row.length !== props.columns.length) ||
      props.values.flat().length > 1500
    )
      return <InvalidProps name="Heatmap dimensions" />;
    const max = Math.max(1, ...props.values.flat());
    return (
      <section className="stack">
        <h4>{props.title}</h4>
        <div className="scroll">
          <table className="heatmap">
            <thead>
              <tr>
                <th />
                {props.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r, i) => (
                <tr key={i}>
                  <th>{r}</th>
                  {props.values[i]!.map((v, j) => (
                    <td
                      key={j}
                      data-active={v >= props.threshold}
                      style={{
                        background:
                          v >= props.threshold
                            ? `color-mix(in srgb, var(--accent) ${15 + (Math.max(0, v) / max) * 40}%, var(--surface))`
                            : "var(--surface)",
                      }}
                      title={`${r}, ${props.columns[j]}: ${v}`}
                    >
                      <span>{v}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" role="status">
          {props.values.flat().filter((v) => v >= props.threshold).length} / {props.values.flat().length}
        </p>
      </section>
    );
  },
);
const Flow = component(
  "Flow",
  z.object({
    title: str,
    steps: z
      .array(z.object({ label: str, detail: str }))
      .min(1)
      .max(20),
  }),
  ({ props }) => {
    const state = useStateField<number>(`flow:${props.title}`, 0);
    const selected = Math.max(0, Math.min(props.steps.length - 1, Number(state.value) || 0));
    return (
      <section className="stack">
        <h4>{props.title}</h4>
        <ol className="flow">
          {props.steps.map((step, i) => (
            <li key={i}>
              <button type="button" aria-pressed={selected === i} onClick={() => state.setValue(i)}>
                <small>{i + 1}</small>
                {step.label}
              </button>
            </li>
          ))}
        </ol>
        <p className="detail" role="status">
          {props.steps[selected]!.detail}
        </p>
      </section>
    );
  },
);
const Draft = component("Draft", z.object({ text: str }), ({ props }) => (
  <div className="draft">
    <p>{props.text}</p>
    <button type="button" onClick={() => post("draft", props.text)}>
      {words.draft}
    </button>
  </div>
));
const library = createLibrary({
  components: [
    Stack,
    Grid,
    Card,
    Text,
    Heading,
    Details,
    Choice,
    MultiChoice,
    Input,
    NumberInput,
    Slider,
    Toggle,
    Metric,
    Table,
    Chart,
    Heatmap,
    Flow,
    Draft,
  ],
});

const root = createRoot(document.getElementById("root")!);
let started = false;
let outcome: { type: "ready" | "error"; value?: string } | undefined;
/** Cache the terminal failure so subsequent init handshakes replay that outcome. */
function reportError(error: unknown) {
  outcome = {
    type: "error",
    value: error instanceof Error ? error.message : typeof error === "string" ? error : "Could not render this reply",
  };
  post(outcome.type, outcome.value);
}

/** Translate unexpected React subtree failures into the host's source fallback. */
class RuntimeBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  /** Replace the failed subtree before any readiness effect can commit. */
  static getDerivedStateFromError() {
    return { failed: true };
  }
  /** Publish the caught failure using the same cached outcome as validation errors. */
  componentDidCatch(error: Error) {
    reportError(error);
  }
  /** Keep the frame empty on failure; the parent owns the readable fallback. */
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Acknowledge a committed subtree only after deferred child validation settles. */
function ReadyAfterCommit() {
  useEffect(() => {
    // Child validation effects run first. Let their deferred InvalidProps
    // outcomes settle before acknowledging a successfully committed subtree.
    const timer = setTimeout(() => {
      if (outcome?.type === "error") return;
      outcome = { type: "ready" };
      post(outcome.type);
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
/** Apply bounded host theme tokens; generated reply data cannot supply styles. */
function applyTheme(theme: Record<string, unknown> | undefined) {
  for (const key of ["ink", "muted", "surface", "border", "accent", "canvas"] as const) {
    const value = theme?.[key];
    if (typeof value === "string" && value.length < 100 && CSS.supports("color", value))
      document.documentElement.style.setProperty(`--${key}`, value);
  }
  if (typeof theme?.font === "string" && theme.font.length < 300)
    document.documentElement.style.fontFamily = theme.font;
  if (theme?.scheme === "light" || theme?.scheme === "dark") document.documentElement.style.colorScheme = theme.scheme;
}
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== "omb-interactive-v1") return;
  if (started && event.data.token === token && event.data.type === "init") {
    if (outcome) post(outcome.type, outcome.value);
    return;
  }
  if (started && event.data.token === token && event.data.type === "theme") {
    applyTheme(event.data.value);
    return;
  }
  if (started || event.data.type !== "init") return;
  started = true;
  token = event.data.token;
  try {
    const { source, initialState, theme, labels: translated } = event.data.value;
    if (typeof source !== "string") throw new Error("Invalid content");
    const error = validateInteractiveSource(source);
    if (error) throw new Error(error);
    applyTheme(theme);
    if (translated) words = translated;
    const result = createParser(library.toJSONSchema()).parse(source);
    if (
      !result.root ||
      result.meta.incomplete ||
      result.meta.errors?.length ||
      result.meta.unresolved?.length ||
      result.queryStatements?.length ||
      result.mutationStatements?.length
    )
      throw new Error("Could not read this interactive reply");
    root.render(
      <RuntimeBoundary>
        <Renderer
          response={source}
          library={library}
          initialState={initialState}
          publishObservability={false}
          toolProvider={null}
          onStateUpdate={(state) => post("state", state)}
          onError={(errors) => {
            if (errors.length) reportError(errors[0]!.message);
          }}
        />
        <ReadyAfterCommit />
      </RuntimeBoundary>,
    );
  } catch (error) {
    reportError(error);
  }
});
new ResizeObserver(() =>
  post("height", Math.ceil(document.documentElement.getBoundingClientRect().height)),
).observe(document.documentElement);
post("boot");
