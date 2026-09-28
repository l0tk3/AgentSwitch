import Foundation

/// What one checklist row asks the user to do; the app performs it.
public enum SetupAction: Equatable, Sendable {
    case login(Harness)
    case copyInstall(Harness)
    case pair
    case openTailscale
    case installTailscale
    case chooseWorkDir
    /// 凭据网关服务 (docs/gate-service-v0.md §4): each opens a confirmation first, then macOS's administrator prompt.
    case installGateService
    case updateGateService
    case repairGateService
    /// The regenerated gate CA into the login keychain (the 环境 › 网关证书 flow).
    case trustGateCA
    /// The pre-install CA out of the login keychain (its key was readable by this user).
    case removePreviousGateCA

    /// Verb first, two to four characters (docs/ui-v0.md §4) where the product name allows.
    public var title: String {
        switch self {
        case .login: return "sign in"
        case .copyInstall: return "copy command"
        case .pair: return "pair"
        case .openTailscale: return "open Tailscale"
        case .installTailscale: return "get Tailscale"
        case .chooseWorkDir: return "choose…"
        case .installGateService: return "install…"
        case .updateGateService: return "update…"
        case .repairGateService: return "repair…"
        case .trustGateCA: return "trust…"
        case .removePreviousGateCA: return "remove…"
        }
    }
}

/// One row of 环境 › 设置清单 (docs/control-v0.md §6).
public struct SetupItem: Equatable, Sendable, Identifiable {
    /// `working`: something the user started is under way (an install); not counted as unmet.
    public enum State: Equatable, Sendable { case done, todo, checking, working }

    public let id: String
    public let title: String
    public let state: State
    /// One or two words: 可用, 未登录, 已配对 1 台, ~/AgentSwitch.
    public let status: String
    /// A second line when the row needs one: the install command, the folder's problem.
    public let detail: String?
    public let action: SetupAction?

    public init(id: String, title: String, state: State, status: String, detail: String? = nil, action: SetupAction? = nil) {
        self.id = id
        self.title = title
        self.state = state
        self.status = status
        self.detail = detail
        self.action = action
    }
}

/// Everything the checklist is computed from; nil and `.unknown` mean “not known yet”, never “missing”.
public struct SetupFacts: Sendable {
    public let harnesses: [HarnessReport]
    public let devices: [Device]?
    public let tailscale: TailscaleStatus?
    /// Tailnet addresses the daemon reports on every poll: newer than the last `tailscale status`.
    public let tailnet: [String]
    public let workDir: WorkDirFact
    public let home: String
    /// nil: the rows are left out (nothing known about the service yet in a caller that does not ask).
    public let gateService: GateServiceFacts?

    public init(harnesses: [HarnessReport], devices: [Device]?, tailscale: TailscaleStatus?, tailnet: [String] = [],
                workDir: WorkDirFact, home: String, gateService: GateServiceFacts? = nil) {
        self.harnesses = harnesses
        self.devices = devices
        self.tailscale = tailscale
        self.tailnet = tailnet
        self.workDir = workDir
        self.home = home
        self.gateService = gateService
    }
}

/// The setup checklist from real state: each harness installed and logged in, the gate as a system service (and the
/// keychain after its install), a paired phone, Tailscale connected, the default work dir usable. 「文件和文件夹」 is left out: macOS offers no way to read that grant without asking
/// for it, and a check must never raise a prompt.
public enum SetupChecklist {
    public static func items(_ facts: SetupFacts) -> [SetupItem] {
        harnessItems(facts.harnesses) + gateServiceItems(facts.gateService)
            + [phone(facts.devices), tailscale(facts.tailscale, tailnet: facts.tailnet)]
            + [workDir(facts.workDir, home: facts.home)].compactMap { $0 }
    }

    public static func unmet(_ items: [SetupItem]) -> Int {
        items.filter { $0.state == .todo }.count
    }

    /// The three harnesses, in the fixed order, checking until detection has run.
    public static func harnessItems(_ reports: [HarnessReport]) -> [SetupItem] {
        Harness.allCases.map { harness in
            guard let report = reports.first(where: { $0.harness == harness }) else {
                return SetupItem(id: harness.rawValue, title: harness.title, state: .checking, status: "checking")
            }
            let status = StatusText.harness(report.state).text
            switch report.state {
            case .ready:
                return SetupItem(id: harness.rawValue, title: harness.title, state: .done, status: status)
            case .notLoggedIn:
                return SetupItem(id: harness.rawValue, title: harness.title, state: .todo, status: status, action: .login(harness))
            case .missing:
                return SetupItem(id: harness.rawValue, title: harness.title, state: .todo, status: status,
                                 detail: HarnessInstall.command(harness), action: .copyInstall(harness))
            }
        }
    }

    static func phone(_ devices: [Device]?) -> SetupItem {
        guard let devices else { return SetupItem(id: "phone", title: "iPhone", state: .checking, status: "loading") }
        let active = devices.filter { !$0.isRevoked }.count
        return active > 0
            ? SetupItem(id: "phone", title: "iPhone", state: .done, status: "\(active) paired")
            : SetupItem(id: "phone", title: "iPhone", state: .todo, status: "not paired", action: .pair)
    }

    static func tailscale(_ status: TailscaleStatus?, tailnet: [String]) -> SetupItem {
        if !tailnet.isEmpty { return SetupItem(id: "tailscale", title: "Tailscale", state: .done, status: "connected") }
        switch status?.state {
        case .none:
            return SetupItem(id: "tailscale", title: "Tailscale", state: .checking, status: "checking")
        case .running:
            return SetupItem(id: "tailscale", title: "Tailscale", state: .done, status: "connected")
        case .stopped:
            return SetupItem(id: "tailscale", title: "Tailscale", state: .todo, status: "disconnected",
                             detail: "打开并登录 Tailscale 后，iPhone 可在局域网外连接", action: .openTailscale)
        case .notInstalled:
            return SetupItem(id: "tailscale", title: "Tailscale", state: .todo, status: "not installed",
                             detail: "iPhone 仅可在同一局域网内连接", action: .installTailscale)
        }
    }

    /// The app bundle a Tailscale CLI lives in (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`), for 打开 Tailscale.
    public static func tailscaleApp(binary: String?) -> String? {
        guard let binary, let range = binary.range(of: ".app/", options: .backwards) else { return nil }
        return String(binary[..<range.lowerBound]) + ".app"
    }

    static func workDir(_ fact: WorkDirFact, home: String) -> SetupItem? {
        let title = "work folder"
        switch fact {
        case .unsupported:
            return nil
        case .unknown:
            return SetupItem(id: "workdir", title: title, state: .checking, status: "loading")
        case .known(let s):
            let path = DisplayPath.short(s.path, home: home)
            guard let problem = s.problem else { return SetupItem(id: "workdir", title: title, state: .done, status: path) }
            return SetupItem(id: "workdir", title: title, state: .todo, status: "unavailable", detail: "\(path)：\(problem)",
                             action: .chooseWorkDir)
        }
    }
}
