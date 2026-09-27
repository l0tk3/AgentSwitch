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
        // stale|interrupted|mac|offline|offlinemac|tasks|search|sessions|transcript`.
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
            case "settings", "mac", "offlinemac", "tasks", "search", "sessions", "transcript": model.sheet = .settings
            case "task": model.openTaskRequest = "t2"
            case "done": model.openTaskRequest = "t3"
            case "running": model.openTaskRequest = "t1"
            case "stale": model.openTaskRequest = "t4"
            case "interrupted": model.openTaskRequest = "t6"
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
                // A Live Activity's agentswitch://task/<id> opens that task; an agentswitch://pair link opens pairing,
                // the same as a scanned QR code.
                .onOpenURL { url in
                    if let id = LiveLink.taskId(from: url) { model.openTask(id) } else { model.receivePairingLink(url.absoluteString) }
                }
                #if DEBUG
                // Simulator has no camera: `simctl launch <dev> com.agentswitch.ios -pairLink 'agentswitch://pair?p=…'`.
                .task { if let link = UserDefaults.standard.string(forKey: "pairLink") { model.receivePairingLink(link) } }
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
}
