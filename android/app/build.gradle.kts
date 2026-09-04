import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("plugin.compose")
    kotlin("plugin.serialization")
}

// The release signing key belongs to the maintainer and never enters this
// repository. It reaches a build from one of two places outside version
// control:
//
//   * `android/keystore.properties` — gitignored, for signing by hand. Four
//     keys: `storeFile` (a path, absolute or relative to `android/`),
//     `storePassword`, `keyAlias`, and optionally `keyPassword`.
//   * the environment — for CI, where the material arrives as secrets:
//     OPENMAUSBOT_KEYSTORE_FILE, OPENMAUSBOT_KEYSTORE_PASSWORD,
//     OPENMAUSBOT_KEY_ALIAS, and optionally OPENMAUSBOT_KEY_PASSWORD.
//
// The environment wins over the file, so a runner cannot silently inherit a
// stale `keystore.properties` left behind in a cached workspace.
//
// When none of it is present the release build is unsigned, and that is a
// supported outcome rather than a degraded one: `assembleRelease` writes
// `app-release-unsigned.apk` for the maintainer to sign with his own key on his
// own machine. A signed build writes `app-release.apk` instead, so the filename
// alone says which of the two happened.
private val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use(::load)
}

private fun signingMaterial(property: String, environment: String): String? =
    (System.getenv(environment) ?: keystoreProperties.getProperty(property))
        ?.takeIf(String::isNotBlank)

private val storeFilePath = signingMaterial("storeFile", "OPENMAUSBOT_KEYSTORE_FILE")
private val storePasswordValue = signingMaterial("storePassword", "OPENMAUSBOT_KEYSTORE_PASSWORD")
private val keyAliasValue = signingMaterial("keyAlias", "OPENMAUSBOT_KEY_ALIAS")
// A PKCS12 keystore — keytool's default since JDK 9, and what `-storetype PKCS12`
// produces — holds one password for the store and the key alike, so the key
// password may be left out rather than repeated.
private val keyPasswordValue =
    signingMaterial("keyPassword", "OPENMAUSBOT_KEY_PASSWORD") ?: storePasswordValue

// All three required values, or none of them. A build handed some of them is a
// build somebody meant to sign, and answering that with an unsigned APK would
// hand back something that looks finished and cannot be published. It stops here
// instead, naming what is missing.
private val releaseSigningMaterial = mapOf(
    "storeFile / OPENMAUSBOT_KEYSTORE_FILE" to storeFilePath,
    "storePassword / OPENMAUSBOT_KEYSTORE_PASSWORD" to storePasswordValue,
    "keyAlias / OPENMAUSBOT_KEY_ALIAS" to keyAliasValue,
)
private val releaseKeystore: java.io.File? = when {
    releaseSigningMaterial.values.all { it == null } -> null
    releaseSigningMaterial.values.any { it == null } -> error(
        releaseSigningMaterial.filterValues { it == null }.keys.joinToString(
            prefix = "Release signing is half-configured. Missing: ",
            separator = ", ",
            postfix = ". Supply all of it, or none of it for an unsigned build.",
        )
    )
    else -> rootProject.file(storeFilePath!!).also {
        if (!it.isFile) error("Release keystore not found at ${it.absolutePath}.")
    }
}

// The one line to edit at a release. `versionCode` is derived from it below, so
// there is no second number to bump and no way to build a new version under a
// code the Play Store has already accepted.
private val appVersionName = "1.2.0"

// Play orders uploads by `versionCode` alone and refuses one it has already
// seen, so the code has to rise whenever the name does — and rise in the
// direction a human reads the name. MAJOR * 10000 + MINOR * 100 + PATCH does
// that for any `X.Y.Z` with each part in 0..99: 1.0.0 is 10000, 1.0.1 is 10001,
// 1.2.0 is 10200, 2.0.0 is 20000. A name outside that shape fails the build
// rather than resolving to some number nobody chose.
//
// Nothing has shipped under `versionCode = 1`, so opening at 10000 costs
// nothing; it could not be undone later, because an installer refuses to
// replace an app with a lower code and Play refuses the upload outright.
private val appVersionCode = run {
    val parts = appVersionName.split(".").map { it.toIntOrNull() ?: -1 }
    check(parts.size == 3 && parts.all { it in 0..99 }) {
        "versionName must be MAJOR.MINOR.PATCH with each part in 0..99 for a " +
            "versionCode to be derived from it; got \"$appVersionName\"."
    }
    parts[0] * 10_000 + parts[1] * 100 + parts[2]
}

