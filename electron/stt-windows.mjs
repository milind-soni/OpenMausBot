import { runProcess } from "./stt-core.mjs";

// Fixed source, no renderer-provided command text. Windows owns recognition
// and its microphone panel; this only invokes the standard Win+H shortcut.
const VOICE_TYPING = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class SttKeys{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);}'; [SttKeys]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [SttKeys]::keybd_event(0x48,0,0,[UIntPtr]::Zero); [SttKeys]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [SttKeys]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;

export async function openWindowsVoiceTyping({ platform = process.platform, run = runProcess } = {}) {
  if (platform !== "win32") throw new Error("Windows voice typing is unavailable.");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", VOICE_TYPING], { timeout: 15_000 });
}
