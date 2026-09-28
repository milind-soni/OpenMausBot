# Given-name datasets

- **female**: 4,951 source entries (4,944 distinct names); [source](https://github.com/stdlib-js/datasets-female-first-names-en/blob/6a242e0e3c2380f1f3a46f1737f80ff7460672a7/data/names.json), SHA-256 `afa5752995a508830b3d988a1bf00c8268b86db98b7dc6d4d7e2f959046d3176`.
- **male**: 3,898 source entries (3,897 distinct names); [source](https://github.com/stdlib-js/datasets-male-first-names-en/blob/622eab34ce80ecaaec9c6a196ec527fd53e59926/data/names.json), SHA-256 `167505b4bc6b4fba21ea2fe56436271021476421c55ce6796915a5f5cc5a717f`.

These unchanged stdlib JSON datasets derive from **Moby Word II** and describe names used in English-speaking countries. They are not country-specific rankings or an exhaustive list of identities. The database is dedicated under PDDL-1.0 and its contents under CC0-1.0; the upstream license files are retained beside the data.

The picker trims whitespace, removes case-insensitive duplicates, and samples uniformly locally. It avoids the current name and existing bot names when alternatives remain. No network or model request is made when choosing a name. These labels select a name list only; they do not set the bot voice, role, avatar, or other profile fields.
