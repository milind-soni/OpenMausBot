/** A bot conversation's host folder, resolved by the server. `local` permits preparing it for the local desktop;
 * a remote client may copy `path`, but must not reveal it on its own computer. */
export interface BotWorkingFolder {
  path: string | null;
  local: boolean;
}
