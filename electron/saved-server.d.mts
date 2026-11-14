export declare const SERVER_LOOK_MS: number;
export declare function serverAnswers(origin: string, fetchImpl: typeof fetch, timeoutMs?: number): Promise<boolean>;
export declare function serverOpens(
  entry: { id: string; name: string; origin: string },
  deps: { fetch: typeof fetch; dialog: { showMessageBox(options: object): Promise<{ response: number }> }; forget: (id: string) => unknown; timeoutMs?: number },
): Promise<boolean>;
