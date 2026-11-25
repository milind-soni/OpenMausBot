import nativeText from "./native-text.cjs";

export function updateWords(key, params) {
  return { message: nativeText.englishText.t(key, params), messageKey: key, ...(params ? { messageParams: params } : {}) };
}

export function installDetail(key, params) {
  const words = updateWords(key, params);
  return { detail: words.message, detailKey: key, ...(params ? { detailParams: params } : {}) };
}

export function detailFields(result) {
  return result?.detailKey ? { messageKey: result.detailKey, ...(result.detailParams ? { messageParams: result.detailParams } : {}) } : {};
}
