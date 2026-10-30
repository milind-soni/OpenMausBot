import { byLanguage } from "./language.ts";
import { greetingName } from "../shared/greeting-name.ts";

type Greeting = (name: string, person?: string) => string;

/** The first bot's seeded line is created by the server before the UI exists. */
const GREETINGS: { en: Greeting } & Record<string, Greeting> = {
  en: (name, person) => `Hi${person ? ` ${person}` : ""}, I'm ${name}. What would you like me to do?`,
  es: (name, person) => `Hola${person ? ` ${person}` : ""}, soy ${name}. ¿Qué te gustaría que hiciera?`,
  "pt-br": (name, person) => `Oi${person ? ` ${person}` : ""}, eu sou ${name}. O que você gostaria que eu fizesse?`,
  ko: (name, person) => `안녕하세요${person ? `, ${person}님` : ""}. 저는 ${name}입니다. 무엇을 도와드릴까요?`,
};

/** What the bot says the moment Set me up is pressed: no model is asked, so it is written here. */
const SETUP_REQUEST_LINES: { en: string } & Record<string, string> = {
  en: "Great. Tell me what you'd like help with, in your own words, and I'll set myself up for it. For example: \"sort my inbox every morning\" or \"research our competitors every week\".",
  es: "Genial. Cuéntame con tus propias palabras en qué te gustaría que te ayude y me prepararé para ello. Por ejemplo: \"ordena mi bandeja de entrada cada mañana\" o \"investiga a nuestros competidores cada semana\".",
  "pt-br": "Ótimo. Me conte com suas palavras em que você gostaria de ajuda e eu me preparo para isso. Por exemplo: \"organize minha caixa de entrada toda manhã\" ou \"pesquise nossos concorrentes toda semana\".",
  ko: "좋아요. 도움이 필요한 일을 편하게 말씀해 주시면 거기에 맞게 제가 설정할게요. 예: \"매일 아침 받은편지함 정리해 줘\", \"매주 경쟁사 조사해 줘\".",
};

/** The answers a blank bot's greeting offers on its setup card. Picking one sets the bot up for its words, as
 * `/setup <words>` would; the client sends the words, never a position, so these may change freely. */
const SETUP_CHOICES: { en: readonly string[] } & Record<string, readonly string[]> = {
  en: ["Research and digging into topics", "Keeping an eye on things for me", "Email, calendar and messages",
    "Bookings, shopping and errands", "Data, spreadsheets and reports"],
  es: ["Investigar y profundizar en temas", "Estar pendiente de cosas por mí", "Correo, calendario y mensajes",
    "Reservas, compras y recados", "Datos, hojas de cálculo e informes"],
  "pt-br": ["Pesquisar e aprofundar temas", "Ficar de olho nas coisas para mim", "E-mail, agenda e mensagens",
    "Reservas, compras e tarefas", "Dados, planilhas e relatórios"],
  ko: ["리서치와 주제 깊이 파고들기", "이것저것 지켜보기", "이메일, 캘린더, 메시지",
    "예약, 쇼핑, 심부름", "데이터, 스프레드시트, 보고서"],
};

export function setupChoices(language?: string): string[] {
  return [...byLanguage(SETUP_CHOICES, language)];
}

/** The fixed answers exist in this language, not only the English stand-in. */
export function hasSetupChoices(language?: string): boolean {
  return byLanguage(SETUP_CHOICES, language) !== SETUP_CHOICES.en || /^en(?:-|$)/i.test(language?.trim() || "en");
}

/** `person`: the name the person gave, greeted by greetingName; absent or blank, the greeting names no one. */
export function initialGreeting(name: string, language?: string, person?: string): string {
  return byLanguage(GREETINGS, language)(name, greetingName(person) || undefined);
}

export function setupRequestLine(language?: string): string {
  return byLanguage(SETUP_REQUEST_LINES, language);
}

/** The seeded message; a function language is read now, so a language changed in Settings reaches the next new bot.
 * `offerSetup`: the bot has no role or instructions yet, so its greeting carries the setup card and its answers. */
export function initialGreetingMessage(name: string, language: string | (() => string), offerSetup = false, person?: string) {
  const spoken = typeof language === "function" ? language() : language;
  const text = initialGreeting(name, spoken, person);
  return { role: "bot", kind: "text", text, ...(offerSetup ? { setupOffer: true as const, setupChoices: setupChoices(spoken) } : {}) } as const;
}
