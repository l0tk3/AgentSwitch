// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SecretGateUI",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure logic: models, CSV import, JSON bridge to the `secret-gate` CLI. Unit-tested.
        .target(name: "SecretGateCore"),
        // SwiftUI app. Run with `swift run SecretGateUI`.
        .executableTarget(name: "SecretGateUI", dependencies: ["SecretGateCore"]),
        .testTarget(name: "SecretGateCoreTests", dependencies: ["SecretGateCore"]),
    ]
)
