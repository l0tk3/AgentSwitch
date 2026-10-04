import AgentSwitchKit
import OSLog
import UIKit

/// The Home Screen icon follows the look (docs/ui-v0.md §10): the classic icon is the app's own, the pixel one its
/// alternate. The system tells the user each time the icon changes, so nothing is asked for when it is already the
/// right one.
@MainActor
enum HomeIcon {
    /// The alternate icon's name: App/AppIconPixel.icon (project.yml lists it for the asset compiler).
    static let pixel = "AppIconPixel"
    private static let log = Logger(subsystem: "com.agentswitch.ios", category: "icon")

    /// The icon a look has: nil is the app's own.
    static func name(for look: InterfaceLook) -> String? { look.isClassic ? nil : pixel }

    static func follow(_ look: InterfaceLook) {
        let app = UIApplication.shared
        let wanted = name(for: look)
        guard app.supportsAlternateIcons, app.alternateIconName != wanted else { return }
        Task {
            do {
                try await app.setAlternateIconName(wanted)
            } catch {
                // Not in front yet, or the icon is missing from the bundle: the next time the app comes to the front tries again.
                log.error("could not change the icon to \(wanted ?? "the default", privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
