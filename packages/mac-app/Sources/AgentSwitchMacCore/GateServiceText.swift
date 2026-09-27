import Foundation

/// Everything the 凭据网关服务 rows are computed from.
public struct GateServiceFacts: Sendable, Equatable {
    public let state: GateServiceState
    public let health: GateServiceHealth.Verdict
    public let updateAvailable: Bool
    /// An install, update or uninstall under way.
    public let operation: GateServiceOperation?
    /// Set when the gate CA was trusted before the install regenerated it.
    public let previousCA: PreviousCATrust?
    /// This user's uid (`getuid()`), against the service's `ownerUid`.
    public let uid: Int
    public let port: Int

    public init(state: GateServiceState, health: GateServiceHealth.Verdict, updateAvailable: Bool = false,
                operation: GateServiceOperation? = nil, previousCA: PreviousCATrust? = nil, uid: Int, port: Int) {
        self.state = state
        self.health = health
        self.updateAvailable = updateAvailable
        self.operation = operation
        self.previousCA = previousCA
        self.uid = uid
        self.port = port
    }

    public var ownedByAnotherUser: Bool { state.ownedByAnotherUser(uid: uid) }
}

/// The service's status words (docs/ui-v0.md §4, §4.1: phrases, no sentences, for states).
public enum GateServiceText {
    /// The full line: 环境 › 服务与网络 and the menu row's tooltip.
    public static func line(_ f: GateServiceFacts) -> StatusLine {
        if let op = f.operation { return StatusLine(op.progressText, .busy) }
        switch f.state.availability {
        case .unknown: return StatusLine("检测中", .busy)
        case .unsupported: return StatusLine("内置 secret-gate 不支持系统服务", .off)
        case .notInstalled: return StatusLine("未安装", .off)
        case .installed: break
        }
        if f.ownedByAnotherUser { return StatusLine("属于其他用户（uid \(f.state.ownerUid ?? 0)）", .error) }
        switch f.health {
        case .checking: return StatusLine("检测中", .busy)
        case .notResponding: return StatusLine("凭据网关服务无响应", .error)
        case .responding: return StatusLine("运行中 · 系统服务 · 127.0.0.1:\(f.port)", .ok)
        }
    }

    /// One word for the menu row.
    public static func short(_ f: GateServiceFacts) -> StatusLine {
        let full = line(f)
        guard f.state.isInstalled, f.operation == nil else { return full }
        if f.ownedByAnotherUser { return StatusLine("不可用", .error) }
        switch f.health {
        case .checking: return StatusLine("检测中", .busy)
        case .notResponding: return StatusLine("无响应", .error)
        case .responding: return StatusLine("运行中", .ok)
        }
    }

    /// The menu's attention row for the service, when it needs the user.
    public static func attention(_ f: GateServiceFacts) -> String? {
        guard f.operation == nil else { return nil }
        switch f.state.availability {
        case .notInstalled: return "凭据网关服务未安装"
        case .installed:
            if f.ownedByAnotherUser { return "凭据网关服务不可用" }
            if f.health == .notResponding { return "凭据网关服务无响应" }
            return f.updateAvailable && f.health == .responding ? "凭据网关有更新" : nil
        case .unknown, .unsupported: return nil
        }
    }
}

extension SetupChecklist {
    public static let gateServiceID = "gate-service"
    public static let gateCAID = "gate-ca"
    public static let previousGateCAID = "gate-ca-previous"

    /// 凭据网关服务 (docs/gate-service-v0.md §4), then the keychain after the install regenerated the CA (§5.5).
    public static func gateServiceItems(_ facts: GateServiceFacts?) -> [SetupItem] {
        guard let facts else { return [] }
        return [gateServiceItem(facts)].compactMap { $0 } + certificateItems(facts)
    }

    static func gateServiceItem(_ f: GateServiceFacts) -> SetupItem? {
        let title = "凭据网关服务"
        if let op = f.operation { return SetupItem(id: gateServiceID, title: title, state: .working, status: op.progressText) }
        switch f.state.availability {
        case .unknown:
            return SetupItem(id: gateServiceID, title: title, state: .checking, status: "检测中")
        case .unsupported:
            return nil
        case .notInstalled:
            return SetupItem(id: gateServiceID, title: title, state: .todo, status: "未安装",
                             detail: "安装后，私钥由独立的系统账户保管，执行器无法读取。", action: .installGateService)
        case .installed:
            break
        }
        if f.ownedByAnotherUser {
            return SetupItem(id: gateServiceID, title: title, state: .todo, status: "不可用",
                             detail: "此服务为另一个 macOS 用户（uid \(f.state.ownerUid ?? 0)）安装，当前用户无法使用。")
        }
        switch f.health {
        case .checking:
            return SetupItem(id: gateServiceID, title: title, state: .checking, status: "检测中")
        case .notResponding:
            return SetupItem(id: gateServiceID, title: title, state: .todo, status: "无响应",
                             detail: "系统服务由 launchd 自动重启。持续无响应时，可重新安装服务程序。", action: .repairGateService)
        case .responding:
            guard f.updateAvailable else { return SetupItem(id: gateServiceID, title: title, state: .done, status: "运行中") }
            return SetupItem(id: gateServiceID, title: title, state: .todo, status: "有更新",
                             detail: "App 内置的凭据网关程序与已安装的版本不同。", action: .updateGateService)
        }
    }

    static func certificateItems(_ f: GateServiceFacts) -> [SetupItem] {
        guard f.state.isInstalled, f.operation == nil, let ca = f.previousCA, !ca.settled else { return [] }
        var out: [SetupItem] = []
        if ca.oldTrusted {
            out.append(SetupItem(id: previousGateCAID, title: "旧网关证书", state: .todo, status: "仍受信任",
                                 detail: "旧证书的私钥曾对当前用户可读，建议从登录钥匙串中移除。", action: .removePreviousGateCA))
        }
        if !ca.newTrusted {
            out.append(SetupItem(id: gateCAID, title: "网关证书", state: .todo, status: "未加入钥匙串",
                                 detail: "安装服务前的证书曾加入登录钥匙串。网关证书已重新生成，需重新加入。", action: .trustGateCA))
        }
        return out
    }
}
