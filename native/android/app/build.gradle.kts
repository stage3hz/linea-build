plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The request-signing key of this build: -PattestKey=… or INVIZENT_ATTEST_KEY, from the release workflow's secret.
// Without one signing is off. A value that is not a key stops the build (its text is never shown).
val attestKey = ((findProperty("attestKey") as String?) ?: System.getenv("INVIZENT_ATTEST_KEY") ?: "").trim()
if (attestKey.isNotEmpty() && !Regex("[A-Za-z0-9+/=_-]{16,200}").matches(attestKey)) throw GradleException("INVIZENT_ATTEST_KEY is not a request-signing key (16–200 characters of base64).")

android {
    namespace = "com.linea.messenger"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.linea.messenger"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.17.0"
        // The two the core is built for (build-core.sh): phones, and the emulator. A library that comes with
        // more (SQLCipher) is packed for these only, so the app is never installed where its core is missing.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        // The per-build key that signs state-changing requests (net/AttestKey.kt). Empty unless the build is
        // given one; never committed, never printed.
        buildConfigField("String", "ATTEST_KEY", "\"$attestKey\"")
    }

    buildFeatures { buildConfig = true }

    // A release build for trying on a phone beside the current app (workflow native-android-apk.yml): its own
    // identifier suffix (-PtestSuffix=.native) and a signing key made for that one build (-PtestKeystore=…,
    // password in INVIZENT_TEST_KEYSTORE_PASSWORD). The real release key is never in this repository.
    val testKeystore = (findProperty("testKeystore") as String?)?.takeIf { it.isNotBlank() }
    if (testKeystore != null) {
        signingConfigs {
            create("test") {
                storeFile = file(testKeystore)
                storePassword = System.getenv("INVIZENT_TEST_KEYSTORE_PASSWORD") ?: ""
                keyAlias = "test"
                keyPassword = System.getenv("INVIZENT_TEST_KEYSTORE_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        debug {
            // Installs beside the release app, as the preview build of the previous app did.
            applicationIdSuffix = ".preview"
        }
        release {
            isMinifyEnabled = false
            (findProperty("testSuffix") as String?)?.takeIf { it.isNotBlank() }?.let { applicationIdSuffix = it }
            if (testKeystore != null) signingConfig = signingConfigs.getByName("test")
        }
    }

    testOptions {
        // The page tests (PagesTest) build the real screens on the JVM: they need the manifest and the resources.
        unitTests.isIncludeAndroidResources = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
        targetCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(libs.versions.jvm.get()))
    }
}

// The emulator check of CI runs a test server on the build machine, behind HTTPS with a certificate authority
// made for that one run. A debug build made with INVIZENT_TEST_CA (or -PtestCa) pointing at that authority's
// certificate trusts it — for https://10.0.2.2 (the emulator's name for the build machine) and localhost only;
// every other address keeps the system's authorities alone. Without the variable a debug build trusts nothing
// extra, and a release build never has this configuration at all (it is added to the debug variant only; the
// manifest attribute that names it is in src/debug).
abstract class TestCaConfig : DefaultTask() {
    @get:InputFiles @get:Optional @get:PathSensitive(PathSensitivity.NONE) abstract val authority: ConfigurableFileCollection
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction fun write() {
        val folder = out.get().asFile
        folder.deleteRecursively()
        val certificate = authority.files.firstOrNull { it.isFile }
        val trust = if (certificate == null) "    <base-config cleartextTrafficPermitted=\"false\" />" else {
            File(folder, "raw").mkdirs()
            certificate.copyTo(File(folder, "raw/invizent_test_ca.pem"))
            """    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="false">10.0.2.2</domain>
        <domain includeSubdomains="false">localhost</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/invizent_test_ca" />
        </trust-anchors>
    </domain-config>"""
        }
        File(folder, "xml").mkdirs()
        File(folder, "xml/network_security_config.xml").writeText("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Written by the build (app/build.gradle.kts, TestCaConfig); debug builds only. -->\n<network-security-config>\n$trust\n</network-security-config>\n")
    }
}

val testCa = (findProperty("testCa") as String?) ?: System.getenv("INVIZENT_TEST_CA")
val testCaConfig = tasks.register<TestCaConfig>("debugTestCaConfig") {
    if (!testCa.isNullOrBlank()) authority.from(testCa)
}
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(testCaConfig, TestCaConfig::out)
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.okhttp)
    implementation(libs.sqlcipher)
    implementation(libs.androidx.sqlite)
    // Calls: the media of a call (calls/CallMedia.kt is the only file that knows it).
    implementation(libs.webrtc)
    // Avatars: the animated emoji (avatars/AnimatedEmoji.kt is the only file that knows it).
    implementation(libs.lottie)
    // Media: the round video with both cameras at once (video/NoteDualCamera.kt is the only file that knows it).
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    // Media: «Фон» of the photo editor (attachments/PhotoBackground.kt is the only file that knows it).
    implementation(libs.mlkit.subject)
    implementation(libs.play.services.base)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
}

tasks.withType<Test>().configureEach {
    testLogging { events("failed") }
    // The core built for this machine (build-core-host.sh), when it is there: CoreJniTest then calls it for real.
    val hostCore = layout.buildDirectory.dir("host-core").get().asFile
    inputs.dir(hostCore).optional().withPropertyName("hostCore")
    if (hostCore.isDirectory) systemProperty("java.library.path", hostCore.absolutePath)
}
