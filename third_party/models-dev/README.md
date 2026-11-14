# models.dev

`server/model-catalog/models-dev.snapshot.json` is a trimmed copy of the
models.dev catalog (`https://models.dev/api.json`), MIT License, Copyright (c)
2025 models.dev. The full license text is in [LICENSE](LICENSE) and inside the
snapshot itself (`source.licenseText`).

- Source: https://github.com/anomalyco/models.dev at commit
  `7f91a155297c92203cc1111dac7f0ca42d478f22` (2026-09-30T05:32:26Z). The
  `api.json` used was checked to be identical in content to the catalog that
  commit generates.
- Built with `node scripts/build-model-catalog.mjs --input api.json --commit
  <sha> --updated-at <commit time>`; `--check` verifies the committed file.
- Trimmed to the provider index and current, tool-calling, text-input models.
  Any provider or model whose strings contain `{` or `}` is left out, because
  OpenCode expands `{env:…}` and `{file:…}` anywhere in its configuration.
