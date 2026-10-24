import { byLanguage } from "./language.ts";

/** The first bot's seeded line is created by the server before the UI exists. */
const GREETINGS: { en: (name: string) => string } & Record<string, (name: string) => string> = {
  en: (name) => `Hi, I'm ${name}. What would you like me to do?`,
  es: (name) => `Hola, soy ${name}. ¿Qué te gustaría que hiciera?`,
  "pt-br": (name) => `Oi, eu sou ${name}. O que você gostaria que eu fizesse?`,
};

export function initialGreeting(name: string, language?: string): string {
  return byLanguage(GREETINGS, language)(name);
}

/** The seeded message; a function language is read now, so a language changed in Settings reaches the next new bot. */
export function initialGreetingMessage(name: string, language: string | (() => string)) {
  return { role: "bot", kind: "text", text: initialGreeting(name, typeof language === "function" ? language() : language) } as const;
}
