// The Android phone app (docs/app-v0.md §5b): `kit` is the logic with no Android in it, tested on the build machine;
// `app` is the Compose interface.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Termux's terminal emulator and its renderer (Apache 2.0), the one thing taken from here.
        maven("https://jitpack.io") {
            content { includeGroup("com.github.termux.termux-app") }
        }
    }
}

rootProject.name = "AgentSwitch"
include(":kit", ":app")
