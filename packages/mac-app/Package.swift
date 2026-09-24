// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentSwitchMac",
    platforms: [.macOS(.v14)],
    products: [
        // Linked by the Xcode app target (project.yml) as a local package product.
        .library(name: "AgentSwitchMacCore", targets: ["AgentSwitchMacCore"]),
    ],
    targets: [
        // Pure logic: supervision state machine, paths, env, probes, daemon API client, parsers. Unit-tested.
        .target(name: "AgentSwitchMacCore"),
        // SwiftUI menu-bar app. `swift run AgentSwitchMac` for development; the shipped .app comes from project.yml.
        .executableTarget(name: "AgentSwitchMac", dependencies: ["AgentSwitchMacCore"]),
        .testTarget(name: "AgentSwitchMacCoreTests", dependencies: ["AgentSwitchMacCore"]),
    ]
)
