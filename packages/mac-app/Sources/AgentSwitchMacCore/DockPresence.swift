import Foundation

/// A menu-bar app normally stays out of the Dock. It shows there while its settings window is open (so the window can
/// be found with Cmd-Tab and the Dock like any other), and always when the user turned that on in 通用.
public enum DockPresence {
    public static let alwaysShowKey = "alwaysShowInDock"

    public static func showsInDock(alwaysShow: Bool, settingsWindowOpen: Bool) -> Bool {
        alwaysShow || settingsWindowOpen
    }
}
