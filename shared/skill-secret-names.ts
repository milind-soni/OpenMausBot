const SECRET_WORDS = /(?:^|[^a-z])(?:o?auth|tokens?|sessions?|cookies?|passw\w*|secrets?|credentials?|api[-_]?keys?|keys?|bearer|storage[-_]?state|service[-_]?accounts?|private[-_]?keys?)(?:[^a-z]|$)/;
const SECRET_FOLDERS = /^(?:secrets?|credentials?|sessions?|cookies?|tokens?|keys?|private[-_]?keys?|service[-_]?accounts?)$/;
const KEY_STORES = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|keychain|keychain-db|sqlite3?|db|env)$|^id_(?:rsa|dsa|ecdsa|ed25519)/;
const DATA_EXTENSIONS = new Set(["json", "jsonc", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "txt", "text", "csv", "tsv", "xml"]);

export function secretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FOLDERS.test(lower) || KEY_STORES.test(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && DATA_EXTENSIONS.has(lower.slice(dot + 1)) && SECRET_WORDS.test(lower.slice(0, dot));
}
