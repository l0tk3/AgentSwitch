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
    targets: [
        // Pure logic: pairing links, API models and client, SSE, endpoint selection. Unit-tested.
        .target(name: "AgentSwitchLive"),
        .target(name: "AgentSwitchLiveUI", dependencies: ["AgentSwitchLive"]),
        .target(name: "AgentSwitchKit", dependencies: ["AgentSwitchLive"]),
        .testTarget(
            name: "AgentSwitchKitTests",
            dependencies: ["AgentSwitchKit", "AgentSwitchLive", "AgentSwitchLiveUI"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
