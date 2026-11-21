plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.linea.messenger"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.linea.messenger"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.16.3"
    }

    buildTypes {
        debug {
            // Installs beside the release app, as the preview build of the previous app did.
            applicationIdSuffix = ".preview"
        }
        release {
            isMinifyEnabled = false
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

dependencies {
    implementation(project(":core"))
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
}

tasks.withType<Test>().configureEach {
    testLogging { events("failed") }
}
