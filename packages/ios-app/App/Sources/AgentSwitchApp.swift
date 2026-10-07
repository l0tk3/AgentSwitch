import AgentSwitchKit
import AgentSwitchLive
import SwiftUI

@main
struct AgentSwitchApp: App {
    @State private var model = AgentSwitchApp.makeModel()

    init() {
        FileCache.clear()   // downloaded task files are for looking at now, not kept on the phone
    }

    private static func makeModel() -> AppModel {
        #if DEBUG
        // Screens with sample data and no Mac: `-uiDemo YES`, optionally `-uiDemoScreen settings|task|done|onboarding|
        // stale|interrupted|mac|offline|offlinemac|tasks|search|sessions|transcript|terminals|terminal|terminalsealed|
        // terminalslash|terminalclose|terminalmenu|terminaldelete|terminalsearch|terminalquestion|terminallink|newterminal|newterminalbypass|
        // browser|browserpage|browsertook|browserfile|browserlocal|browserdenied|browsernew|browserclose|browserzoom|
        // browserzoomwatch|linkedpage`.
        if let hosts = UserDefaults.standard.string(forKey: "tlsProbe"), let pin = UserDefaults.standard.string(forKey: "tlsProbePin") {
            TLSProbe.run(hosts: hosts.split(separator: ",").map(String.init), pin: pin)
        }
        if UserDefaults.standard.bool(forKey: "uiDemo") {
            if UserDefaults.standard.string(forKey: "uiDemoScreen") == "onboarding" {
                return AppModel(store: nil, vault: MemoryTokenVault())
            }
            let screen = UserDefaults.standard.string(forKey: "uiDemoScreen")
            let model = AppModel.demo(offline: screen == "offline" || screen == "offlinemac")
            switch screen {
            case "settings", "mac", "offlinemac", "tasks", "search", "sessions", "transcript": model.tab = .settings
            case "task": model.tab = .tasks; model.openTaskRequest = "t2"
            case "done": model.tab = .tasks; model.openTaskRequest = "t3"
            case "running": model.tab = .tasks; model.openTaskRequest = "t1"
            case "stale": model.tab = .tasks; model.openTaskRequest = "t4"
            case "interrupted": model.tab = .tasks; model.openTaskRequest = "t6"
            // The Dispatch page itself (the app opens on the terminals).
            case "home", "offline": model.tab = .tasks
            case "terminals", "terminalmenu", "terminaldelete", "terminalsearch": model.tab = .terminals
            case "terminal", "terminalsealed", "terminalslash", "terminalclose", "terminalkeyboard", "terminalquestion", "terminallink",
                 "simple", "simplebusy", "simplecompact", "simpledaybreak", "simpledaybreakclash", "simpleidle", "simpleeffort", "simplepaste", "simplestep", "simplesuggest", "simplequestion", "simpleprompt", "simplechanges":
                model.tab = .terminals; model.openTerminalRequest = "a1b2c3d4"
            case "newterminal", "newterminalbypass": model.tab = .terminals; model.openTerminalRequest = "new"
            case let s? where s.hasPrefix("browser"): model.tab = .browser; model.openBrowserRequest = DemoBrowser.openRequest(s)
            // A link tapped on a terminal's screen: its page over the terminal, `Done` back to it.
            case "linkedpage":
                model.tab = .terminals; model.openTerminalRequest = "a1b2c3d4"
                model.linkedPage = DemoBrowser.list.tabs.first { $0.id == "vite" }
            default: break
            }
            return model
        }
        #endif
        return AppModel.live()
    }
    @State private var lock = AppLock()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(lock)
                .onOpenURL { open($0) }
                #if DEBUG
                // Simulator has no camera: `simctl launch <dev> com.agentswitch.ios -pairLink 'agentswitch://pair?p=…'`.
                .task { if let link = UserDefaults.standard.string(forKey: "pairLink") { model.receivePairingLink(link) } }
                // Any link without the system's "Open in" prompt: `-openLink agentswitch://terminal/<id>`.
                .task { if let link = UserDefaults.standard.string(forKey: "openLink"), let url = URL(string: link) { open(url) } }
                // A sample Live Activity for looking at the island and the lock screen: `-liveDemo YES`.
                .task { if UserDefaults.standard.bool(forKey: "liveDemo") { await model.live.sync(LiveDemo.state, ended: nil, macName: "Mac mini") } }
                #endif
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: lock.lockIfEnabled()
            case .active: model.resume()
            default: break
            }
        }
    }

    /// A Live Activity's agentswitch://task/<id> or …/terminal/<id> opens that task or terminal; an agentswitch://pair
    /// link opens pairing, the same as a scanned QR code.
    private func open(_ url: URL) {
        if let id = LiveLink.taskId(from: url) {
            model.openTask(id)
        } else if let id = LiveLink.terminalId(from: url) {
            model.openTerminal(id)
        } else {
            model.receivePairingLink(url.absoluteString)
        }
    }
}
