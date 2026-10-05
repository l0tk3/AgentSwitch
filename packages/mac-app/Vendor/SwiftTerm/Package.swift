// swift-tools-version:5.9
// SwiftTerm 1.18.0 (github.com/migueldeicaza/SwiftTerm at 7691f85b222a67a66b58499e1b2647443cf0dda7), vendored: only the
// library, with AgentSwitch's patch — an input method's marked text drawn inline on the cell grid at the cursor, the
// caret hidden while it composes, the candidate window placed at the character (docs/terminal-v0.md §1 Mac "输入法",
// PATCHES.md). The iPhone app keeps the upstream package (its screen never takes the keyboard).

import PackageDescription

let package = Package(
    name: "SwiftTerm",
    platforms: [.iOS(.v14), .macOS(.v11)],
    products: [.library(name: "SwiftTerm", targets: ["SwiftTerm"])],
    targets: [
        .target(
            name: "SwiftTerm",
            path: "Sources/SwiftTerm",
            exclude: ["Mac/README.md"],
            resources: [.process("Apple/Metal/Shaders.metal")]
        ),
        // AgentSwitch's own tests of its patches (PATCHES.md); upstream's test suite is not vendored. `swift test` here.
        .testTarget(name: "AgentSwitchPatchTests", dependencies: ["SwiftTerm"], path: "Tests/AgentSwitchPatchTests"),
    ]
)
