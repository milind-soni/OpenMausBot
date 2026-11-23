import product from "../product.json" with { type: "json" };

/** The product's name wherever a person reads it. Rename the product in product.json, then run `pnpm product:apply`. */
export const PRODUCT_NAME: string = product.name;
/** The desktop app's and installers' name. */
export const APP_NAME: string = product.appName;
export const APP_ID: string = product.appId;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The names as regular-expression source, for code that reads back a line this app wrote. */
export const PRODUCT_NAME_PATTERN = escaped(PRODUCT_NAME);
export const APP_NAME_PATTERN = escaped(APP_NAME);
