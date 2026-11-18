import { SECRET_VALUE_MAX_BYTES } from "../../shared/vault.ts";
import { DATA_FORMAT } from "../data-format.ts";

export const STORED_VAULT_VALUE_MAX_BYTES = 65_536;
export const VAULT_VALUE_MAX_BYTES = DATA_FORMAT.writes >= 2 ? STORED_VAULT_VALUE_MAX_BYTES : SECRET_VALUE_MAX_BYTES;

// A JSON string may encode one byte as six (\u0000). Leave room for the other request fields.
export const VAULT_VALUE_BODY_MAX_BYTES = DATA_FORMAT.writes >= 2 ? VAULT_VALUE_MAX_BYTES * 6 + 16_384 : 16_384;
