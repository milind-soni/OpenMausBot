/** Build the single command-string argument required by `cmd.exe /s /c`.
 *
 * `/s` strips one outer quote pair. The remaining quotes preserve each path
 * boundary, including executable and script paths that contain spaces.
 */
export function windowsCmdCommand(arguments_: readonly string[]): string {
  if (!arguments_.length || arguments_.some((value) => !value || /["\r\n\0]/.test(value))) {
    throw new Error("Windows command contains an invalid argument");
  }
  return `"${arguments_.map((value) => `"${value}"`).join(" ")}"`;
}
