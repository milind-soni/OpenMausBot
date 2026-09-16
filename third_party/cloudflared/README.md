# cloudflared release provenance

Astra stages the official `cloudflared` 2026.8.2 executable as a separate
process. The binaries come from Cloudflare's official GitHub release:

<https://github.com/cloudflare/cloudflared/releases/tag/2026.8.2>

`scripts/prepare-cloudflared.mjs` verifies these SHA-256 digests before an
executable can be staged:

| Astra target | Release asset | Release asset SHA-256 | Extracted executable SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | `cloudflared-darwin-arm64.tgz` | `9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442` | `b61054d3d6326ea558cb49826eebf5676e0d0a36d51b546975096ca3e0e3c89d` |
| macOS x64 | `cloudflared-darwin-amd64.tgz` | `f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4` | `b0f770e1e0b281399a57219b840fd8eef1cc25387a404124248157ea2073727a` |
| Linux x64 | `cloudflared-linux-amd64` | `fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2` | same as release asset |
| Windows x64 | `cloudflared-windows-amd64.exe` | `c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5` | same as release asset |

The staged executables are generated build output and are intentionally not
checked into git. Set `ASTRA_CLOUDFLARED_ARCHIVE_DIR` to a directory containing
the exact official release assets to prepare a package from a reviewed local
download. Otherwise the preparation script downloads them from the release URL
above.

The macOS release process applies Astra's Developer ID signature to the
staged executable as part of signing the app bundle. It verifies the unsigned
upstream digest before that necessary packaging change, then verifies the
nested signature, signing team, and architecture before notarization. Linux
and Windows packages retain the exact reviewed upstream executable bytes.

cloudflared is licensed under Apache License 2.0. The distribution includes a
separately named copy of the complete Apache 2.0 text at
`resources/licenses/cloudflared-LICENSE.txt`.
