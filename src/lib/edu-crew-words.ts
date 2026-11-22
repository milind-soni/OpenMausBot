import { t } from "@/lib/i18n";
import type { EduCrewGate } from "../../shared/edu-brain";

const TITLE_CHARS = 120;
const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
};

export const eduCrewGateTitle = (): string => t("server.eduCrew.gateTitle");
export const eduCrewGateSummary = (gate: EduCrewGate): string => t("server.eduCrew.gateSummary", { gate: gate.gate, title: short(gate.goal) });

/** The gate's spec, the commands approving runs, and the folder the crew works in. */
export function eduCrewGateDetail(gate: EduCrewGate): string {
  return [
    gate.spec ?? gate.goal,
    ...(gate.commands?.length ? [`${t("eduCrew.gate.commands")}\n${gate.commands.map((command) => `$ ${command}`).join("\n")}`] : []),
    t("eduCrew.gate.folder", { folder: gate.folder }),
  ].join("\n\n");
}

export function eduCrewGateOutcome(answered: string | undefined): string | undefined {
  if (!answered) return undefined;
  return t(answered === "allow" ? "eduCrew.gate.approved" : answered === "deny" ? "eduBrain.status.rejected" : "eduCrew.gate.gone");
}
