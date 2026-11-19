import { Layer } from "./Layer";
import { ModalPresence } from "./ModalPresence";
import { SettingsWindow } from "./settings/SettingsWindow";

export function SettingsModal({ open = true }: { open?: boolean }) {
  return <Layer modal={open}><ModalPresence open={open}><SettingsWindow /></ModalPresence></Layer>;
}
