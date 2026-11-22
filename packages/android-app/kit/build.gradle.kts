// The logic of the phone app with no Android in it (the iPhone's AgentSwitchKit, in Kotlin): pairing links, the pinned
// connection, the Mac's API and its models, what the lists and records show. `./gradlew :kit:test` runs on the Mac.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(libs.okhttp)

    testImplementation(kotlin("test"))
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.tls)
    testImplementation(libs.okhttp.mockwebserver)
    // libsodium for the tests' BoxSealer (the app hands the kit its own); JNA loads the bundled native library.
    testImplementation(libs.lazysodium.java)
    testImplementation(libs.jna)
}

tasks.test {
    useJUnitPlatform()
}
