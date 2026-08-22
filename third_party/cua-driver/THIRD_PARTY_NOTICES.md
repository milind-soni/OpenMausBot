# Cua Driver 0.19.3 third-party notices

OpenMausBot redistributes two executables from the official Cua Driver 0.19.3 Linux x64 release: `cua-driver` and `cua-cursor-theme`.

- Upstream source commit: [`a1672e7b11951275ecfba3384264d4530185d0db`](https://github.com/trycua/cua/commit/a1672e7b11951275ecfba3384264d4530185d0db)
- Upstream `Cargo.lock` SHA-256: `c1a8df7f4bedd554f6fc90c852c3625c91a89b28d9f2c642d966279e9e372362`
- Release archive SHA-256: `3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10`
- Cua's eight workspace components remain under the accompanying MIT `LICENSE.md`.
- The embedded Inter 4.001 font remains under the accompanying SIL OFL 1.1 `Inter-OFL-1.1.txt`.
- Full license texts and attribution for all 330 crates.io packages and Inter are in `THIRD_PARTY_LICENSES.html`.
- The machine-readable inventory contains 330 registry packages, 8 Cua packages, and Inter in `SBOM.cdx.json`.

## MPL-2.0 source availability

The shipped build graph contains exactly the following MPL-2.0 components. Their corresponding Source Code Form is available from the versioned crates below:

- [option-ext@0.2.0 source](https://crates.io/api/v1/crates/option-ext/0.2.0/download) — crate SHA-256 `04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d`;
- [uniffi@0.31.0 source](https://crates.io/api/v1/crates/uniffi/0.31.0/download) — crate SHA-256 `b8c6dec3fc6645f71a16a3fa9ff57991028153bd194ca97f4b55e610c73ce66a`;
- [uniffi_core@0.31.0 source](https://crates.io/api/v1/crates/uniffi_core/0.31.0/download) — crate SHA-256 `b0ef62e69762fbb9386dcb6c87cd3dd05d525fa8a3a579a290892e60ddbda47e`;
- [uniffi_internal_macros@0.31.0 source](https://crates.io/api/v1/crates/uniffi_internal_macros/0.31.0/download) — crate SHA-256 `98f51ebca0d9a4b2aa6c644d5ede45c56f73906b96403c08a1985e75ccb64a01`;
- [uniffi_macros@0.31.0 source](https://crates.io/api/v1/crates/uniffi_macros/0.31.0/download) — crate SHA-256 `db9d12529f1223d014fd501e5f29ca0884d15d6ed5ddddd9f506e55350327dc3`;
- [uniffi_meta@0.31.0 source](https://crates.io/api/v1/crates/uniffi_meta/0.31.0/download) — crate SHA-256 `9df6d413db2827c68588f8149d30d49b71d540d46539e435b23a7f7dbd4d4f86`;
- [uniffi_pipeline@0.31.0 source](https://crates.io/api/v1/crates/uniffi_pipeline/0.31.0/download) — crate SHA-256 `a806dddc8208f22efd7e95a5cdf88ed43d0f3271e8f63b47e757a8bbdb43b63a`;

The complete MPL-2.0 text and package copyright notices appear in `THIRD_PARTY_LICENSES.html`. These files remain under their original licenses; OpenMausBot's and Cua's MIT licenses do not replace them.

## Scope and method

The registry inventory is the union of two root-scoped `cargo-about 0.8.4` graphs: `cua-driver` with `portal-input` for `x86_64-unknown-linux-gnu`, and `cursor-theme-cli` for the same target. Development-only dependencies are excluded; build dependencies are retained. Raw workspace-unified Cargo metadata is not used as the inventory because features enabled only by unrelated workspace members would overstate the shipped graph.

### Cua workspace components

| Package | Version | License |
|---|---:|---|
| cua-driver | 0.19.3 | MIT |
| cua-driver-contract | 0.19.3 | MIT |
| cua-driver-core | 0.19.3 | MIT |
| cua-driver-sdk | 0.19.3 | MIT |
| cursor-overlay | 0.19.3 | MIT |
| cursor-theme-cli | 0.19.3 | MIT |
| pip-preview | 0.19.3 | MIT |
| platform-linux | 0.19.3 | MIT |

### crates.io release-build inventory

| Package | Version | Declared license expression | Crate SHA-256 |
|---|---:|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | `320119579fcad9c21884f5c4861d16174d0e06250625266f50fe6898340abefa` |
| ahash | 0.8.12 | MIT OR Apache-2.0 | `5a15f179cd60c4584b8a8c596927aadc462e27f2ca70c04e0071964a73ba7a75` |
| aho-corasick | 1.1.4 | Unlicense OR MIT | `ddd31a130427c27518df266943a5308ed92d4b226cc639f5a8f1002816174301` |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 | `683d7910e743518b0e34f1186f92494becacb047c7b6bf616c96772180fef923` |
| anyhow | 1.0.102 | MIT OR Apache-2.0 | `7f202df86484c868dbad7eaa557ef785d5c66295e41b460ef922eca0723b842c` |
| arrayref | 0.3.9 | BSD-2-Clause | `76a2e8124351fda1ef8aaaa3bbd7ebbcb486bbcd4225aca0aa0d84bb2db8fecb` |
| arrayvec | 0.7.6 | MIT OR Apache-2.0 | `7c02d123df017efcdfbd739ef81735b36c5ba83ec3c59c80a9d7ecc718f92e50` |
| ashpd | 0.13.11 | MIT | `340e0f6bf7f9ee78549c61454f1460a3ed97c011902ee76b58301bbc6d502a32` |
| async-broadcast | 0.7.2 | MIT OR Apache-2.0 | `435a87a52755b8f27fcf321ac4f04b2802e337c8c4872923137471ec39c37532` |
| async-channel | 2.5.0 | Apache-2.0 OR MIT | `924ed96dd52d1b75e9c1a3e6275715fd320f5f9439fb5a4a11fa51f4221158d2` |
| async-compat | 0.2.5 | Apache-2.0 OR MIT | `a1ba85bc55464dcbf728b56d97e119d673f4cf9062be330a9a26f3acf504a590` |
| async-executor | 1.14.0 | Apache-2.0 OR MIT | `c96bf972d85afc50bf5ab8fe2d54d1586b4e0b46c97c50a0c9e71e2f7bcd812a` |
| async-io | 2.6.0 | Apache-2.0 OR MIT | `456b8a8feb6f42d237746d4b3e9a178494627745c3c56c6ea55d92ba50d026fc` |
| async-lock | 3.4.2 | Apache-2.0 OR MIT | `290f7f2596bd5b78a9fec8088ccd89180d7f9f55b94b0576823bbbdc72ee8311` |
| async-process | 2.5.0 | Apache-2.0 OR MIT | `fc50921ec0055cdd8a16de48773bfeec5c972598674347252c0399676be7da75` |
| async-recursion | 1.1.1 | MIT OR Apache-2.0 | `3b43422f69d8ff38f95f1b2bb76517c91589a924d1559a0e935d7c8ce0274c11` |
| async-signal | 0.2.14 | Apache-2.0 OR MIT | `52b5aaafa020cf5053a01f2a60e8ff5dccf550f0f77ec54a4e47285ac2bab485` |
| async-task | 4.7.1 | Apache-2.0 OR MIT | `8b75356056920673b02621b35afd0f7dda9306d03c79a30f5c56c44cf256e3de` |
| async-trait | 0.1.89 | MIT OR Apache-2.0 | `9035ad2d096bed7955a320ee7e2230574d28fd3c3a0f186cbea1ff3c7eed5dbb` |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | `1505bd5d3d116872e7271a6d4e16d81d0c8570876c8de68093a09ac269d8aac0` |
| atspi-common | 0.14.0 | Apache-2.0 OR MIT | `f8a79bed3f5b408ce3152f36e07327a845e6ed5d7e2821a89264037dbcc11daf` |
| atspi-connection | 0.14.0 | Apache-2.0 OR MIT | `8fab8e4f574f5a7d3af280b38eff25fb6f47a537dac9ae39ce152f52b19fb10b` |
| atspi-proxies | 0.14.0 | Apache-2.0 OR MIT | `53403acd3ab2fdb5914f6558da22e540fc07656fce5510f8c02be0e6ef68413e` |
| atspi | 0.30.0 | Apache-2.0 OR MIT | `6bf601cccedfffec598ec2db1f9d6745885458bccc0e8916d7023f017c94b3d0` |
| autocfg | 1.5.0 | Apache-2.0 OR MIT | `c08606f8c3cbf4ce6ec8e28fb0014a2c086708fe954eaa885384a6165172e7e8` |
| base64 | 0.22.1 | MIT OR Apache-2.0 | `72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6` |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | `08807e080ed7f9d5433fa9b275196cfc35414f66a0c79d864dc51a0d825231a3` |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | `5e764a1d40d510daf35e07be9eb06e75770908c27d411ee6c92109c9840eaaf7` |
| bitflags | 1.3.2 | MIT OR Apache-2.0 | `bef38d45163c2f1dde094a7dfd33ccf595c92905c8f8f4fdc18d06fb1037718a` |
| bitflags | 2.11.1 | MIT OR Apache-2.0 | `c4512299f36f043ab09a583e57bceb5a5aab7a73db1805848e8fef3c9e8c78b3` |
| bitvec | 1.0.1 | MIT | `1bc2832c24239b0141d5674bb9174f9d68a8b5b3f2753311927c172ca46f7e9c` |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | `3078c7629b62d3f0439517fa394996acacc5cbc91c5a20d8c658e77abd503a71` |
| blocking | 1.6.2 | Apache-2.0 OR MIT | `e83f8d02be6967315521be875afa792a316e28d57b5a2d401897e2a7921b7f21` |
| borrow-or-share | 0.2.4 | MIT-0 | `dc0b364ead1874514c8c2855ab558056ebfeb775653e7ae45ff72f28f8f3166c` |
| bstr | 1.13.0 | MIT OR Apache-2.0 | `1f7dc094d718f2e1c1559ad110e27eeaae14a5465d3d56dd6dbd793079fbd530` |
| bumpalo | 3.20.2 | MIT OR Apache-2.0 | `5d20789868f4b01b2f2caec9f5c4e0213b41e3e5702a50157d699ae31ced2fcb` |
| bytecount | 0.6.9 | Apache-2.0 OR MIT | `175812e0be2bccb6abe50bb8d566126198344f707e304f45c648fd8f2cc0365e` |
| bytemuck | 1.25.0 | Zlib OR Apache-2.0 OR MIT | `c8efb64bd706a16a1bdde310ae86b351e4d21550d98d056f22f8a7f7a2183fec` |
| byteorder-lite | 0.1.0 | Unlicense OR MIT | `8f1fe948ff07f4bd06c30984e69f5b4899c516a3ef74f34df92a2df2ab535495` |
| byteorder | 1.5.0 | Unlicense OR MIT | `1fd0f2584146f6f2ef48085050886acf353beff7305ebd1ae69500e27c67f64b` |
| bytes | 1.11.1 | MIT | `1e748733b7cbc798e1434b6ac524f0c1ff2ab456fe201501e6497c8417a4fc33` |
| calloop | 0.14.4 | MIT | `4dbf9978365bac10f54d1d4b04f7ce4427e51f71d61f2fe15e3fed5166474df7` |
| camino | 1.2.4 | MIT OR Apache-2.0 | `5f2d30e4173c4026932d51d31d6b0613b1fd3014bf3f9f8943d4ba139c437ba0` |
| cargo_metadata | 0.19.2 | MIT | `dd5eb614ed4c27c5d706420e4320fbe3216ab31fa1c33cd8246ac36dae4479ba` |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | `e35af189006b9c0f00a064685c727031e3ed2d8020f7ba284d78cc2671bd36ea` |
| cc | 1.2.62 | MIT OR Apache-2.0 | `a1dce859f0832a7d088c4f1119888ab94ef4b5d6795d1ce05afb7fe159d79f98` |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 | `9330f8b2ff13f34540b44e946ef35111825727b38d33286ef986142615121801` |
| chacha20 | 0.10.1 | MIT OR Apache-2.0 | `d524456ba66e72eb8b115ff89e01e497f8e6d11d78b70b1aa13c0fbd97540a81` |
| chrono-tz | 0.10.4 | MIT OR Apache-2.0 | `a6139a8597ed92cf816dfb33f5dd6cf0bb93a6adc938f11039f371bc5bcd26c3` |
| chrono | 0.4.45 | MIT OR Apache-2.0 | `1aa79e62e7697b8e29b513a68abacf485adcd1fe8284a4316c5ae868e6633327` |
| clipboard-rs | 0.3.5 | MIT | `d1c988a897ea030e32f0668c90b0192800e0c561b3d941fc366f9ad5a1bf26ba` |
| cobs | 0.3.0 | MIT OR Apache-2.0 | `0fa961b519f0b462e3a3b4a34b64d119eeaca1d59af726fe450bbba07a9fc0a1` |
| concurrent-queue | 2.5.0 | Apache-2.0 OR MIT | `4ca0197aee26d1ae37445ee532fefce43251d24cc7c166799f4d46817f1d3973` |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | `59ed5838eebb26a2bb2e58f6d5b5316989ae9d08bab10e0e6d103e656d1b0280` |
| cpufeatures | 0.3.0 | MIT OR Apache-2.0 | `8b2a41393f66f16b0823bb79094d54ac5fbd34ab292ddafb9a0456ac9f87d201` |
| crc32fast | 1.5.0 | MIT OR Apache-2.0 | `9481c1c90cbf2ac953f07c8d4a58aa3945c425b7185c9154d67a65e4230da511` |
| crossbeam-channel | 0.5.15 | MIT OR Apache-2.0 | `82b8f8f868b36967f9606790d1903570de9ceaf870a7bf9fbbd3016d636a2cb2` |
| crossbeam-utils | 0.8.21 | MIT OR Apache-2.0 | `d0a5c400df2834b80a4c3327b3aad3a4c4cd4de0629063962b03235697506a28` |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | `78c8292055d1c1df0cce5d180393dc8cce0abec0a7102adb6c7b1eef6016d60a` |
| data-encoding | 2.11.0 | MIT | `a4ae5f15dda3c708c0ade84bfee31ccab44a3da4f88015ed22f63732abe300c8` |
| digest | 0.10.7 | MIT OR Apache-2.0 | `9ed9a281f7bc9b7576e61468ba615a66a5c8cfdff42420a70aa82701a3b1e292` |
| dirs-sys | 0.4.1 | MIT OR Apache-2.0 | `520f05a5cbd335fae5a99ff7a6ab8627577660ee5cfd6a94a6a929b52ff0321c` |
| dirs | 5.0.1 | MIT OR Apache-2.0 | `44c45a9d03d6676652bcb5e724c7e988de1acad23a711b5217ab9cbecbec2225` |
| displaydoc | 0.2.5 | MIT OR Apache-2.0 | `97369cbbc041bc366949bc74d34658d6cda5621039731c6310521892a3a20ae0` |
| downcast-rs | 1.2.1 | MIT OR Apache-2.0 | `75b325c5dbd37f80359721ad39aca5a29fb04c89279657cffdda8736d0c0b9d2` |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | `d0881ea181b1df73ff77ffaaf9c7544ecc11e82fba9b5f27b262a3c73a332555` |
| email_address | 0.2.9 | MIT | `e079f19b08ca6239f47f8ba8509c11cf3ea30095831f7fed61441475edd8c449` |
| endi | 1.1.1 | MIT | `66b7e2430c6dff6a955451e2cfc438f09cea1965a9d6f87f7e3b90decc014099` |
| enumflags2_derive | 0.7.12 | MIT OR Apache-2.0 | `67c78a4d8fdf9953a5c9d458f9efe940fd97a0cab0941c075a813ac594733827` |
| enumflags2 | 0.7.12 | MIT OR Apache-2.0 | `1027f7680c853e056ebcec683615fb6fbbc07dbaa13b4d5d9442b146ded4ecef` |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | `877a4ace8713b0bcf2a4e7eec82529c029f1d0619886d18145fea96c3ffe5c0f` |
| errno | 0.3.14 | MIT OR Apache-2.0 | `39cab71617ae0d63f51a36d69f866391735b51691dbda63cf6f96d042b63efeb` |
| evdev | 0.12.2 | Apache-2.0 OR MIT | `ab6055a93a963297befb0f4f6e18f314aec9767a4bbe88b151126df2433610a7` |
| event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT | `8be9f3dfaaffdae2972880079a491a1a8bb7cbed0b8dd7a347f668b4150a3b93` |
| event-listener | 5.4.1 | Apache-2.0 OR MIT | `e13b66accf52311f30a0db42147dadea9850cb48cd070028831ae5f5d4b856ab` |
| fancy-regex | 0.18.0 | MIT | `e1e1dacd0d2082dfcf1351c4bdd566bbe89a2b263235a2b50058f1e130a47277` |
| fastrand | 2.4.1 | Apache-2.0 OR MIT | `9f1f227452a390804cdb637b74a86990f2a7d7ba4b7d5693aac9b4dd6defd8d6` |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | `1e6853b52649d4ac5c0bd02320cddc5ba956bdb407c4b75a2c6b75bf51500f8c` |
| filetime | 0.2.29 | MIT OR Apache-2.0 | `5c287a33c7f0a620c38e641e7f60827713987b3c0f26e8ddc9462cc69cf75759` |
| find-msvc-tools | 0.1.9 | MIT OR Apache-2.0 | `5baebc0774151f905a1a2cc41989300b1e6fbb29aff0ceffa1064fdd3088d582` |
| fixedbitset | 0.5.7 | MIT OR Apache-2.0 | `1d674e81391d1e1ab681a28d99df07927c6d4aa5b027d7da16ba32d1d21ecd99` |
| flate2 | 1.1.9 | MIT OR Apache-2.0 | `843fba2746e448b37e26a819579957415c8cef339bf08564fe8b7ddbd959573c` |
| fluent-uri | 0.4.1 | MIT | `bc74ac4d8359ae70623506d512209619e5cf8f347124910440dbc221714b328e` |
| fnv | 1.0.7 | Apache-2.0 OR MIT | `3f9eec918d3f24069decb9af1554cad7c880e2da24a9afd88aca000531ab82c1` |
| foldhash | 0.1.5 | Zlib | `d9c4f5dac5e15c24eb999c26181a6ca40b39fe946cbe4c263c7209467bc83af2` |
| foldhash | 0.2.0 | Zlib | `77ce24cb58228fbb8aa041425bb1050850ac19177686ea6e0f41a70416f56fdb` |
| fontdue | 0.9.3 | MIT OR Apache-2.0 OR Zlib | `2e57e16b3fe8ff4364c0661fdaac543fb38b29ea9bc9c2f45612d90adf931d2b` |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | `cb4cb245038516f5f85277875cdaa4f7d2c9a0fa0468de06ed190163b1581fcf` |
| fraction | 0.15.4 | MIT OR Apache-2.0 | `e076045bb43dac435333ed5f04caf35c7463631d0dae2deb2638d94dd0a5b872` |
| fs-err | 2.11.0 | MIT OR Apache-2.0 | `88a41f105fe1d5b6b34b2055e3dc59bb79b46b48b2040b9e6c7b4b5de097aa41` |
| funty | 2.0.0 | MIT | `e6d5a32815ae3f33302d95fdcb2ce17862f8c65363dcfd29360480ba1001fc9c` |
| futures-core | 0.3.32 | MIT OR Apache-2.0 | `7e3450815272ef58cec6d564423f6e755e25379b217b0bc688e295ba24df6b1d` |
| futures-io | 0.3.32 | MIT OR Apache-2.0 | `cecba35d7ad927e23624b22ad55235f2239cfa44fd10428eecbeba6d6a717718` |
| futures-lite | 2.6.1 | Apache-2.0 OR MIT | `f78e10609fe0e0b3f4157ffab1876319b5b0db102a2c60dc4626306dc46b44ad` |
| futures-macro | 0.3.32 | MIT OR Apache-2.0 | `e835b70203e41293343137df5c0664546da5745f82ec9b84d40be8336958447b` |
| futures-sink | 0.3.32 | MIT OR Apache-2.0 | `c39754e157331b013978ec91992bde1ac089843443c49cbc7f46150b0fad0893` |
| futures-task | 0.3.32 | MIT OR Apache-2.0 | `037711b3d59c33004d3856fbdc83b99d4ff37a24768fa1be9ce3538a1cde4393` |
| futures-util | 0.3.32 | MIT OR Apache-2.0 | `389ca41296e6190b48053de0321d02a77f32f8a5d2461dd38762c0593805c6d6` |
| generic-array | 0.14.7 | MIT | `85649ca51fd72272d7821adaf274ad91c288277713d9c18820d8499a7ff69e9a` |
| gethostname | 1.1.0 | Apache-2.0 | `1bd49230192a3797a9a4d6abe9b3eed6f7fa4c8a8a4947977c6f80025f92cbd8` |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | `ff2abc00be7fca6ebc474524697ae276ad847ad0a6b3faa4bcb027e9a4614ad0` |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | `899def5c37c4fd7b2664648c28120ecec138e4d395b459e5ca34f9cce2dd77fd` |
| getrandom | 0.4.2 | MIT OR Apache-2.0 | `0de51e6874e94e7bf76d726fc5d13ba782deca734ff60d5bb2fb2607c7406555` |
| globset | 0.4.19 | Unlicense OR MIT | `e47d37d2ae4464254884b60ab7071be2b876a9c35b696bd018ddcc76847309cd` |
| hash32 | 0.2.1 | MIT OR Apache-2.0 | `b0c35f58762feb77d74ebe43bdbc3210f09be9fe6742234d573bacc26ed92b67` |
| hashbrown | 0.15.5 | MIT OR Apache-2.0 | `9229cfe53dfd69f0609a49f65461bd93001ea1ef889cd5529dd176593f5338a1` |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 | `841d1cc9bed7f9236f321df977030373f4a4163ae1a7dbfe1a51a2c1a51d9100` |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | `ed5909b6e89a2db4456e54cd5f673791d7eca6732202bbf2a9cc504fe2f9b84a` |
| heapless | 0.7.17 | MIT OR Apache-2.0 | `cdc6457c0eb62c71aac4bc17216026d8410337c4126773b9c5daba343f17964f` |
| heck | 0.5.0 | MIT OR Apache-2.0 | `2304e00983f87ffb38b55b444b5e3b60a884b5d30c0fca7d82fe33449bbe55ea` |
| hex | 0.4.3 | MIT OR Apache-2.0 | `7f24254aa9a54b5c858eaee2f5bccdb46aaf0e486a595ed5fd8f86ba55232a70` |
| http | 1.4.0 | MIT OR Apache-2.0 | `e3ba2a386d7f85a81f119ad7498ebe444d2e22c2af0b86b069416ace48b3311a` |
| httparse | 1.10.1 | MIT OR Apache-2.0 | `6dbf3de79e51f3d586ab4cb9d5c3e2c14aa28ed23d180cf89b4df0454a69cc87` |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | `e31bc9ad994ba00e440a8aa5c9ef0ec67d5cb5e5cb0cc7f8b744a35b389cc470` |
| icu_collections | 2.2.0 | Unicode-3.0 | `2984d1cd16c883d7935b9e07e44071dca8d917fd52ecc02c04d5fa0b5a3f191c` |
| icu_locale_core | 2.2.0 | Unicode-3.0 | `92219b62b3e2b4d88ac5119f8904c10f8f61bf7e95b640d25ba3075e6cac2c29` |
| icu_normalizer_data | 2.2.0 | Unicode-3.0 | `da3be0ae77ea334f4da67c12f149704f19f81d1adf7c51cf482943e84a2bad38` |
| icu_normalizer | 2.2.0 | Unicode-3.0 | `c56e5ee99d6e3d33bd91c5d85458b6005a22140021cc324cea84dd0e72cff3b4` |
| icu_properties_data | 2.2.0 | Unicode-3.0 | `8e2bbb201e0c04f7b4b3e14382af113e17ba4f63e2c9d2ee626b720cbce54a14` |
| icu_properties | 2.2.0 | Unicode-3.0 | `bee3b67d0ea5c2cca5003417989af8996f8604e34fb9ddf96208a033901e70de` |
| icu_provider | 2.2.0 | Unicode-3.0 | `139c4cf31c8b5f33d7e199446eff9c1e02decfc2f0eec2c8d71f65befa45b421` |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | `cb68373c0d6620ef8105e855e7745e18b0d00d3bdb07fb532e434244cdb9a714` |
| idna | 1.1.0 | MIT OR Apache-2.0 | `3b0875f23caa03898994f6ddc501886a45c7d3d62d04d2d90788d47be1b1e4de` |
| image | 0.25.10 | MIT OR Apache-2.0 | `85ab80394333c02fe689eaf900ab500fbd0c2213da414687ebf995a65d5a6104` |
| indexmap | 2.14.0 | Apache-2.0 OR MIT | `d466e9454f08e4a911e14806c24e16fba1b4c121d1ea474396f396069cf949d9` |
| ipnet | 2.12.0 | MIT OR Apache-2.0 | `d98f6fed1fde3f8c21bc40a1abb88dd75e67924f9cffc3ef95607bad8017f8e2` |
| itoa | 1.0.18 | MIT OR Apache-2.0 | `8f42a60cbdf9a97f5d2305f08a87dc4e09308d1276d28c869c684d7777685682` |
| jobserver | 0.1.35 | MIT OR Apache-2.0 | `1c00acbd29eabad4a2392fa0e921c874934dbbf4194312ad20f04a0ed67a3cb3` |
| jsonschema-regex | 0.46.10 | MIT | `6dbd1086b01b9349fd4ef9a07433965af64c8ce8159abe633a189e4ff817bd13` |
| jsonschema | 0.46.10 | MIT | `f0a699d3e77675e6aa4bfffe3b907c8b5f7ed3241f9965bffb25475ad4b08d05` |
| lazy_static | 1.5.0 | MIT OR Apache-2.0 | `bbd2bcb4c963f2ddae06a2efc7e9f3591312473c50c6685e1f298068316e66fe` |
| libc | 0.2.186 | MIT OR Apache-2.0 | `68ab91017fe16c622486840e4c83c9a37afeff978bd239b5293d61ece587de66` |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | `32a66949e030da00e8c7d4434b251670a91556f4144941d37452769c25d58a53` |
| litemap | 0.8.2 | Unicode-3.0 | `92daf443525c4cce67b150400bc2316076100ce0b3686209eb8cf3c31612e6f0` |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | `224399e74b87b5f3557511d98dff8b14089b3dadafcab6bb93eab67d3aace965` |
| log | 0.4.29 | MIT OR Apache-2.0 | `5e5032e24019045c762d3c0f28f5b6b8bbf38563a65908389bf7978758920897` |
| lru | 0.18.1 | MIT | `0b6180140927ee907000b0aa540091f6ea512ead4447c92b8fc35bc72788a5a6` |
| matchers | 0.2.0 | MIT | `d1525a2a28c7f4fa0fc98bb91ae755d1e2d1505079e05539e35bc876b5d65ae9` |
| memchr | 2.8.0 | Unlicense OR MIT | `f8ca58f447f06ed17d5fc4043ce1b10dd205e060fb3ce5b979b8ed8e59ff3f79` |
| memmap2 | 0.9.10 | MIT OR Apache-2.0 | `714098028fe011992e1c3962653c96b2d578c4b4bce9036e15ff220319b1e0e3` |
| memoffset | 0.6.5 | MIT | `5aa361d4faea93603064a027415f07bd8e1d5c88c9fbf68bf56a285428fd79ce` |
| meval | 0.2.0 | Unlicense OR MIT | `f79496a5651c8d57cd033c5add8ca7ee4e3d5f7587a4777484640d9cb60392d9` |
| micromap | 0.3.0 | MIT | `c2a86d3146ed3995b5913c414f6664344b9617457320782e64f0bb44afd49d74` |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | `1fa76a2c86f704bdb222d66965fb3d63269ce38518b83cb0575fca855ebb6316` |
| mio | 1.2.0 | MIT | `50b7e5b27aa02a74bac8c3f23f448f8d87ff11f92d3aac1a6ed369ee08cc56c1` |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | `bb85c154ba489f01b25c0d36ae69a87e4a1c73a72631fc6c0eb6dde34a73e44b` |
| msvc_spectre_libs | 0.1.3 | MIT OR Apache-2.0 | `29e871a9861f3664f18b7e04e9301d4edd55090c2dadb4b1c602e26ab32b1f5b` |
| nix | 0.23.2 | MIT | `8f3790c00a0150112de0f4cd161e3d7fc4b2d8a5542ffc35f099a2562aecb35c` |
| nom | 1.2.4 | MIT | `a5b8c256fd9471521bcb84c3cdba98921497f1a331cbc15b8030fc63b82050ce` |
| nom | 8.0.0 | MIT | `df9761775871bdef83bee530e60050f7e54b1105350d6884eb0fb4f46c2f9405` |
| nu-ansi-term | 0.50.3 | MIT | `7957b9740744892f114936ab4a57b3f487491bbeafaf8083688b16841a4240e5` |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 | `c89e69e7e0f03bea5ef08013795c25018e101932225a656383bd384495ecc367` |
| num-cmp | 0.1.0 | MIT OR Apache-2.0 | `63335b2e2c34fae2fb0aa2cecfd9f0832a1e24b3b32ecec612c3426d46dc8aaa` |
| num-complex | 0.4.6 | MIT OR Apache-2.0 | `73f88a1307638156682bada9d7604135552957b7818057dcef22705b4d509495` |
| num-integer | 0.1.46 | MIT OR Apache-2.0 | `7969661fd2958a5cb096e56c8e1ad0444ac2bbcd0061bd28660485a44879858f` |
| num-iter | 0.1.46 | MIT OR Apache-2.0 | `c92800bd69a1eac91786bcfe9da64a897eb72911b8dc3095decbd07429e8048b` |
| num-rational | 0.4.2 | MIT OR Apache-2.0 | `f83d14da390562dca69fc84082e73e548e1ad308d24accdedd2720017cb37824` |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | `071dfc062690e90b734c0b2273ce72ad0ffa95f0c74596bc250dcfd960262841` |
| num | 0.4.3 | MIT OR Apache-2.0 | `35bd024e8b2ff75562e5f34e7f4905839deb4b22955ef5e73d2fea1b9813cb23` |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | `9f7c3e4beb33f85d45ae3e3a1792185706c8e16d043238c593331cc7cd313b50` |
| option-ext | 0.2.0 | MPL-2.0 | `04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d` |
| ordered-stream | 0.2.0 | MIT OR Apache-2.0 | `9aa2b01e1d916879f73a53d01d1d6cee68adbb31d6d9177a8cfce093cced1d50` |
| os_pipe | 1.2.3 | MIT | `7d8fae84b431384b68627d0f9b3b1245fcf9f46f6c0e3dc902e9dce64edd1967` |
| outref | 0.5.2 | MIT | `1a80800c0488c3a21695ea981a54918fbb37abf04f4d0720c453632255e2ff0e` |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | `2621685985a2ebf1c516881c026032ac7deafcda1a2c9b7850dc81e3dfcb64c1` |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | `93857453250e3077bd71ff98b6a65ea6621a19bb0f559a85248955ac12c45a1a` |
| parking | 2.2.1 | Apache-2.0 OR MIT | `f38d5652c16fde515bb1ecef450ab0f6a219d619a7274976324d5e377f7dceba` |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | `9b4f627cb1b25917193a259e49bdad08f671f8d9708acfd5fe0a8c1455d87220` |
| petgraph | 0.8.3 | MIT OR Apache-2.0 | `8701b58ea97060d5e5b155d383a69952a60943f0e6dfe30b04c287beb0b27455` |
| phf_shared | 0.12.1 | MIT | `06005508882fb681fd97892ecff4b7fd0fee13ef1aa569f8695dae7ab9099981` |
| phf | 0.12.1 | MIT | `913273894cec178f401a31ec4b656318d95473527be05c0752cc41cdc32be8b7` |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | `a89322df9ebe1c1578d689c92318e070967d1042b512afbe49518723f4e6d5cd` |
| piper | 0.2.5 | MIT OR Apache-2.0 | `c835479a4443ded371d6c535cbfd8d31ad92c5d23ae9770a61bc155e4992a3c1` |
| pkg-config | 0.3.33 | MIT OR Apache-2.0 | `19f132c84eca552bf34cab8ec81f1c1dcc229b811638f9d283dceabe58c5569e` |
| png | 0.18.1 | MIT OR Apache-2.0 | `60769b8b31b2a9f263dae2776c37b1b28ae246943cf719eb6946a1db05128a61` |
| polling | 3.11.0 | Apache-2.0 OR MIT | `5d0e4f59085d47d8241c88ead0f274e8a0cb551f3625263c05eb8dd897c34218` |
| postcard | 1.1.3 | MIT OR Apache-2.0 | `6764c3b5dd454e283a30e6dfe78e9b31096d9e32036b5d1eaac7a6119ccb9a24` |
| potential_utf | 0.1.5 | Unicode-3.0 | `0103b1cef7ec0cf76490e969665504990193874ea05c85ff9bab8b911d0a0564` |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 | `85eae3c4ed2f50dcfe72643da4befc30deadb458a9b590d720cde2f2b1e97da9` |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 | `e67ba7e9b2b56446f1d419b1d807906278ffa1a658a8a5d8a39dcb1f5a78614f` |
| proc-macro2 | 1.0.106 | MIT OR Apache-2.0 | `8fd00f0bb2e90d81d1044c2b32617f68fcb9fa3bb7640c23e9c748e53fb30934` |
| pxfm | 0.1.29 | BSD-3-Clause OR Apache-2.0 | `e0c5ccf5294c6ccd63a74f1565028353830a9c2f5eb0c682c355c471726a6e3f` |
| quick-xml | 0.39.4 | MIT | `cdcc8dd4e2f670d309a5f0e83fe36dfdc05af317008fea29144da1a2ac858e5e` |
| quote | 1.0.45 | MIT OR Apache-2.0 | `41f2619966050689382d2b44f664f4bc593e129785a36d6ee376ddf37259b924` |
| radium | 0.7.0 | MIT | `dc33ff2d4973d518d823d61aa239014831e521c75da58e3df4840d3f47749d09` |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 | `e6c10a63a0fa32252be49d21e7709d4d4baf8d231c2dbce1eaa8141b9b127d88` |
| rand_core | 0.10.1 | MIT OR Apache-2.0 | `63b8176103e19a2643978565ca18b50549f6101881c443590420e4dc998a3c69` |
| rand_core | 0.6.4 | MIT OR Apache-2.0 | `ec0be4795e2f6a28069bec0b5ff3e2ac9bafc99e6a9a7dc3547996c5c816922c` |
| rand | 0.10.2 | MIT OR Apache-2.0 | `c7f5fa3a058cd35567ef9bfa5e75732bee0f9e4c55fa90477bef2dfcdbc4be80` |
| rand | 0.8.6 | MIT OR Apache-2.0 | `5ca0ecfa931c29007047d1bc58e623ab12e5590e8c7cc53200d5202b69266d8a` |
| ref-cast-impl | 1.0.25 | MIT OR Apache-2.0 | `b7186006dcb21920990093f30e3dea63b7d6e977bf1256be20c3563a5db070da` |
| ref-cast | 1.0.25 | MIT OR Apache-2.0 | `f354300ae66f76f1c85c5f84693f0ce81d747e2c3f21a45fef496d89c960bf7d` |
| referencing | 0.46.10 | MIT | `0fbf332a2f81899f6836f22c03da73dae8a664c32e3016b84692c23cddadc95d` |
| regex-automata | 0.4.14 | MIT OR Apache-2.0 | `6e1dd4122fc1595e8162618945476892eefca7b88c52820e74af6262213cae8f` |
| regex-syntax | 0.8.10 | MIT OR Apache-2.0 | `dc897dd8d9e8bd1ed8cdad82b5966c3e0ecae09fb1907d58efaa013543185d0a` |
| regex | 1.12.3 | MIT OR Apache-2.0 | `e10754a14b9137dd7b1e3e5b0493cc9171fdd105e0ab477f51b72e7f3ac0e276` |
| regorus | 0.10.1 | MIT AND Apache-2.0 AND BSD-3-Clause | `419a0413adeece71e4d4a64fb75adc359cb807496f0dfd10f429517be908b807` |
| reis | 0.7.0 | MIT | `81f3fedd2777cde52c1be5e572efbec485eac7b801c47820eda388d4f13b9c4b` |
| ring | 0.17.14 | Apache-2.0 AND ISC | `a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7` |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 | `cfcb3a22ef46e85b45de6ee7e79d063319ebb6594faafcf1c225ea92ab6e9b92` |
| rustix | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | `b6fe4565b9518b83ef4f91bb47ce29620ca828bd32cb7e408f0062e9930ba190` |
| rustls-pki-types | 1.14.1 | MIT OR Apache-2.0 | `30a7197ae7eb376e574fe940d068c30fe0462554a3ddbe4eca7838e049c937a9` |
| rustls-webpki | 0.103.13 | ISC | `61c429a8649f110dddef65e2a5ad240f747e85f7758a6bccc7e5777bd33f756e` |
| rustls | 0.23.40 | Apache-2.0 OR ISC OR MIT | `ef86cd5876211988985292b91c96a8f2d298df24e75989a43a3c73f2d4d8168b` |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 | `9774ba4a74de5f7b1c1451ed6cd5285a32eddb5cccb8cc655a4e50009e06477f` |
| schemars_derive | 1.2.1 | MIT | `7d115b50f4aaeea07e79c1912f645c7513d81715d0420f8bc77a18c6260b307f` |
| schemars | 1.2.1 | MIT | `a2b42f36aa1cd011945615b92222f6bf73c599a102a300334cd7f8dbeec726cc` |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | `94143f37725109f92c262ed2cf5e59bce7498c01bcc1502d7b9afe439a4e9f49` |
| semver | 1.0.28 | MIT OR Apache-2.0 | `8a7852d02fc848982e0c167ef163aaff9cd91dc640ba85e263cb1ce46fae51cd` |
| serde_core | 1.0.228 | MIT OR Apache-2.0 | `41d385c7d4ca58e59fc732af25c3983b67ac852c1a25000afe1175de458b67ad` |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | `18d26a20a969b9e3fdf2fc2d9f21eda6c40e2de84c9408bb5d3b05d499aae711` |
| serde_derive | 1.0.228 | MIT OR Apache-2.0 | `d540f220d3187173da220f885ab66608367b6574e925011a9353e4badda91d79` |
| serde_json | 1.0.149 | MIT OR Apache-2.0 | `83fc039473c5595ace860d8c4fafa220ff474b3fc6bfdb4293327f1a37e94d86` |
| serde_repr | 0.1.20 | MIT OR Apache-2.0 | `175ee3e80ae9982737ca543e96133087cbd9a485eecc3bc4de9c1a37b47ea59c` |
| serde_spanned | 1.1.1 | MIT OR Apache-2.0 | `6662b5879511e06e8999a8a235d848113e942c9124f211511b16466ee2995f26` |
| serde_yaml_ng | 0.10.0 | MIT | `7b4db627b98b36d4203a7b458cf3573730f2bb591b28871d916dfa9efabfd41f` |
| serde_yaml | 0.9.34+deprecated | MIT OR Apache-2.0 | `6a8b1a1a2ebf674015cc02edccce75287f1a0130d394307b36743c2f5d504b47` |
| serde | 1.0.228 | MIT OR Apache-2.0 | `9a8e94ea7f378bd32cbbd37198a4a91436180c5bb472411e48b5ec2e2124ae9e` |
| sha1 | 0.10.6 | MIT OR Apache-2.0 | `e3bf829a2d51ab4a5ddf1352d8470c140cadc8301b2ae1789db023f01cedd6ba` |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | `a7507d819769d01a365ab707794a4084392c824f54a7a6a7862f8c3d0892b283` |
| sharded-slab | 0.1.7 | MIT | `f40ca3c46823713e0d4209592e8d6e826aa57e928f09752619fc696c499637f6` |
| shlex | 1.3.0 | MIT OR Apache-2.0 | `0fda2ff0d084019ba4d7c6f371c95d8fd75ce3524c3cb8fb653a3023f6323e64` |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 | `c4db69cba1110affc0e9f7bcd48bbf87b3f4fc7c61fc9155afd4c469eb3d6c1b` |
| simd-adler32 | 0.3.9 | MIT | `703d5c7ef118737c72f1af64ad2f6f8c5e1921f818cdcb97b8fe6fc69bf66214` |
| siphasher | 1.0.2 | MIT OR Apache-2.0 | `b2aa850e253778c88a04c3d7323b043aeda9d3e30d5971937c1855769763678e` |
| slab | 0.4.12 | MIT | `0c790de23124f9ab44544d7ac05d60440adc586479ce501c1d6d7da3cd8c9cf5` |
| smallvec | 1.15.1 | MIT OR Apache-2.0 | `67b1b7a3b5fe4f1376887184045fcf45c69e92af734b7aaddc05fb777b6fbd03` |
| socket2 | 0.6.3 | MIT OR Apache-2.0 | `3a766e1110788c36f4fa1c2b71b387a7815aa65f88ce0229841826633d93723e` |
| spin | 0.10.1 | MIT | `023a211cb3138dbc438680b32560ad89f699977624c9f8dbb95a47d5b4c07dd3` |
| spin | 0.9.9 | MIT | `3763264f6b73151db08c50ff20d7d8a0b8796e021cdea7ceedad07b80155fa0e` |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | `6ce2be8dc25455e1f91df71bfa12ad37d7af1092ae736f3a6cd0e37bc7810596` |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 | `a2eb9349b6444b326872e140eb1cf5e7c522154d69e7a0ffb0fb81c06b37543f` |
| strict-num | 0.1.1 | MIT | `6637bab7722d379c8b41ba849228d680cc12d0a45ba1fa2b48f2a30577a06731` |
| subtle | 2.6.1 | BSD-3-Clause | `13c2bddecc57b384dee18652358fb23172facb8a2c51ccc10d74c157bdea3292` |
| syn | 2.0.117 | MIT OR Apache-2.0 | `e665b8803e7b1d2a727f4023456bbbbe74da67099c585258af0ad9c5013b9b99` |
| synstructure | 0.13.2 | MIT | `728a70f3dbaf5bab7f0c4b1ac8d7ae5ea60a4b5549c8a5914361c99147a709d2` |
| tap | 1.0.1 | MIT | `55937e1799185b12863d447f42597ed69d9928686b8d88a1df17376a097d8369` |
| tar | 0.4.46 | MIT OR Apache-2.0 | `3f6221d9a6003c78398e3b239969f352578258df48c8eb051caadae0015bc840` |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | `32497e9a4c7b38532efcdebeef879707aa9f794296a4f0244f6f69e9bc8574bd` |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 | `4fee6c4efc90059e10f81e6d42c60a18f76588c3d74cb83a0b242a2b6c7504c1` |
| thiserror-impl | 2.0.18 | MIT OR Apache-2.0 | `ebc4ee7f67670e9b64d05fa4253e753e016c6c95ff35b89b7941d6b856dec1d5` |
| thiserror | 1.0.69 | MIT OR Apache-2.0 | `b6aaf5339b578ea85b50e080feb250a3e8ae8cfcdff9a461c9ec2904bc923f52` |
| thiserror | 2.0.18 | MIT OR Apache-2.0 | `4288b5bcbc7920c07a1149a35cf9590a2aa808e0bc1eafaade0b80947865fbc4` |
| thread_local | 1.1.9 | MIT OR Apache-2.0 | `f60246a4944f24f6e018aa17cdeffb7818b76356965d03b07d6a9886e8962185` |
| tiny-skia-path | 0.11.4 | BSD-3-Clause | `9c9e7fc0c2e86a30b117d0462aa261b72b7a99b7ebd7deb3a14ceda95c5bdc93` |
| tiny-skia | 0.11.4 | BSD-3-Clause | `83d13394d44dae3207b52a326c0c85a8bf87f1541f23b0d143811088497b09ab` |
| tinystr | 0.8.3 | Unicode-3.0 | `c8323304221c2a851516f22236c5722a72eaa19749016521d6dff0824447d96d` |
| tokio-macros | 2.7.0 | MIT | `385a6cb71ab9ab790c5fe8d67f1645e6c450a7ce006a33de03daa956cf70a496` |
| tokio-tungstenite | 0.24.0 | MIT | `edc5f74e248dc973e0dbb7b74c7e0d6fcc301c694ff50049504004ef4d0cdcd9` |
| tokio | 1.52.1 | MIT | `b67dee974fe86fd92cc45b7a95fdd2f99a36a6d7b0d431a231178d3d670bbcc6` |
| toml_datetime | 0.7.5+spec-1.1.0 | MIT OR Apache-2.0 | `92e1cfed4a3038bc5a127e35a2d360f145e1f4b971b551a2ba5fd7aedf7e1347` |
| toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | `3165f65f62e28e0115a00b2ebdd37eb6f3b641855f9d636d3cd4103767159ad7` |
| toml_edit | 0.25.12+spec-1.1.0 | MIT OR Apache-2.0 | `d2153edc6955a6c354fad8f5efd38b6a8769bdccf9fe50f8e1329f81b0baa5d7` |
| toml_parser | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | `a2abe9b86193656635d2411dc43050282ca48aa31c2451210f4202550afb7526` |
| toml_writer | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | `7d56353a2a665ad0f41a421187180aab746c8c325620617ad883a99a1cbe66d2` |
| toml | 0.9.12+spec-1.1.0 | MIT OR Apache-2.0 | `cf92845e79fc2e2def6a5d828f0801e29a2f8acc037becc5ab08595c7d5e9863` |
| tracing-attributes | 0.1.31 | MIT | `7490cfa5ec963746568740651ac6781f701c9c5ea257c58e057f3ba8cf69e8da` |
| tracing-core | 0.1.36 | MIT | `db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a` |
| tracing-log | 0.2.0 | MIT | `ee855f1f400bd0e5c02d150ae5de3840039a3f54b025156404e34c23c03f47c3` |
| tracing-subscriber | 0.3.23 | MIT | `cb7f578e5945fb242538965c2d0b04418d38ec25c79d160cd279bf0731c8d319` |
| tracing | 0.1.44 | MIT | `63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100` |
| tree_magic_mini | 3.2.2 | MIT | `b8765b90061cba6c22b5831f675da109ae5561588290f9fa2317adab2714d5a6` |
| ttf-parser | 0.21.1 | MIT OR Apache-2.0 | `2c591d83f69777866b9126b24c6dd9a18351f177e49d625920d19f989fd31cf8` |
| tungstenite | 0.24.0 | MIT OR Apache-2.0 | `18e5b8366ee7a95b16d32197d0b2604b43a0be89dc5fac9f8e96ccafbaedda8a` |
| typed-path | 0.12.3 | MIT OR Apache-2.0 | `8e28f89b80c87b8fb0cf04ab448d5dd0dd0ade2f8891bae878de66a75a28600e` |
| typenum | 1.20.0 | MIT OR Apache-2.0 | `40ce102ab67701b8526c123c1bab5cbe42d7040ccfd0f64af1a385808d2f43de` |
| unicode-general-category | 1.1.0 | Apache-2.0 | `0b993bddc193ae5bd0d623b49ec06ac3e9312875fdae725a975c51db1cc1677f` |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | `e6e4313cd5fcd3dad5cafa179702e2b244f760991f45397d14d4ebf38247da75` |
| uniffi_core | 0.31.0 | MPL-2.0 | `b0ef62e69762fbb9386dcb6c87cd3dd05d525fa8a3a579a290892e60ddbda47e` |
| uniffi_internal_macros | 0.31.0 | MPL-2.0 | `98f51ebca0d9a4b2aa6c644d5ede45c56f73906b96403c08a1985e75ccb64a01` |
| uniffi_macros | 0.31.0 | MPL-2.0 | `db9d12529f1223d014fd501e5f29ca0884d15d6ed5ddddd9f506e55350327dc3` |
| uniffi_meta | 0.31.0 | MPL-2.0 | `9df6d413db2827c68588f8149d30d49b71d540d46539e435b23a7f7dbd4d4f86` |
| uniffi_pipeline | 0.31.0 | MPL-2.0 | `a806dddc8208f22efd7e95a5cdf88ed43d0f3271e8f63b47e757a8bbdb43b63a` |
| uniffi | 0.31.0 | MPL-2.0 | `b8c6dec3fc6645f71a16a3fa9ff57991028153bd194ca97f4b55e610c73ce66a` |
| unsafe-libyaml | 0.2.11 | MIT | `673aac59facbab8a9007c7f6108d11f63b603f7cabff99fabf650fea5c32b861` |
| untrusted | 0.9.0 | ISC | `8ecb6da28b8a351d773b68d5825ac39017e680750f980f3a1a85cd8dd28a47c1` |
| ureq-proto | 0.6.0 | MIT OR Apache-2.0 | `e994ba84b0bd1b1b0cf92878b7ef898a5c1760108fe7b6010327e274917a808c` |
| ureq | 3.3.0 | MIT OR Apache-2.0 | `dea7109cdcd5864d4eeb1b58a1648dc9bf520360d7af16ec26d0a9354bafcfc0` |
| url | 2.5.8 | MIT OR Apache-2.0 | `ff67a8a4397373c3ef660812acab3268222035010ab8680ec4215f38ba3d0eed` |
| utf-8 | 0.7.6 | MIT OR Apache-2.0 | `09cc8ee72d2a9becf2f2febe0205bbed8fc6615b7cb429ad062dc7b7ddd036a9` |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | `b6c140620e7ffbb22c2dee59cafe6084a59b5ffc27a8859a5f0d494b5d52b6be` |
| utf8-zero | 0.8.1 | MIT OR Apache-2.0 | `b8c0a043c9540bae7c578c88f91dda8bd82e59ae27c21baca69c8b191aaf5a6e` |
| uuid-simd | 0.8.0 | MIT | `23b082222b4f6619906941c17eb2297fff4c2fb96cb60164170522942a200bd8` |
| uuid | 1.23.1 | Apache-2.0 OR MIT | `ddd74a9687298c6858e9b88ec8935ec45d22e8fd5e6394fa1bd4e99a87789c76` |
| version_check | 0.9.5 | MIT OR Apache-2.0 | `0b928f33d975fc6ad9f86c8f283853ad26bdd5b10b7f1542aa2fa15e2289105a` |
| vsimd | 0.8.0 | MIT | `5c3082ca00d5a5ef149bb8b555a72ae84c9c59f7250f013ac822ac2e49b19c64` |
| wayland-backend | 0.3.15 | MIT | `2857dd20b54e916ec7253b3d6b4d5c4d7d4ca2c33c2e11c6c76a99bd8744755d` |
| wayland-client | 0.31.14 | MIT | `645c7c96bb74690c3189b5c9cb4ca1627062bb23693a4fad9d8c3de958260144` |
| wayland-protocols-wlr | 0.3.12 | MIT | `eb04e52f7836d7c7976c78ca0250d61e33873c34156a2a1fc9474828ec268234` |
| wayland-protocols | 0.32.12 | MIT | `563a85523cade2429938e790815fd7319062103b9f4a2dc806e9b53b95982d8f` |
| wayland-scanner | 0.31.10 | MIT | `9c324a910fd86ebdc364a3e61ec1f11737d3b1d6c273c0239ee8ff4bc0d24b4a` |
| wayland-sys | 0.31.11 | MIT | `d8eab23fefc9e41f8e841df4a9c707e8a8c4ed26e944ef69297184de2785e3be` |
| webpki-roots | 1.0.7 | CDLA-Permissive-2.0 | `52f5ee44c96cf55f1b349600768e3ece3a8f26010c05265ab73f945bb1a2eb9d` |
| winnow | 0.7.15 | MIT | `df79d97927682d2fd8adb29682d1140b343be4ac0f08fd68b7765d9c059d3945` |
| winnow | 1.0.3 | MIT | `0592e1c9d151f854e6fd382574c3a0855250e1d9b2f99d9281c6e6391af352f1` |
| wl-clipboard-rs | 0.9.3 | MIT OR Apache-2.0 | `e9651471a32e87d96ef3a127715382b2d11cc7c8bb9822ded8a7cc94072eb0a3` |
| writeable | 0.6.3 | Unicode-3.0 | `1ffae5123b2d3fc086436f8834ae3ab053a283cfac8fe0a0b8eaae044768a4c4` |
| wyz | 0.5.1 | MIT | `05f360fc0b24296329c78fda852a1e9ae82de9cf7b27dae4b7f62f118f77b9ed` |
| x11 | 2.21.0 | MIT | `502da5464ccd04011667b11c435cb992822c2c0dbde1770c988480d312a0db2e` |
| x11rb-protocol | 0.13.2 | MIT OR Apache-2.0 | `ea6fc2961e4ef194dcbfe56bb845534d0dc8098940c7e5c012a258bfec6701bd` |
| x11rb | 0.13.2 | MIT OR Apache-2.0 | `9993aa5be5a26815fe2c3eacfc1fde061fc1a1f094bf1ad2a18bf9c495dd7414` |
| xkbcommon | 0.9.0 | MIT | `a7a974f48060a14e95705c01f24ad9c3345022f4d97441b8a36beb7ed5c4a02d` |
| xkeysym | 0.2.1 | MIT OR Apache-2.0 OR Zlib | `b9cc00251562a284751c9973bace760d86c0276c471b4be569fe6b068ee97a56` |
| yoke-derive | 0.8.2 | Unicode-3.0 | `de844c262c8848816172cef550288e7dc6c7b7814b4ee56b3e1553f275f1858e` |
| yoke | 0.8.2 | Unicode-3.0 | `abe8c5fda708d9ca3df187cae8bfb9ceda00dd96231bed36e445a1a48e66f9ca` |
| zbus_macros | 5.16.0 | MIT | `adf1bd45a81a103745b1757754762a26e8cd01e4532e4d6c8ec431624b80d1d6` |
| zbus_names | 4.3.2 | MIT | `7074f3e50b894eac91750142016d30d0a89be8e67dbfd9704fb875825760e52d` |
| zbus_xml | 5.1.1 | MIT | `a8067892e940ed1727dea64690378601603b31d62dfde019a5335fbb7c0e0ed9` |
| zbus-lockstep-macros | 0.5.2 | MIT | `10da05367f3a7b7553c8cdf8fa91aee6b64afebe32b51c95177957efc47ca3a0` |
| zbus-lockstep | 0.5.2 | MIT | `6998de05217a084b7578728a9443d04ea4cd80f2a0839b8d78770b76ccd45863` |
| zbus | 5.16.0 | MIT | `eee682d202a77e4a9f3b2c2bdf48a7b28af5c08c34ddf66f98c93e5e39464285` |
| zerocopy | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT | `eed437bf9d6692032087e337407a86f04cd8d6a16a37199ed57949d415bd68e9` |
| zerofrom-derive | 0.1.7 | Unicode-3.0 | `11532158c46691caf0f2593ea8358fed6bbf68a0315e80aae9bd41fbade684a1` |
| zerofrom | 0.1.8 | Unicode-3.0 | `0ec05a11813ea801ff6d75110ad09cd0824ddba17dfe17128ea0d5f68e6c5272` |
| zeroize | 1.8.2 | Apache-2.0 OR MIT | `b97154e67e32c85465826e8bcc1c59429aaaf107c1e4a9e53c8d8ccd5eff88d0` |
| zerotrie | 0.2.4 | Unicode-3.0 | `0f9152d31db0792fa83f70fb2f83148effb5c1f5b8c7686c3459e361d9bc20bf` |
| zerovec-derive | 0.11.3 | Unicode-3.0 | `625dc425cab0dca6dc3c3319506e6593dcb08a9f387ea3b284dbd52a92c40555` |
| zerovec | 0.11.6 | Unicode-3.0 | `90f911cbc359ab6af17377d242225f4d75119aec87ea711a880987b18cd7b239` |
| zip | 8.6.0 | MIT | `2d04a6b5381502aa6087c94c669499eb1602eb9c5e8198e534de571f7154809b` |
| zlib-rs | 0.6.6 | Zlib | `b142a20ec14a91d5bc708c1dc21b080c550113d8aa77afa29635673a65dd02c5` |
| zmij | 1.0.21 | MIT | `b8848ee67ecc8aedbaf3e4122217aff892639231befc6a1b58d29fff4c2cabaa` |
| zopfli | 0.8.3 | Apache-2.0 | `f05cd8797d63865425ff89b5c4a48804f35ba0ce8d125800027ad6017d2b5249` |
| zstd-safe | 7.2.4 | MIT OR Apache-2.0 | `8f49c4d5f0abb602a93fb8736af2a4f4dd9512e36f7f570d66e65ff867ed3b9d` |
| zstd-sys | 2.0.16+zstd.1.5.7 | MIT OR Apache-2.0 | `91e19ebc2adc8f83e43039e79776e3fda8ca919132d68a1fed6a5faca2683748` |
| zstd | 0.13.3 | MIT | `e91ee311a569c327171651566e07972200e76fcfe2242a4fa446149a3881c08a` |
| zune-core | 0.5.1 | MIT OR Apache-2.0 OR Zlib | `cb8a0807f7c01457d0379ba880ba6322660448ddebc890ce29bb64da71fb40f9` |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | `27bc9d5b815bc103f142aa054f561d9187d191692ec7c2d1e2b4737f8dbd7296` |
| zvariant_derive | 5.12.0 | MIT | `90bc6cde9c01c511074be97f7ccb6c19d0da89e3f8662e812e999dcfd4638737` |
| zvariant_utils | 3.4.0 | MIT | `1e8535915cfa75547e559d8c68e8139909a4aeee076831e4ef7fc59d8172c4d6` |
| zvariant | 5.12.0 | MIT | `a192a0bde63360d77a7523c833d4b4ce6070a927e2c53246e4c540b1a3e27be0` |

### Embedded non-Cargo asset

| Component | Version | License | Embedded file SHA-256 | Source |
|---|---:|---|---|---|
| Inter | 4.001 | OFL-1.1 | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` | [Inter commit 66647c0bb](https://github.com/rsms/inter/commit/66647c0bbbe41a850d79d9c76fb13add3378940f) |
