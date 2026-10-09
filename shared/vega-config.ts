// placeholder: replaced at merge
// The real vegaConfig (OMB's palette and fonts for every Vega render: panel,
// phone PNGs, Slack and email) is written on another branch with this exact
// signature. The panel compiles against it; an empty config means Vega's
// defaults until the merge.
export function vegaConfig(theme: "light" | "dark"): Record<string, unknown> {
  void theme;
  return {};
}
