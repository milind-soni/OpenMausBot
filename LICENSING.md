# Licensing

This fork of OpenMausBot is open source under the [Apache License 2.0](LICENSE),
with no other license in the tree.

## No `enterprise/` folder

Upstream keeps a source-available `enterprise/` folder under its own
OpenMausBot Enterprise License. This fork does not include it, and the
`no-enterprise` workflow fails if an upstream merge brings it back. Nothing
here was copied or adapted from that folder.

Optional capabilities (`admin`, `billing`, `branding`, `budgets`) are turned on
by the operator with `APP_FEATURES` or `edition.features` in `config.json`
([`server/features.ts`](server/features.ts)). There is no license key or
license check. A workspace explicitly configured for hosted sign-in refuses
remote access unless a hosted sign-in adapter is registered, and none ships
here.

## Contributions

Contribute under Apache 2.0. Submit only code you wrote or have the right to
contribute.

## Third-party components and trademarks

Bundled third-party software keeps its own licenses; notices, license texts,
source locations and the SBOM are listed in [NOTICE](NOTICE) and
[`third_party/`](third_party/). The OpenMausBot and MausBot names and the
mascot are trademarks of Supamaus Software Private Limited; the Apache License
does not grant trademark rights (section 6),
so a product built on OpenMausBot needs its own name unless a partner agreement
says otherwise.
