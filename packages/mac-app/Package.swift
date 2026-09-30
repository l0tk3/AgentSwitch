// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentSwitchMac",
    platforms: [.macOS(.v14)],
    products: [
        // Linked by the Xcode app target (project.yml) as a local package product.
        .library(name: "AgentSwitchMacCore", targets: ["AgentSwitchMacCore"]),
    ],
    dependencies: [
        // The terminal window's screen (docs/terminal-v0.md §1 Mac); 1.18.x as the iPhone app and project.yml.
        // SwiftTerm 1.18.0, vendored with the input method's marked text patched (Vendor/SwiftTerm/PATCHES.md).
        .package(path: "Vendor/SwiftTerm"),
    ],
    targets: [
        // Pure logic: supervision state machine, paths, env, probes, daemon API client, parsers. Unit-tested.
        .target(name: "AgentSwitchMacCore"),
        // SwiftUI menu-bar app. `swift run AgentSwitchMac` for development; the shipped .app comes from project.yml.
        .executableTarget(name: "AgentSwitchMac", dependencies: ["AgentSwitchMacCore", .product(name: "SwiftTerm", package: "SwiftTerm")]),
        .testTarget(name: "AgentSwitchMacCoreTests", dependencies: ["AgentSwitchMacCore"]),
    ]
)
