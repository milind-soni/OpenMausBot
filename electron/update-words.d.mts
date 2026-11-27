/** One updater line as main shows it: the text, and the locale key it came from. */
export interface UpdateWords {
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string>;
}

export interface InstallDetail {
  detail: string;
  detailKey?: string;
  detailParams?: Record<string, string>;
}

export declare function updateWords(key: string, params?: Record<string, string>): UpdateWords;

export declare function installDetail(key: string, params?: Record<string, string>): InstallDetail;

export declare function detailFields(result: { detailKey?: string; detailParams?: Record<string, string> } | null | undefined): {
  messageKey?: string;
  messageParams?: Record<string, string>;
};
