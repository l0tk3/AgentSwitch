import AgentSwitchMacCore

/// One thing that needs the user, as the menu lists it and the menu bar mark counts it.
struct AttentionItem: Identifiable {
    let id: String
    let text: String
    /// How many things the row stands for (the setup row counts each missing piece).
    var count = 1
    /// The button's title; Fix opens Settings › Environment.
    var action = "Fix"
    var level = StatusLevel.warning
}

extension AppModel {
    /// What the setup checklist misses (control-v0 §6), Bonjour held by macOS, the remote listener in trouble: each
    /// opens 设置 › 环境.
    var attention: [AttentionItem] {
        var out: [AttentionItem] = []
        let unmet = setupUnmet
        if unmet > 0 { out.append(AttentionItem(id: "setup", text: "Setup: \(unmet) Left", count: unmet)) }
        if remoteEnabled && daemonReady && remoteLine.level >= .warning {
            out.append(AttentionItem(id: "remote", text: "iPhone: Unavailable"))
        }
        if bonjourLine.level >= .warning {
            out.append(AttentionItem(id: "bonjour", text: "LAN Discovery: Unavailable"))
        }
        return out
    }

    /// How many things wait for the user (the setup row counts each missing piece).
    var waitingCount: Int { attention.map(\.count).reduce(0, +) }
}
