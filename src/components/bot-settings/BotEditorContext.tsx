import { createContext, useContext } from "react";
import { api } from "@/state/store";

/** Existing settings use the real API. A creation editor supplies a scoped
 * draft transport; it never replaces fetch or changes another editor's API. */
export const BotEditorContext = createContext<{
  request: typeof api;
  draft?: boolean;
  uploadAvatar?: (file: File) => Promise<string>;
}>({ request: api });

export function useBotEditor() { return useContext(BotEditorContext); }
