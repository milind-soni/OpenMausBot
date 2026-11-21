# Licensing

Edu Bot is open source under the [Apache License 2.0](LICENSE). Everything in
this repository is Apache 2.0, except third-party components, which keep their
own licenses (below).

## Fork attribution

Edu Bot is a fork and derivative work of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot), Copyright 2026
Milind Soni and OpenMausBot contributors, also licensed under Apache 2.0. The
upstream copyright and attribution notices are kept in [NOTICE](NOTICE), below
Edu Bot's own header, which summarises what Edu Bot changed.

Upstream OpenMausBot carries a source-available `enterprise/` directory under a
separate license that forbids redistribution. Edu Bot does not include it: the
server always reports `{"edition":"oss"}`, and the `open-source edition, no
enterprise layer` CI job proves the build and the boot without it. A workspace
explicitly configured for hosted sign-in (`OMB_ADMIN_*`) still refuses remote
access, because the adapter it needs is not part of Edu Bot.

## Contributions

Contribute under Apache 2.0. No DCO sign-off or CLA is required. Submit only
code you wrote or have the right to contribute.

## Third-party components

Bundled third-party software keeps its own licenses; notices, license texts,
source locations and the SBOM are listed in [NOTICE](NOTICE) and
[`third_party/`](third_party/). Every desktop package, the npm package and the
Docker image ship `LICENSE` and `NOTICE`.

## Trademarks

Edu Bot is an independent project and is not affiliated with, endorsed by, or
sponsored by Supamaus Software Private Limited or the OpenMausBot project.
"OpenMausBot", "MausBot" and the SupaMaus mascot are trademarks of Supamaus
Software Private Limited. The Apache License does not grant trademark rights
(section 6); Edu Bot uses those names only to state where the code comes from.
Other product names and provider marks shown in the app belong to their owners
and identify those providers only.
