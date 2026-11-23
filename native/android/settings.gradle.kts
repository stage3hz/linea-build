pluginManagement {
    repositories {
        google()
        // Google's own copy of the same public library store: the main host turns CI machines away (429) at busy
        // hours. On CI only, so a developer's offline cache (kept per host) stays valid.
        if (System.getenv("CI") != null) maven { url = uri("https://maven-central.storage-download.googleapis.com/maven2/") }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Google's own copy of the same public library store: the main host turns CI machines away (429) at busy
        // hours. On CI only, so a developer's offline cache (kept per host) stays valid.
        if (System.getenv("CI") != null) maven { url = uri("https://maven-central.storage-download.googleapis.com/maven2/") }
        mavenCentral()
    }
}

rootProject.name = "invizent-android"
include(":core", ":app")
