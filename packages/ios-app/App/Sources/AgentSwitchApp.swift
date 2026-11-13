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
        // terminalslash|terminalclose|terminalmenu|terminaldelete|terminalselect|terminaldeletemany|terminalsearch|terminalsmany|terminalquestion|terminallink|newterminal|newterminalbypass|
        // browser|browserpage|browsertook|browserfile|browserlocal|browserdenied|browsernew|browserclose|browserzoom|
        // browserzoomwatch|linkedpage|proxies|clash|clashservice|clashrules|clashcheck|clashnodes|clashtext|clashsource|
        // proxybrowser|proxyprofile|files|fileshome|filesopen|filespreview|filespreviewlong|filesimage|filesselect|fileschoose|filessensitive|
        // filesscoped|filessheet|filesreply|filesnew|filesnameerror|filestrash|filestrashbusy|filesselectbar|filesshare|filesupload|
        // filesclash|filesgone|transcriptfiles|terminalpath`.
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
            case "settings", "mac", "offlinemac", "tasks", "search", "sessions", "transcript", "transcriptfiles",
                 "proxies", "clash", "clashservice", "clashrules", "clashcheck", "clashnodes", "clashtext", "clashsource", "clashsubscription", "clashallnodes", "proxybrowser", "proxyprofile": model.tab = .settings
            case "task": model.tab = .tasks; model.openTaskRequest = "t2"
            case "done": model.tab = .tasks; model.openTaskRequest = "t3"
            case "running": model.tab = .tasks; model.openTaskRequest = "t1"
            case "stale": model.tab = .tasks; model.openTaskRequest = "t4"
            case "interrupted": model.tab = .tasks; model.openTaskRequest = "t6"
            // The Dispatch page itself (the app opens on the terminals).
            case "home", "offline": model.tab = .tasks
            case "keptfiles":
                model.tab = .tasks
                model.demoKeptFiles = KeptFiles(tasks: [
                    .init(id: "t3", title: "整理下载目录里的重复文件", createdAt: Date().timeIntervalSince1970 * 1000 - 3_600_000,
                          files: [TaskFile(path: "out/report.md", size: 4_096, isDeliverable: true), TaskFile(path: "out/dupes.txt", size: 1_024, isDeliverable: true)]),
                    .init(id: "t1", title: "把这张截图里的表格转成 Excel", createdAt: Date().timeIntervalSince1970 * 1000 - 2 * 86_400_000,
                          files: [TaskFile(path: "out/table.xlsx", size: 58_000, isDeliverable: true), TaskFile(path: "in/shot.png", size: 401_000, isDeliverable: false)])])
                model.openKeptFilesRequest = true
            case "terminals", "terminalsconnecting", "terminalmenu", "terminalmenuprofile", "terminaldelete", "terminalselect", "terminaldeletemany", "terminalsearch", "terminalprofiles": model.tab = .terminals
            // A long tree read again as the Mac's is (TerminalsListProbe).
            case "terminalsmany": model.tab = .terminals; TerminalsListProbe.start(model)
            case "terminal", "terminalsealed", "terminalslash", "terminalclose", "terminalkeyboard", "terminalquestion", "terminallink", "terminalpath",
                 "simple", "simplebusy", "simplecompact", "simpledaybreak", "simpledaybreakclash", "simpleidle", "simpleeffort", "simplepaste", "simplestep", "simplesuggest", "simplequestion", "simpleprompt", "simplechanges":
                model.tab = .terminals; model.openTerminalRequest = "a1b2c3d4"
            case "newterminal", "newterminalbypass", "newterminalprofile": model.tab = .terminals; model.openTerminalRequest = "new"
            // The Files tab (docs/files-v0.md §5) on the made-up disk (DemoFiles): its pages in FilesTab.demo.
            case "files", "filesopen", "filespreview", "filespreviewlong", "filesimage", "filesselect", "fileschoose", "filessensitive",
                 "filesnew", "filesnameerror", "filestrash", "filestrashbusy", "filesselectbar", "filesshare", "filesupload", "filesclash":
                model.tab = .files; model.files.openRequest = DemoFiles.project
            case "fileshome", "filesscoped": model.tab = .files; model.files.openRequest = DemoFiles.home
            // `Show in Files` for a session whose folder is gone: its nearest level still there (files-v0 §12.4).
            case "filesgone": model.tab = .files; model.files.openRequest = "\(DemoFiles.project)/packages/gone"
            // `+` › Files on Mac over the terminal; the Mac's files in its reply box.
            case "filessheet": model.tab = .terminals; model.openTerminalRequest = "a1b2c3d4"
            case "filesreply":
                // As the Files tab hands them over, to a reply begun before (kept as a draft is).
                model.tab = .terminals; model.openTerminalRequest = "a1b2c3d4"
                ReplyDrafts.shared.text["a1b2c3d4"] = "对照一下 "
                model.files.handoff = .init(terminal: "a1b2c3d4", picks: [MacPick(path: "\(DemoFiles.project)/src/app.ts", isFolder: false),
                                                                          MacPick(path: "\(DemoFiles.project)/.env", isFolder: false, sensitive: true)])
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
                .task { model.notifier.opened = { model.openTerminal($0) } }
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
            case .background: lock.lockIfEnabled(); model.inFront = false
            case .active: model.inFront = true; model.resume()
            default: model.inFront = false
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
