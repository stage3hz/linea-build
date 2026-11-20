plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // Bytecode the Android toolchain of the app module accepts.
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(libs.versions.jvm.get()))
        allWarningsAsErrors.set(true)
    }
}

java {
    sourceCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
    targetCompatibility = JavaVersion.toVersion(libs.versions.jvm.get())
}

dependencies {
    api(libs.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test.junit)
}

tasks.test {
    useJUnit()
    testLogging { events("failed") }
}
