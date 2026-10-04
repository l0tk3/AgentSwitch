import AgentSwitchMacCore
import AppKit
import WebKit

/// The terminal page in the window's look (docs/ui-v0.md §8): the page is told the look and the system's accent at its
/// start, and again whenever the setting (Settings › General › Appearance) or the accent (System Settings) changes — it
/// draws itself again where it stands, the terminals and their screens untouched.
extension TerminalsPageController {
    /// What the page is given at its start: what this window draws for it (the screens, the status bar's lock, the
    /// panes), and the look.
    static func install(scripts: WKUserContentController, look: InterfaceLook, accent: String?) {
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(
            source: "window.agentswitchNativeScreen = true; window.agentswitchStatusBar = true; window.agentswitchPanes = true;",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.addUserScript(WKUserScript(source: TerminalPageLook.startScript(look: look, accent: accent),
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    /// The system's accent as the page takes it, as drawn on the dark chrome the main window keeps (固定深色).
    static func accentHex() -> String? {
        var hex: String?
        NSAppearance(named: .darkAqua)?.performAsCurrentDrawingAppearance {
            guard let color = NSColor.controlAccentColor.usingColorSpace(.sRGB) else { return }
            hex = TerminalPageLook.hex(red: color.redComponent, green: color.greenComponent, blue: color.blueComponent)
        }
        return hex
    }

    /// The setting and the system's colours are watched while the window is open.
    func followLook() {
        let center = NotificationCenter.default
        for name in [UserDefaults.didChangeNotification, NSColor.systemColorsDidChangeNotification] {
            lookObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.tellLook() }
            })
        }
    }

    /// Told only when one of the two changed: the page open now, and the next one loaded here (signing in again).
    private func tellLook() {
        let look = InterfaceLook.current, accent = Self.accentHex()
        guard look != toldLook || accent != toldAccent else { return }
        toldLook = look
        toldAccent = accent
        Self.install(scripts: web.configuration.userContentController, look: look, accent: accent)
        web.evaluateJavaScript(TerminalPageLook.changeScript(look: look, accent: accent), completionHandler: nil)
    }
}
