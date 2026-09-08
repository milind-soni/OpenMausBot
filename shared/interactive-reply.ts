/** The versioned fence carries OpenUI Lang, never JavaScript or HTML. */
export const INTERACTIVE_REPLY_MAX_BYTES = 32 * 1024;
/** Reserve comparison columns for peer Cards; mixed controls stay sequential. */
export function usesComparisonColumns(children: readonly unknown[]): boolean {
  return (
    children.length > 1 &&
    children.every(
      (child) => !!child && typeof child === "object" && "typeName" in child && child.typeName === "Card",
    )
  );
}
/** Reject unsupported capabilities and excessive source expansion before the
 * third-party parser runs. Return a user-facing reason, or null for admission. */
export function validateInteractiveSource(source: string): string | null {
  if (new TextEncoder().encode(source).length > INTERACTIVE_REPLY_MAX_BYTES)
    return "This interactive reply is too large.";
  // Limit nesting and declaration expansion BEFORE the third-party parser.
  const syntax = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*/g, (match) =>
    match.startsWith("//") ? "" : '""',
  );
  if (
    /\b(?:Query|Mutation|Action|Run|OpenUrl|ToAssistant|Set|Reset|Each|constructor|prototype|__proto__|eval|Function|window|document|fetch|import|require)\b/.test(
      syntax,
    )
  )
    return "This reply requests an unsupported capability.";
  let depth = 0;
  for (const char of syntax) {
    if ("([{ ".trim().includes(char) && ++depth > 20) return "This interactive reply is too deeply nested.";
    if (")]}".includes(char) && --depth < 0) return "This interactive reply is incomplete.";
  }
  if (depth !== 0) return "This interactive reply is incomplete.";
  const declarations = [...syntax.matchAll(/(?:^|[;\n])\s*(\$?[A-Za-z_]\w*)\s*=/g)];
  if (!declarations.length || declarations.length > 64) return "This reply has too many or no declarations.";
  const graph = new Map<string, string[]>();
  declarations.forEach((match, index) => {
    const body = syntax.slice(
      match.index! + match[0].length,
      declarations[index + 1]?.index ?? syntax.length,
    );
    graph.set(match[1]!, body.match(/\$?[A-Za-z_]\w*/g) ?? []);
  });
  if (graph.size !== declarations.length || !graph.has("root"))
    return "This reply needs one unique root declaration.";
  let budget = 4096;
  const visit = (name: string, path: Set<string>): boolean => {
    if (--budget < 0 || path.has(name) || path.size > 20) return false;
    const next = new Set(path).add(name);
    return (graph.get(name) ?? []).every((ref) => !graph.has(ref) || visit(ref, next));
  };
  if (![...graph.keys()].every((name) => visit(name, new Set())))
    return "This reply contains cyclic or excessive references.";
  return null;
}

export const INTERACTIVE_REPLY_PROMPT = `\n\nInteractive replies (desktop/web): OpenMaus already has onboarding choices, native questions, and approval cards. Choose the existing interaction first. If you need an answer to continue, use the engine's native question tool when available (for example ask_user); otherwise ask a concise question in normal chat. Do not recreate that question as an openmaus-ui form or show both interfaces for the same decision. Permissions, credentials, profile/routine/skill confirmations must use their existing native tools and cards; an interactive block cannot grant approval or answer a pending request.
Use an openmaus-ui block for local exploration: linked controls that update a preview, calculation, comparison, chart, diagram, or other useful result before the person decides what to send. A standalone question or list of reply buttons does not need OpenUI. When the user explicitly requests a local interactive tool, compose it from the catalog below. Also give a short useful plain-text summary outside the block for other clients. This is a composable engine, not a collection of fixed layouts.
Use declarations like root = Stack([title, choices, result]); each declaration ends with a semicolon. Strings are JSON strings. Declare mutable state as $choice = "A"; bind it directly to a control's value. Other props can use $state, arithmetic + - * /, comparisons, ternaries, and builtins @If(condition, yes, no), @Sum(array), @Count(array), @Round(number, decimals). Reference declared components in containers, and combine freely. No JavaScript, HTML, CSS, URLs, Query, Mutation, actions or tool calls. All data must be inline. Max 32 KiB, 64 declarations, nesting 20. Labels and explanatory copy use the user's language.
Component positional signatures (all arguments required):
Stack(children[]); Grid(children[]); Card(title, children[]); Text(text); Heading(text); Details(title, children[]);
Choice(label, options[], value); MultiChoice(label, options[], value[]); Input(label, value); NumberInput(label, min, max, step, value); Slider(label, min, max, step, value); Toggle(label, value);
Metric(label, value, unit); Table(columns[], rows[][]); Chart(title, labels[], series[{name,values:number[]}], kind: "bar"|"line"); Heatmap(title, rows[], columns[], values:number[][], threshold:number); Flow(title, steps[{label,detail}]); Draft(text).
Choice options are plain strings. Give every control a distinct label. Bind mutable values to $variables. Design for the task: one title, a short description only when needed, related controls in a vertical Stack, then a compact result or Draft. Use Grid only for comparable peer Cards (plans, options); mixed children fall back to a vertical flow. Never place a slider next to an unrelated stat tile. Metric is a compact inline result, not a dashboard card. Avoid redundant nested Cards, decorative statistics, long forms for a simple choice, and multiple competing primary actions. Prefer the smallest useful interaction. Flow is a sequence of selectable steps with explanation. Draft displays an explicit Add to reply button; clicking prepares an editable composer draft, NEVER sends a message. Put human-readable chosen values in Draft(text), using string concatenation. Ordinary controls and calculations stay local and persist on this device. Do not claim an agent action has occurred when a control changes. Never request secrets in an interactive form.
Example:
\`\`\`openmaus-ui
$mode = "Quick review";
$hours = 2;
root = Card("Plan the review", [Text("Choose the depth and available time."), Choice("Review depth", ["Quick review", "Detailed review"], $mode), Slider("Hours", 1, 8, 1, $hours), Metric("Estimated sections", $hours * 3, "sections"), Draft("Please prepare a " + $mode + " with a time budget of " + $hours + " hours.")]);
\`\`\`\n`;
