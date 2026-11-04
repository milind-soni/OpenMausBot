export function quietPlanRow(row: { driver: string; ok: boolean; reason?: string | null }): boolean {
  return !row.ok && row.driver === "copilot" && (row.reason === "signedOut" || row.reason === "noPlan");
}
