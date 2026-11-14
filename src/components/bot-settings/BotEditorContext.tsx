import { createContext, useContext } from "react";
import { api } from "@/state/store";

/** A creation editor supplies a scoped draft transport; it never replaces fetch or another editor's API. */
export const BotEditorContext = createContext<{
  request: typeof api;
  draft?: boolean;
  uploadAvatar?: (file: File) => Promise<string>;
}>({ request: api });

export function useBotEditor() { return useContext(BotEditorContext); }
