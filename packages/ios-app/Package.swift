// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentSwitchKit",
    // macOS only so `swift test` runs on the Mac; the app itself is iOS 17+.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AgentSwitchKit", targets: ["AgentSwitchKit"]),
        // What the Live Activity shows; no dependencies, so the widget extension links only this.
        .library(name: "AgentSwitchLive", targets: ["AgentSwitchLive"]),
        // The Live Activity's SwiftUI views: the widget extension places them; the Mac renders them in tests.
        .library(name: "AgentSwitchLiveUI", targets: ["AgentSwitchLiveUI"]),
    ],
    dependencies: [
        // libsodium with a prebuilt xcframework (iOS, simulator, macOS): crypto_box_seal for enc:v1: tokens.
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.11.0"),
    ],
    targets: [
        // Pure logic: pairing links, API models and client, SSE, endpoint selection, token minting. Unit-tested.
        .target(name: "AgentSwitchLive"),
        .target(name: "AgentSwitchLiveUI", dependencies: ["AgentSwitchLive"]),
        .target(
            name: "AgentSwitchKit",
            dependencies: ["AgentSwitchLive", .product(name: "Sodium", package: "swift-sodium")]
        ),
        .testTarget(
            name: "AgentSwitchKitTests",
            dependencies: ["AgentSwitchKit", "AgentSwitchLive", "AgentSwitchLiveUI", .product(name: "Sodium", package: "swift-sodium")],
            resources: [.copy("Fixtures")]
        ),
    ]
)
