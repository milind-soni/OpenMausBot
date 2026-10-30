# cloudflared release provenance

OpenMausBot stages the official `cloudflared` 2026.10.3 executable as a separate
process. The binaries come from Cloudflare's official GitHub release:

<https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3>

`scripts/prepare-cloudflared.mjs` verifies these SHA-256 digests before an
executable can be staged:

| OpenMausBot target | Release asset | Release asset SHA-256 | Extracted executable SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | `cloudflared-darwin-arm64.tgz` | `1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55` | `f249139e0541fa589c987397d867cc16c83ab1236d31eb6782f2e4552ee9cf80` |
| macOS x64 | `cloudflared-darwin-amd64.tgz` | `81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000` | `947e2942d6a59922d80190d23b12f3ade8da16e23e3bd937182a48993b7c00db` |
| Linux x64 | `cloudflared-linux-amd64` | `053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0` | same as release asset |
| Linux arm64 | `cloudflared-linux-arm64` | `89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8` | same as release asset |
| Windows x64 | `cloudflared-windows-amd64.exe` | `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2` | same as release asset |

The staged executables are generated build output and are intentionally not
checked into git. Set `OMB_CLOUDFLARED_ARCHIVE_DIR` to a directory containing
the exact official release assets to prepare a package from a reviewed local
download. Otherwise the preparation script downloads them from the release URL
above.

The macOS release process applies OpenMausBot's Developer ID signature to the
staged executable as part of signing the app bundle. It verifies the unsigned
upstream digest before that necessary packaging change, then verifies the
nested signature, signing team, and architecture before notarization. Linux
and Windows packages retain the exact reviewed upstream executable bytes.

cloudflared is licensed under Apache License 2.0. The distribution includes a
separately named copy of the complete Apache 2.0 text at
`resources/licenses/cloudflared-LICENSE.txt`.
