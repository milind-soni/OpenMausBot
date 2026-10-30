# Localization

OpenMausBot ships its translations inside the app. It does not contact a
translation service at runtime, and contributors do not need an API key.
English in `src/locales/en.json` is the source catalog; the other JSON files
are partial overlays that fall back to English for missing keys.

## Add or update a language

1. Use a lowercase BCP-47 filename such as `de.json` or `pt-br.json`.
2. Keep every key identical to an English key and preserve placeholders such
   as `{name}` exactly, including repeated placeholders.
3. Register a new pack in `src/locales/index.ts`.
4. Run `pnpm i18n:check` and test the language from **Settings → General**.

`pnpm i18n:check` is deterministic. It validates JSON structure, unknown or
empty entries, locale filename casing, placeholder parity, and the English
source hash recorded for each translated value. If English copy changes after
its hash was recorded, the old translation fails the check instead of silently
looking current. Missing translations remain allowed because the runtime has
an English fallback.

## Source hashes are recorded at release

`src/locales/source-hashes.json` holds, per language, the sha256 of the
English each translation was made from. A pull request does not edit it:

- a new translated key has no hash yet and counts as current;
- a removed key's hash is left in place and ignored;
- a key whose recorded hash no longer matches today's English fails the check.

The release bump (`prepare-release.yml`) runs
`node scripts/generate-locale.mjs --record-hashes` and commits the file with
the bump. For every translated key without a hash it records the hash of the
English the translation was written against: `git blame` finds the commit that
last changed the translated value, and the hash is of `en.json`'s text for
that key in that commit. If the English changed since, the key is recorded
stale, the script names it, and `pnpm i18n:check` fails in the bump PR until
the translation is refreshed. Without that history (no git, a shallow clone,
or a key `en.json` did not have in that commit) it hashes today's English and
prints a line saying so. It also drops the hashes of removed keys and
languages, and it never replaces an existing hash.

## Optional model-assisted draft

The repository includes a maintainer tool that sends missing or stale English
strings to an installed, authenticated Claude CLI. The CLI usually sends the
strings to its configured cloud model and may consume subscription or API
quota; “local” describes the CLI, not where inference runs.

```sh
# Safe, no-tools Claude mode
node scripts/generate-locale.mjs it "Italian"
```

Existing packs refresh only keys that are missing or whose English source has
changed since its recorded hash, preserving reviewed translations for every
other key. A refreshed key's hash is updated; a newly drafted key gets its
hash at the next release. Use `--force`
only when intentionally re-drafting the whole pack. The tool rejects prose,
code fences, missing or invented keys, empty values, and changed placeholders
before it installs either file.

After refreshing a stale translation by hand, review the pack and record
which English source each present value translates:

```sh
node scripts/generate-locale.mjs pt-br --accept
pnpm i18n:check
```

Commit `src/locales/source-hashes.json` with the catalog in that case only;
adding new keys and their translations needs no hash edit. The hash contains
no translation content or credential; it only lets CI detect stale copy.

Model output is a draft, not an authority. Review tone, terminology, grammar,
product names, and safety-sensitive copy before committing it. AI translation
does not run in GitHub Actions: normal CI stays deterministic, secret-free,
and safe for forks.
