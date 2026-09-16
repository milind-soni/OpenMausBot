# Astra Android companion

The Android counterpart to the iOS companion app: pair a phone with a computer
running Astra, then read and answer from the phone.

- `applicationId` — `com.astra.companion`
- `minSdk` 26 (Android 8.0), `targetSdk` / `compileSdk` 37
- Deep-link scheme — `astra`
- Two modules: `:core` (protocol, ported from `ios/Sources/CompanionCore`) and
  `:app` (Compose UI, Android platform)

## Build and test

Requires **JDK 17** and an Android SDK. Gradle arrives through the wrapper, so
there is nothing to install for it.

```sh
cd android
./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug
```

That is the same command CI runs (`.github/workflows/ci.yml`). Gradle caches
aggressively — a suspiciously fast `BUILD SUCCESSFUL` usually means nothing ran.
Prefix `cleanTest` when a test count matters:

```sh
./gradlew cleanTest :core:test :app:testDebugUnitTest :app:assembleDebug
```

## Building a release APK

```sh
cd android
./gradlew :app:assembleRelease
```

With no signing material configured this writes an **unsigned** APK:

```
app/build/outputs/apk/release/app-release-unsigned.apk
```

That is a supported outcome, not a degraded one — it is the artifact to hand to
whoever holds the release key. The filename says which of the two happened: a
signed build writes `app-release.apk` instead.

The APK is already zip-aligned by the Android Gradle Plugin, and `apksigner`
preserves that alignment. **Do not run `zipalign` or `jarsigner`.**

## Signing it

The signing key belongs to the maintainer and never enters this repository.
`.gitignore` refuses `*.jks`, `*.keystore` and `*.p12` repo-wide, and
`android/keystore.properties` alongside them.

Create a key once, outside any clone of this repository:

```sh
keytool -genkeypair -v -keystore ~/astra-release.jks \
  -storetype PKCS12 -alias astra -keyalg RSA -keysize 4096 -validity 10000
```

Then, for each release:

```sh
# whichever build-tools version is installed; any recent one works
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/* | tail -1)/apksigner"

"$APKSIGNER" sign --ks ~/astra-release.jks --ks-key-alias astra \
  --out app-release.apk app-release-unsigned.apk

"$APKSIGNER" verify --verbose --print-certs app-release.apk
```

Without `--ks-pass`, `apksigner` prompts for the password, which keeps it out of
the shell history. `verify` should report `Verifies` along with v2 and v3
signature scheme lines.

Keep that keystore file and its passwords backed up. Google Play ties an app to
the key that first signed it; losing it means the listing cannot be updated.

### Signing from Gradle instead

To have `assembleRelease` produce a signed APK directly, supply the key material
one of two ways. The environment wins over the file, so a CI runner cannot
silently inherit a stale `keystore.properties` from a cached workspace.

`android/keystore.properties` (gitignored):

```properties
storeFile=/absolute/path/to/astra-release.jks
storePassword=…
keyAlias=astra
keyPassword=…
```

or the environment, for CI secrets:

```
ASTRA_KEYSTORE_FILE
ASTRA_KEYSTORE_PASSWORD
ASTRA_KEY_ALIAS
ASTRA_KEY_PASSWORD   # optional; PKCS12 reuses the store password
```

Supply all of it or none of it. A build handed only part of the material stops
and names what is missing, rather than quietly producing an unsigned APK that
looks finished and cannot be published.

Both paths declare v2 and v3 signature schemes. v3 is what makes the key
rotatable later: without a v3 block there is no signing lineage for a new key to
prove it descends from the old one. v1 stays off — it is JAR signing, for
Android 6 and below, which `minSdk 26` already excludes.

## Versioning

There is one line to edit per release, in `app/build.gradle.kts`:

```kotlin
private val appVersionName = "1.0.0"
```

`versionCode` is derived from it as `MAJOR * 10000 + MINOR * 100 + PATCH`, so
`1.0.0` is `10000`, `1.0.1` is `10001`, `2.0.0` is `20000`. Each part must be in
`0..99`; a name outside `X.Y.Z` fails the build rather than resolving to a number
nobody chose. There is no second number to remember to bump.

Play orders uploads by `versionCode` alone and refuses one it has already
accepted, so the code has to rise whenever the name does.

## Why R8 is off

`isMinifyEnabled = false` is a decision, not an oversight, and
`app/build.gradle.kts` carries the full reasoning.

The short version: `:core` has 66 `@Serializable` classes, and
kotlinx.serialization reaches their generated serializers reflectively, by name,
at the moment a frame is decoded. R8 sees no call site for those companions and
strips or renames them. The result builds, installs and opens — then fails the
first time the phone talks to the computer, in release only, as a
`SerializationException` with a stack trace made of one-letter class names.

Turning it on means writing keep rules *and testing them* against a real pairing
and a real session, because no unit test reaches that failure mode and a
minified APK that launches proves nothing. Until someone does that work, `false`
is the tested state, and roughly 34 MB is its price.
