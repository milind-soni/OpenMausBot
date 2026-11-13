/** Values for the `{placeholders}` of a sentence the server words. */
export type ServerTextParams = Record<string, string | number>;

/** A sentence the server words for a person, named by its key in
 * src/locales/en.json so a client can say it in the person's language. The
 * server always sends the English beside it, which is what a client that does
 * not know the key shows. */
export interface ServerText {
  key: string;
  params?: ServerTextParams;
}

/** A message's `text` the server wrote from a fixed line. */
export interface ServerTextLine {
  /** Catalog key (`chat.notice.*`) for `text`. `text` keeps the English, which phones, exports, the bot's own context
   * and older clients read. */
  textCode?: string;
  /** Values for the placeholders of `textCode`. */
  textParams?: ServerTextParams;
}

/** The fixed name and summary of an activity chip, beside their English fallbacks. */
export interface ServerToolText {
  /** Catalog key (`chat.notice.*`) for the words of `name` after any
   * `error:` marker, when they are one of the server's fixed notices.
   * `name` keeps the English, which phones, exports and older clients show. */
  nameCode?: string;
  /** Values for the placeholders of `nameCode`. */
  nameParams?: ServerTextParams;
  /** Fixed summary words, only while they rebuild `summary`. */
  summaryCode?: string;
  summaryParams?: ServerTextParams;
}

/** The JSON body of a refused request. */
export interface ServerErrorBody {
  /** English, always present: what a client that does not know `errorKey` shows. */
  error: string;
  /** A machine code clients branch on (`cloud_personal`, `managed_policy`, …). Never a catalog key. */
  code?: string;
  /** A `serverError.*` catalog key a client may show instead of `error`. */
  errorKey?: string;
  /** Values for the placeholders of `errorKey`. */
  errorParams?: ServerTextParams;
}

const REFERENCE_PARAMS = new Set(["limit", "meanwhile", "why"]);
const PART_KEY = /^(?:chat\.notice|routines\.server)\.part\.\w+$/;

/** Only these params may name a catalog piece (`chat.notice.part.*`, `routines.server.part.*`) that a client words;
 * every other param is data, such as a name, a quote or a failure, and is shown exactly as sent. */
export function isReferenceParam(name: string, value: string | number): boolean {
  return REFERENCE_PARAMS.has(name) && typeof value === "string" && PART_KEY.test(value);
}

export function formatServerText(template: string, params: ServerTextParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
