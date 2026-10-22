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

export function formatServerText(template: string, params: ServerTextParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
