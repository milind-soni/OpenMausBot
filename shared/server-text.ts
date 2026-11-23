import { formatServerText, type ServerTextParams } from "../packages/phone-protocol/src/server-text.ts";
import { PRODUCT_NAME } from "./product.ts";

export * from "../packages/phone-protocol/src/server-text.ts";

/** formatServerText with `{app}` as the product's name unless `params` names it. */
export function formatProductText(template: string, params: ServerTextParams = {}): string {
  return formatServerText(template, { app: PRODUCT_NAME, ...params });
}
