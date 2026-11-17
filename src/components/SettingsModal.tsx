import { Layer } from "./Layer";
import { SettingsWindow } from "./settings/SettingsWindow";

export function SettingsModal() {
  return <Layer modal><SettingsWindow /></Layer>;
}
