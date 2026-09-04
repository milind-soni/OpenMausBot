# TestFlight and App Store release

The app is native Swift and uses XcodeGen; EAS commands do not apply.

## One-time Apple setup

1. Enrol in the Apple Developer Program.
2. Register the bundle IDs `com.openmausbot.app`, `com.openmausbot.app.widgets`, and `com.openmausbot.app.share` (or change them in `project.yml` before the first upload).
3. Register the App Group `group.com.openmausbot.shared`. Enable App Groups and Keychain Sharing for the app and Share extension identifiers, then add the group to both. Keep the app's legacy `$(AppIdentifierPrefix)com.openmausbot.app` Keychain group during upgrades so existing pairings can migrate safely.
4. Create the matching app in App Store Connect with the name **OpenMaus Mobile**, primary category **Productivity**, and a unique SKU.
5. Create or select Apple Distribution certificates and App Store provisioning profiles for the containing app and both extensions.
6. Add the review contact details in App Store Connect; do not commit private contact data or App Store Connect keys.

## Before every upload

1. Run `swift test` from `ios/` and the repository test suite.
2. Generate the Xcode project with `xcodegen generate` from `ios/`.
3. Set `DEVELOPMENT_TEAM` for the Release configuration in Xcode or on the archive command line.
4. Increment `CURRENT_PROJECT_VERSION` for every upload. Update `MARKETING_VERSION` only for a new App Store version.
5. Archive a generic iOS device build and validate it in Xcode Organizer.
6. Upload to App Store Connect and distribute to internal TestFlight testers first.
7. Complete a real-iPhone pass for pairing, Bonjour permission, Keychain restore and upgrade migration, Tailscale, optional hosted HTTPS, approvals, secure credential entry through Apple Passwords and by paste, background/foreground reconciliation, sign-out/revocation, transcript sharing, and Share-sheet delivery of text, a link, an image, and a document. Repeat Share-sheet delivery after force-quitting the containing app.
8. After internal testing, submit to an external TestFlight group before App Review.

## App Store Connect

- Copy the localized text from `en-US/`.
- Use `privacy-answers.md` and verify it still matches the binary.
- Use `review-notes.md`, adding a real review contact in App Store Connect.
- Support URL: `https://github.com/milind-soni/OpenMausBot/issues`
- Privacy policy URL: `https://github.com/milind-soni/OpenMausBot/blob/main/docs/ios-privacy.md`
- Choose manual release for 1.0; enable a phased release after the first production build is stable.

The unsigned simulator CI proves compilation, not distribution signing. A TestFlight upload cannot be automated until the Apple team, App Store Connect record, and protected signing/API-key secrets exist.
