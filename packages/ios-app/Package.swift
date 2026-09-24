// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentSwitchKit",
    // macOS only so `swift test` runs on the Mac; the app itself is iOS 17+.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "AgentSwitchKit", targets: ["AgentSwitchKit"]),
    ],
    dependencies: [
        // libsodium with a prebuilt xcframework (iOS, simulator, macOS): crypto_box_seal for enc:v1: tokens.
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.11.0"),
    ],
    targets: [
        // Pure logic: pairing links, API models and client, SSE, endpoint selection, token minting. Unit-tested.
        .target(
            name: "AgentSwitchKit",
            dependencies: [.product(name: "Sodium", package: "swift-sodium")]
        ),
        .testTarget(
            name: "AgentSwitchKitTests",
            dependencies: ["AgentSwitchKit", .product(name: "Sodium", package: "swift-sodium")],
            resources: [.copy("Fixtures")]
        ),
    ]
)
