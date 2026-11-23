plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// The request-signing key of this build: -PattestKey=… or INVIZENT_ATTEST_KEY, from the release workflow's secret.
// Without one signing is off. A value that is not a key stops the build (its text is never shown).
val attestKey = ((findProperty("attestKey") as String?) ?: System.getenv("INVIZENT_ATTEST_KEY") ?: "").trim()
if (attestKey.isNotEmpty() && !Regex("[A-Za-z0-9+/=_-]{16,200}").matches(attestKey)) throw GradleException("INVIZENT_ATTEST_KEY is not a request-signing key (16–200 characters of base64).")

// The previous app's identifier as it is on the owner's phone: the PREVIEW build (mobile/app.config.js — APP_ENV other
// than production gives com.linea.messenger.preview; android-apk.yml builds it so). The same identifier, signed with the
// same key, is what makes this app an UPDATE of that one: the same private files (files/SQLite, the SecureStore
// preferences) and the same keystore keys (the session, the storage keys, the device key). The Kotlin package stays
// com.linea.messenger (the namespace below).
val appId = "com.linea.messenger.preview"
// Every build must install OVER the one before it: the version code grows with every CI build (-PversionCode, the run
// number plus an offset) and is always above the previous app's last one (47, mobile/app.config.js `versionCode`).
val previousAppVersionCode = 47
val appVersionCode = ((findProperty("versionCode") as String?) ?: System.getenv("INVIZENT_VERSION_CODE") ?: "1000").trim().toInt()
if (appVersionCode <= previousAppVersionCode) throw GradleException("versionCode $appVersionCode must be above the previous app's $previousAppVersionCode, or the phone refuses the update.")