android {
    namespace = "com.openmausbot.companion"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.openmausbot.companion"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        // Created only when the material above resolved. Absent otherwise, which
        // is what leaves `release` unsigned.
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
                // v2 covers every device this app runs on (minSdk 26), and v3
                // is what makes the key rotatable later — without a v3 block in
                // the APK there is no signing lineage for a new key to prove it
                // descends from the old one. AGP leaves v3 off by default;
                // `apksigner sign` turns it on by default, so setting it here is
                // what keeps a Gradle-signed release byte-for-byte comparable to
                // one the maintainer signs by hand. v1 stays off: it is JAR
                // signing, for Android 6 and below, which minSdk already excludes.
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            // Null whenever no signing material was supplied — the unsigned
            // handover build — and the "release" config whenever it was.
            signingConfig = signingConfigs.findByName("release")

            // R8 is off deliberately, and this line says so rather than letting
            // the default imply it.
            //
            // `:core` carries 66 `@Serializable` classes, and
            // kotlinx.serialization reaches their generated serializers
            // reflectively: `Foo.Companion.serializer()`, looked up by name at
            // the moment a frame is decoded. R8 sees no call site for those
            // companions and no reference to the field names its descriptors
            // carry, so without keep rules it renames and strips them. What
            // comes out builds, installs, opens — and then fails the first time
            // the phone talks to the computer, as a SerializationException on a
            // frame off the socket, in release only, with a stack trace made of
            // one-letter class names.
            //
            // Turning it on means writing and *testing* keep rules: the
            // serializable surface in `:core` and `:app`, ML Kit's native
            // barcode entry points, and Tink under androidx.security.crypto.
            // Testing them means installing the minified APK and driving a real
            // pairing and a real session against a real computer. None of that
            // failure mode shows up in a unit test, and a minified APK that
            // launches proves nothing. Until someone does that work, `false` is
            // the tested state and ~34 MB is its price.
            isMinifyEnabled = false
            // Resource shrinking is R8's, and AGP rejects the build if it is
            // turned on while the line above is false.
            isShrinkResources = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged manifest and the compiled resources
            // to stand a real Android runtime up inside the JVM suite. Only the
            // handful of tests that mount a composition ask for it; the rest of
            // the suite never loads Robolectric at all.
            isIncludeAndroidResources = true
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    // Part of Compose, version-managed by the BOM above: the ~40 icons in the
    // core set cover all but one glyph these screens draw, and that one — the
    // display in the chat header — is a vector in `res/drawable`. The
    // `-extended` artifact is deliberately not used: it is thousands of vectors
    // for a handful of uses.
    implementation("androidx.compose.material:material-icons-core")
    // Already on the classpath through material3; declared because the chat's +
    // sheet and the composer's + use `AnimatedVisibility` and `animateFloatAsState`
    // directly, and a direct use deserves a direct dependency.
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-process:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("androidx.security:security-crypto:1.1.0-alpha07")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.core:core-ktx:1.17.0")
    // Share inbound: apply EXIF orientation while downsampling shared photos.
    implementation("androidx.exifinterface:exifinterface:1.3.7")

    // Chrome Custom Tabs, for the cloud desktop's noVNC viewer — the Android
    // counterpart of the SFSafariViewController iOS uses. A hardened browser
    // process with its own visible origin, cookie jar and WebSocket support,
    // rather than a WebView that would put the provider's session inside this
    // process and hide the origin from someone about to grant full control of a
    // cloud machine. ~200 KB, no transitive weight beyond androidx.core.
    implementation("androidx.browser:browser:1.9.0")

    // Pairing QR scanner. CameraX gives the preview and frame pipeline; ML Kit's
    // *bundled* barcode model reads them. Bundled rather than the Play-services
    // variants (`play-services-code-scanner` / unbundled ML Kit) because pairing
    // happens on a LAN, often on a phone whose Google Play services cannot be
    // assumed — a scanner that needs a module download at the moment a two-minute
    // pairing window is open is a scanner that fails when it matters. It also
    // keeps the confirm-before-pair step in this process, where the app can show
    // the computer's name and address before anything is redeemed (§6).
    // Cost, measured on this APK: libbarhopper_v3.so is 4.95 MB per ABI plus
    // 0.88 MB of model assets — call it 6 MB on a device, since an app bundle
    // ships one ABI. That is the price of scanning without Play services; the
    // lever if it ever matters is `play-services-mlkit-barcode-scanning`, which
    // is a few hundred KB and downloads the model on demand. Scanning is
    // restricted to FORMAT_QR_CODE.
    implementation("androidx.camera:camera-core:1.5.0")
    implementation("androidx.camera:camera-camera2:1.5.0")
    implementation("androidx.camera:camera-lifecycle:1.5.0")
    implementation("androidx.camera:camera-view:1.5.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.2.21")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("junit:junit:4.13.2")
    // The approval card's two buttons are only correct in what they put on the
    // wire — one standing grant, one answer, never two grants — so the test that
    // pins them drives a real Session against a real socket rather than a stub
    // that could agree with the wrong thing. Same server the :core tests use.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // The table card is only correct in the *order* a screen reader walks it,
    // and that order lives in the semantics tree — not in any value a pure
    // function could return. Robolectric stands the Android runtime up in the
    // JVM suite so `createComposeRule` can mount the card and the test can read
    // the tree it actually produces; without it the assertion would be about a
    // list the composable is free to ignore.
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation(composeBom)
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
