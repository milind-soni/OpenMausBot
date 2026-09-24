# MausBot Play release checklist

Use with the [release preparation guide](README.md). Complete this for the exact
commit and artifact being submitted; unchecked items remain release work.

## Build and verification

- [ ] Record the release commit and intended version from
  `android/app/build.gradle.kts`; confirm the version against Console uploads.
- [ ] Confirm Android branding is MausBot and desktop references are OpenMausBot.
- [ ] Confirm package `com.openmausbot.companion` and the release SDK settings.
- [ ] Have the release owner confirm signing configuration, certificate identity,
  key backups, and supported installation/upgrade paths.
- [ ] Configure signing securely and run `./gradlew :app:bundleRelease` from
  `android/` with JDK 17 and the Android SDK configured.
- [ ] Verify the signature of
  `android/app/build/outputs/bundle/release/app-release.aab`; record its hash,
  version, and certificate identity.
- [ ] Run the applicable [Android checks](../../docs/verification/android-threads.md)
  and manual release workflows using an isolated fixture and disposable emulator.
  Record results and gaps; do not use the user's live app or data.
- [ ] Test installation/upgrade and every advertised workflow on the release
  build, including the connection methods and device types being claimed.

## Listing and reviewer access

- [ ] Write the description and release notes from features verified in this
  release, including its OpenMausBot desktop dependency.
- [ ] Exclude unmerged call-mode and voice-key setup claims (#739/#1531).
- [ ] Review icon, feature graphic, and each selected screenshot against the
  release, with MausBot branding and no private data.
- [ ] Keep `assets/screenshots/03-call.png` excluded: it is unapproved and unusable
  until the actual release supports and verifies the depicted call feature.
- [ ] Check current Console asset requirements and use only reviewed images.
- [ ] Confirm support contacts, website, category, pricing, and distribution
  choices with the release owner.
- [ ] Prepare and test reviewer setup/access instructions, including the actual
  signup, authentication, desktop, and server-settings requirements.

## Declarations and submission

- [ ] Review current Console requirements for the account and release track.
- [ ] Complete content, age-rating, target-audience, ads, permission, and other
  applicable forms from the shipped behavior; this checklist supplies no answers.
- [ ] Review data flows across local connections, hosted access, model providers,
  speech recognition, attachments, identifiers, and enabled services before
  answering collection, sharing, retention, or deletion questions.
- [ ] Account for supported cleartext LAN HTTP when assessing transit encryption.
- [ ] Verify the privacy policy and any stated deletion process; confirm they
  match the release's actual behavior and deployed services.
- [ ] Compare Console-detected package/version and signing details with the
  recorded artifact, then resolve validation messages and required testing.
- [ ] Have the release owner select countries, track, rollout scope, and timing
  and review the complete submission before publishing.
- [ ] Preserve the submitted copy, declarations, artifact identity, and test
  evidence. Monitor review feedback and release health after submission.
