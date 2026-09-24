import AgentSwitchKit
import SwiftUI

@main
struct AgentSwitchApp: App {
    @State private var model = AppModel.live()

    init() {
        FileCache.clear()   // downloaded task files are for looking at now, not kept on the phone
    }
    @State private var lock = AppLock()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(lock)
                // A tapped agentswitch://pair link opens pairing, the same as a scanned QR code.
                .onOpenURL { url in model.receivePairingLink(url.absoluteString) }
                #if DEBUG
                // Simulator has no camera: `simctl launch <dev> com.agentswitch.ios -pairLink 'agentswitch://pair?p=…'`.
                .task { if let link = UserDefaults.standard.string(forKey: "pairLink") { model.receivePairingLink(link) } }
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