android {
    namespace = "com.linea.messenger"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = appId
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = appVersionCode
        versionName = "0.17.0"
        // The two the core is built for (build-core.sh): phones, and the emulator. A library that comes with
        // more (SQLCipher) is packed for these only, so the app is never installed where its core is missing.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        // The per-build key that signs state-changing requests (net/AttestKey.kt). Empty unless the build is
        // given one; never committed, never printed.
        buildConfigField("String", "ATTEST_KEY", "\"$attestKey\"")
    }

    buildFeatures { buildConfig = true }

    // The release build's signing key (workflow native-android-apk.yml): -PreleaseKeystore=<file>, the passwords and
    // the alias in INVIZENT_KEYSTORE_PASSWORD / INVIZENT_KEY_ALIAS / INVIZENT_KEY_PASSWORD — the owner's keystore from
    // the repository's secrets (the key the previous app's APK is signed with, android-apk.yml), so the phone takes the
    // APK as an update. The key itself is never in this repository.
    val releaseKeystore = (findProperty("releaseKeystore") as String?)?.takeIf { it.isNotBlank() }
    if (releaseKeystore != null) {
        signingConfigs {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("INVIZENT_KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("INVIZENT_KEY_ALIAS") ?: ""
                keyPassword = System.getenv("INVIZENT_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    testOptions {
        // The page tests (PagesTest) build the real screens on the JVM: they need the manifest and the resources.
        unitTests.isIncludeAndroidResources = true
        // The whole suite (≈490 tests, most of them Robolectric pages) outgrew the test JVM's default 512 MB: the
        // worker died with OutOfMemoryError part way and only the classes finished before it left results.
        unitTests.all {
            it.maxHeapSize = "2g"
            // The test runtime fetches its Android images itself: point it at the same copy of the library store.
            if (System.getenv("CI") != null) {
                it.systemProperty("robolectric.dependency.repo.url", "https://maven-central.storage-download.googleapis.com/maven2")
                it.systemProperty("robolectric.dependency.repo.id", "central-copy")
            }
        }
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

// Push: Firebase's settings for this app, from google-services.json — the file the previous app's build used
// (mobile/google-services.json, or the one CI is given: -PgoogleServices / INVIZENT_GOOGLE_SERVICES). The client
// whose package is this app's identifier is written as the string resources Firebase reads at start
// (FirebaseOptions.fromResource), as Google's own Gradle plugin would — without that plugin. A file without this
// identifier stops the build (the previous app's build stopped too); no file at all builds an app without push
// (it then says «Уведомления не настроены в этой сборке приложения.»).
abstract class GoogleServicesValues : DefaultTask() {
    @get:InputFiles @get:Optional @get:PathSensitive(PathSensitivity.NONE) abstract val source: ConfigurableFileCollection
    @get:Input abstract val packageName: Property<String>
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction fun write() {
        val folder = out.get().asFile
        folder.deleteRecursively()
        val file = source.files.firstOrNull { it.isFile }
        if (file == null) { logger.warn("google-services.json not found: this build has no push notifications."); return }
        @Suppress("UNCHECKED_CAST")
        val root = groovy.json.JsonSlurper().parse(file) as Map<String, Any?>
        val project = root["project_info"] as? Map<String, Any?> ?: emptyMap()
        @Suppress("UNCHECKED_CAST")
        val clients = root["client"] as? List<Map<String, Any?>> ?: emptyList()
        fun pkg(client: Map<String, Any?>) = ((client["client_info"] as? Map<*, *>)?.get("android_client_info") as? Map<*, *>)?.get("package_name") as? String
        val client = clients.firstOrNull { pkg(it) == packageName.get() }
            ?: throw GradleException("${file.name} has no Android app ${packageName.get()} (it has: ${clients.mapNotNull { pkg(it) }.joinToString()}). Register it in the Firebase project and update the file.")
        val sdkAppId = (client["client_info"] as? Map<*, *>)?.get("mobilesdk_app_id") as? String ?: throw GradleException("${file.name}: no mobilesdk_app_id")
        val apiKey = ((client["api_key"] as? List<*>)?.firstOrNull() as? Map<*, *>)?.get("current_key") as? String ?: ""
        val values = linkedMapOf(
            "google_app_id" to sdkAppId,
            "gcm_defaultSenderId" to (project["project_number"] as? String ?: ""),
            "google_api_key" to apiKey,
            "google_crash_reporting_api_key" to apiKey,
            "project_id" to (project["project_id"] as? String ?: ""),
            "google_storage_bucket" to (project["storage_bucket"] as? String ?: ""),
        ).filterValues { it.isNotEmpty() }
        fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace("'", "\\'").replace("\"", "\\\"")
        File(folder, "values").mkdirs()
        File(folder, "values/google_services.xml").writeText("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Written by the build (app/build.gradle.kts, GoogleServicesValues) from ${file.name}. -->\n<resources>\n" +
            values.entries.joinToString("") { "    <string name=\"${it.key}\" translatable=\"false\">${escape(it.value)}</string>\n" } + "</resources>\n")
    }
}

val googleServices = (findProperty("googleServices") as String?)?.takeIf { it.isNotBlank() }
    ?: System.getenv("INVIZENT_GOOGLE_SERVICES")?.takeIf { it.isNotBlank() }
    ?: rootProject.file("../../mobile/google-services.json").path
val googleServicesValues = tasks.register<GoogleServicesValues>("googleServicesValues") {
    source.from(googleServices)
    packageName.set(appId)
}

val testCa = (findProperty("testCa") as String?) ?: System.getenv("INVIZENT_TEST_CA")
val testCaConfig = tasks.register<TestCaConfig>("debugTestCaConfig") {
    if (!testCa.isNullOrBlank()) authority.from(testCa)
}
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(testCaConfig, TestCaConfig::out)
    }
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(googleServicesValues, GoogleServicesValues::out)
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
    // Security: the backup key's QR code, read with the camera after a tap (settings/HistorySettings.kt).
    implementation(libs.mlkit.barcode)
    implementation(libs.play.services.base)
    // Push: the token and the delivery of the server's notifications (push/ is the only package that knows it).
    implementation(libs.firebase.messaging)
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
