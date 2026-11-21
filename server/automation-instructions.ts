import { redactSecretsInText } from "./redact.ts";

export function instructionsUpdateRefusal(prompt: string, instructions: string | undefined): string | null {
  if (instructions === undefined || redactSecretsInText(prompt) === prompt) return null;
  return "These instructions contain hidden credentials, so the bot cannot safely replace them. Ask the person to edit the instructions on the Automations page. Other fields can be changed by omitting instructions.";
}
