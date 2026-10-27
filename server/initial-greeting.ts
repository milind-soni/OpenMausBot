import { byLanguage } from "./language.ts";

/** The first bot's seeded line is created by the server before the UI exists. */
const GREETINGS: { en: (name: string) => string } & Record<string, (name: string) => string> = {
  en: (name) => `Hi, I'm ${name}. What would you like me to do?`,
  es: (name) => `Hola, soy ${name}. ¿Qué te gustaría que hiciera?`,
  "pt-br": (name) => `Oi, eu sou ${name}. O que você gostaria que eu fizesse?`,
};

/** What the bot says the moment Set me up is pressed: no model is asked, so it is written here. */
const SETUP_REQUEST_LINES: { en: string } & Record<string, string> = {
  en: "Great. Tell me what you'd like help with, in your own words, and I'll set myself up for it. For example: \"sort my inbox every morning\" or \"research our competitors every week\".",
  es: "Genial. Cuéntame con tus propias palabras en qué te gustaría que te ayude y me prepararé para ello. Por ejemplo: \"ordena mi bandeja de entrada cada mañana\" o \"investiga a nuestros competidores cada semana\".",
  "pt-br": "Ótimo. Me conte com suas palavras em que você gostaria de ajuda e eu me preparo para isso. Por exemplo: \"organize minha caixa de entrada toda manhã\" ou \"pesquise nossos concorrentes toda semana\".",
};

export function initialGreeting(name: string, language?: string): string {
  return byLanguage(GREETINGS, language)(name);
}

export function setupRequestLine(language?: string): string {
  return byLanguage(SETUP_REQUEST_LINES, language);
}

/** The seeded message; a function language is read now, so a language changed in Settings reaches the next new bot.
 * `offerSetup`: the bot has no role or instructions yet, so its greeting carries Set me up. */
export function initialGreetingMessage(name: string, language: string | (() => string), offerSetup = false) {
  const text = initialGreeting(name, typeof language === "function" ? language() : language);
  return { role: "bot", kind: "text", text, ...(offerSetup ? { setupOffer: true as const } : {}) } as const;
}
