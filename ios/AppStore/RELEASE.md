# TestFlight and App Store release

The app is native Swift and uses XcodeGen; EAS commands do not apply.

## One-time Apple setup

1. Enrol in the Apple Developer Program.
2. Register the bundle ID `com.openmausbot.companion` (or change it in `project.yml` before the first upload).
3. Create the matching app in App Store Connect with the name **OpenMaus Mobile**, primary category **Productivity**, and a unique SKU.
4. Create or select an Apple Distribution certificate and App Store provisioning profile.
5. Add the review contact details in App Store Connect; do not commit private contact data or App Store Connect keys.

## Before every upload

1. Run `swift test` from `ios/` and the repository test suite.
2. Generate the Xcode project with `xcodegen generate` from `ios/`.
3. Set `DEVELOPMENT_TEAM` for the Release configuration in Xcode or on the archive command line.
4. Increment `CURRENT_PROJECT_VERSION` for every upload. Update `MARKETING_VERSION` only for a new App Store version.
5. Archive a generic iOS device build and validate it in Xcode Organizer.
6. Upload to App Store Connect and distribute to internal TestFlight testers first.
7. Complete a real-iPhone pass for pairing, Bonjour permission, Keychain restore, Tailscale, approvals, background/foreground reconciliation, and transcript sharing.
8. After internal testing, submit to an external TestFlight group before App Review.

## App Store Connect

- Copy the localized text from `en-US/`.
- Use `privacy-answers.md` and verify it still matches the binary.
- Use `review-notes.md`, adding a real review contact in App Store Connect.
- Support URL: `https://github.com/milind-soni/OpenMausBot/issues`
- Privacy policy URL: `https://github.com/milind-soni/OpenMausBot/blob/main/docs/ios-privacy.md`
- Choose manual release for 1.0; enable a phased release after the first production build is stable.

The unsigned simulator CI proves compilation, not distribution signing. A TestFlight upload cannot be automated until the Apple team, App Store Connect record, and protected signing/API-key secrets exist.
