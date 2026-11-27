import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// The release key, where there is one (README, "Signing"): `keystore.properties` beside `settings.gradle.kts` — never
// checked in — or the same four values from the environment (a release job). Without either a release build is signed
// with the debug key of the machine, so that anyone can still build one.
val releaseKey: Map<String, String>? = run {
    val env = mapOf(
        "storeFile" to "AGENTSWITCH_ANDROID_KEYSTORE", "storePassword" to "AGENTSWITCH_ANDROID_KEYSTORE_PASSWORD",
        "keyAlias" to "AGENTSWITCH_ANDROID_KEY_ALIAS", "keyPassword" to "AGENTSWITCH_ANDROID_KEY_PASSWORD",
    )
    val file = rootProject.file("keystore.properties")
    val saved = if (file.isFile) Properties().apply { file.inputStream().use { load(it) } } else null
    val values = env.mapValues { (name, variable) -> (saved?.getProperty(name) ?: System.getenv(variable))?.trim().orEmpty() }
    if (values.values.all { it.isNotEmpty() }) values else null
}

android {
    namespace = "com.agentswitch.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.agentswitch.android"
        minSdk = 29
        targetSdk = 36
        versionCode = 7
        versionName = "1.0.0"
        // The libraries that carry machine code (the terminal emulator) for the phones there are —
        // 64-bit ARM — and for an emulator on an Intel machine; the 32-bit ones would only make the package larger.
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    signingConfigs {
        releaseKey?.let { key ->
            create("release") {
                storeFile = rootProject.file(key.getValue("storeFile"))
                storePassword = key.getValue("storePassword")
                keyAlias = key.getValue("keyAlias")
                keyPassword = key.getValue("keyPassword")
            }
        }
    }

    // Termux's own native library opens a local shell, which this app never does (a terminal here is the Mac's, its
    // screen alone is drawn): left out. It is also the one library built for 4 KB pages, which Android 15 and later
    // warn about and a phone with 16 KB pages cannot load.
    packaging {
        jniLibs { excludes += "**/libtermux.so" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all { it.useJUnitPlatform() }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    implementation(project(":kit"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)
    // A terminal's screen (docs/terminal-v0.md §0: not a terminal core of our own): Termux's emulator and renderer.
    implementation(libs.termux.terminal.view)
    // The QR scanner of the pairing flow: the camera through CameraX, the code read by ZXing (no Google Play services).
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)
    // The home screen's Channels widget (docs/app-v0.md §6) and its refresh while the app is away.
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.work.runtime)

    testImplementation(kotlin("test-junit5"))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
