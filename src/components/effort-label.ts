import type { EffortLevel } from "../../shared/wire";
import { t } from "@/lib/i18n";

export function effortLabel(level: EffortLevel): string {
  return t(`model.effort.${level}`);
}
