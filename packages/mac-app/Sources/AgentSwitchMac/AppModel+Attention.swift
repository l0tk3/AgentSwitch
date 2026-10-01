import AgentSwitchMacCore

/// One thing that needs the user, as the menu lists it and the menu bar mark counts it.
struct AttentionItem: Identifiable {
    let id: String
    let text: String
    /// How many things the row stands for (the setup row counts each missing piece).
    var count = 1
    /// The button's title; Fix opens Settings › Environment.
    var action = "Fix"
    /// The gate service's update: the button asks for it before Environment opens.
    var offersUpdate = false
    /// An error rather than something to do (the gate service not answering).
    var level = StatusLevel.warning
}

extension AppModel {
    /// The gate service when it needs the user (gate-service-v0 §4: 未安装, 无响应, 有更新), what else the setup
    /// checklist misses (control-v0 §6), Bonjour held by macOS, the remote listener in trouble: each opens 设置 › 环境.
    var attention: [AttentionItem] {
        var out: [AttentionItem] = []
        let facts = gateServiceFacts
        let gate = GateServiceText.attention(facts)
        if let gate {
            let update = facts.updateAvailable && facts.health == .responding && !facts.ownedByAnotherUser
            out.append(AttentionItem(id: "gate", text: gate, action: update ? "Update…" : "Fix", offersUpdate: update,
                                     level: facts.health == .notResponding || facts.ownedByAnotherUser ? .error : .warning))
        }
        let unmet = setupItems.filter { $0.state == .todo && (gate == nil || $0.id != SetupChecklist.gateServiceID) }.count
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
