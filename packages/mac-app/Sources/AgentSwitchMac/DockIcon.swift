import AgentSwitchMacCore
import AppKit

/// The Dock's icon follows the look (docs/ui-v0.md §10). The bundle's icon is the classic one — the system draws it, in
/// whichever style the user keeps their icons — and in the pixel look the app puts its pixel icon in the Dock while it
/// runs. Finder and Launchpad show the bundle's either way.
@MainActor
enum DockIcon {
    /// The pixel icon the bundle carries (Resources/AppIconPixel.png); nil in a build without a bundle (`swift run`).
    private static let pixel: NSImage? = Bundle.main.url(forResource: "AppIconPixel", withExtension: "png").flatMap(NSImage.init(contentsOf:))
    private static var shown: InterfaceLook?

    /// The icon for the look in use; nothing happens when it is the one already there.
    static func follow(_ look: InterfaceLook = .current) {
        guard look != shown else { return }
        shown = look
        // nil hands the Dock back to the bundle's icon.
        NSApp.applicationIconImage = look.isClassic ? nil : pixel
    }
}
