import AgentSwitchMacCore
import AppKit
import SwiftUI

// What the Terminals page does when asked (the web page's `select`, `focusOn`, `splitFocused`, `start`, `resume`,
// `closeTerminal` …, natively): showing a terminal, the panes, a new terminal, going on with a session, names, closing.

extension TerminalsModel {
    // MARK: showing a terminal

    /// Terminal `id` on screen: out in a window of its own, that window comes forward; shown in a pane already, that
    /// pane takes the focus; else it goes in the pane in focus. `loading`: a line over the screen until the agent draws.
    func select(_ id: String, loading: String? = nil) {
        guard terminal(id) != nil else { return }
        guard here(id) else { return onRaise(id) }
        if let shown = TerminalPanes.paneShowing(layout, id) {
            focusPane = shown.id
            setLayout(layout)
        } else {
            setLayout(TerminalPanes.show(layout, focusPane, id))
        }
        creating = false
        createError = ""
        syncPanes()
        focused?.say(loading)
        defaults?.set(id, forKey: Keys.last)
        onFocusScreen(focusPane)
    }

    /// The focus to pane `id`: its terminal has the keyboard, the bar and the status bar; an empty pane says what to do.
    func focus(pane id: Int, force: Bool = false) {
        guard TerminalPanes.pane(layout, id) != nil else { return }
        guard force || id != focusPane || creating else { return }
        focusPane = id
        creating = false
        setLayout(layout)
        syncPanes()
        onFocusScreen(id)
    }

    // MARK: the panes

    /// ⌘D, ⌘⇧D, the bar's buttons: the pane in focus split, the new half empty and in focus.
    @discardableResult
    func split(_ side: PaneSide) -> Bool {
        guard paneList.count < TerminalPanes.maxPanes else { say("最多 \(TerminalPanes.maxPanes) 个分屏。"); return false }
        guard !zoomed else { say("先按 ⌘⇧↩ 还原，再分屏。"); return false }
        let rect = placed(in: area).panes.first { $0.id == focusPane }?.rect
        let across = side == .left || side == .right
        let room = rect.map { across ? $0.width >= 2 * TerminalPanes.minWidth + TerminalPanes.gap : $0.height >= 2 * TerminalPanes.minHeight + TerminalPanes.gap } ?? false
        guard room, let made = TerminalPanes.split(layout, focusPane, side) else { say("这一块太小，无法再分。"); return false }
        // Split off a record (or off a pane waiting as one): the new pane is the simple view too — the window keeps
        // its look, and what lands there is shown as its record (2026-10-07, user: 简略模式下我点击分屏会切回暗黑终端模式).
        if isLight(pane: focusPane) { simplePanes.insert(made.pane) }
        setLayout(made.root)
        focus(pane: made.pane, force: true)
        return true
    }

    func closePane(_ id: Int) {
        guard many else { return }
        setLayout(TerminalPanes.close(layout, id))
        focus(pane: focusPane, force: true)
    }

    /// ⌘⇧↩: the pane in focus alone, or all of them again.
    func toggleZoom() {
        guard many else { return }
        zoomed.toggle()
        onFocusScreen(focusPane)
    }

    /// ⌘⌥ arrows: the focus to the pane next door.
    func focusNeighbor(dx: Int, dy: Int) {
        guard many, !zoomed, let next = TerminalPanes.neighbor(placed(in: area).panes, of: focusPane, dx: dx, dy: dy) else { return }
        focus(pane: next)
    }

    /// A line between panes dragged to `at` (points along its split's axis, from the split's start).
    func dragLine(_ line: TerminalPanes.Line, to at: CGFloat) {
        sizing = true
        layout = TerminalPanes.resize(layout, line.id, TerminalPanes.ratio(layout, line: line.id, in: line.box, at: at))
    }

    func endLineDrag() {
        sizing = false
        setLayout(layout)
    }

    /// A double click on a line: half each.
    func evenLine(_ id: Int) { setLayout(TerminalPanes.resize(layout, id, 0.5)) }

    // MARK: rows

    /// The terminal a session is already continued in, if any.
    func openedAs(_ session: SessionSummary) -> TerminalInfo? {
        terminals.first { $0.running && ($0.resumedFrom == session.sessionId || $0.agentSessionId == session.sessionId) }
    }

    /// A row clicked: its terminal in the pane in focus (a session goes on there); with ⌘, in a new pane to the right.
    func open(_ item: TerminalRowItem, beside: Bool = false) {
        if beside { return openBeside(item) }
        switch item {
        case .terminal(let id): select(id)
        case .session(let session): resume(session)
        }
    }

    private func openBeside(_ item: TerminalRowItem) {
        let term: String? = switch item {
        case .terminal(let id): id
        case .session(let session): openedAs(session)?.id
        }
        if let term, TerminalPanes.paneShowing(layout, term) != nil || !here(term) { return select(term) }
        guard split(.right) else { return }
        if let term { select(term) } else if case .session(let session) = item { resume(session) }
    }

    /// A row let go on a pane: its middle shows it there, an edge splits that side for it.
    func drop(_ item: TerminalRowItem, on pane: Int, _ zone: PaneZone) {
        zoomed = false
        let term: String? = switch item {
        case .terminal(let id): id
        case .session(let session): openedAs(session)?.id
        }
        if let term {
            guard here(term), let done = TerminalPanes.drop(layout, term, on: pane, zone) else { return }
            focusPane = done.pane
            setLayout(done.root)
            return select(term)
        }
        guard case .session(let session) = item else { return }
        var target = pane
        if case .side(let side) = zone {
            guard let made = TerminalPanes.split(layout, pane, side) else { return }
            setLayout(made.root)
            target = made.pane
        }
        focus(pane: target, force: true)
        resume(session)
    }

    // MARK: a sub-agent's card

    /// A sub-agent's row clicked (docs/simple-view-v0.md §5.22): its terminal on screen, as before — and, where the
    /// agent keeps what each of its sub-agents did (Claude Code), the card with that over the terminal's pane; the
    /// row of the card already shown puts it away. A terminal out in a window of its own comes forward, and no more.
    func openSubagent(_ agent: TerminalSubagent, terminal id: String) {
        guard let info = terminal(id) else { return }
        select(id)
        guard here(id), SubagentDisplay.hasRecords(info.harness), let session = info.agentSessionId,
              let pane = TerminalPanes.paneShowing(layout, id), let state = panes[pane.id] else { return }
        state.toggleSubagent(SubagentTarget(harness: info.harness, session: session, agent: agent.id), name: agent.name, type: agent.type)
    }

    /// The card over the pane that shows terminal `id` is this sub-agent's: its row is marked.
    func subagentShown(_ agent: String, terminal id: String) -> Bool {
        guard let pane = TerminalPanes.paneShowing(layout, id), let card = panes[pane.id]?.subagent else { return false }
        return card.target.agent == agent
    }

    /// A terminal's menu, `Show Sub-Agents`: the card over its pane with one of its session's sub-agents — the latest
    /// still at work, else the latest — whose own menu goes to the others. This is the way to one that has ended
    /// while the pane shows the terminal's screen: its row left the list when it did, and a screen has no step to
    /// click. A session that sent none is said so.
    func showSubagents(of id: String) {
        guard let info = terminal(id), here(id), SubagentDisplay.hasRecords(info.harness), let session = info.agentSessionId else { return }
        let c = client()
        Task {
            let all: [SubagentSummary]
            do { all = try await c.sessionSubagents(harness: info.harness, id: session) }
            catch DaemonError.notSupported { return say(SubagentDisplay.unsupported) }
            catch { return say(Self.reason(error)) }
            guard let pick = all.last(where: { !$0.done }) ?? all.last else { return say(SubagentDisplay.noneSent) }
            select(id)
            guard let pane = TerminalPanes.paneShowing(layout, id), let state = panes[pane.id] else { return }
            let target = SubagentTarget(harness: info.harness, session: session, agent: pick.id)
            if state.subagent?.target != target { state.toggleSubagent(target, name: pick.name, type: pick.type) }
        }
    }

    func toggleFolder(_ cwd: String) {
        collapsed = collapsed.contains(cwd) ? collapsed.subtracting([cwd]) : collapsed.union([cwd])
    }

    func toggleMore(_ cwd: String) {
        expanded = expanded.contains(cwd) ? expanded.subtracting([cwd]) : expanded.union([cwd])
    }

    /// A terminal just started or continued shows in the list: its folder and every folder above it open.
    private func unfold(_ cwd: String) {
        let above = Set(TerminalTree.foldersAbove(cwd))
        if !collapsed.isDisjoint(with: above) { collapsed = collapsed.subtracting(above) }
    }

    // MARK: the list's side

    func toggleList() { sideClosed.toggle() }

    /// The list's edge dragged to `x`: its width within its limits; past the left edge it closes.
    func dragSide(to x: CGFloat, pageWidth: CGFloat) {
        if x < Side.closeBelow { sideClosed = true; return }
        sideClosed = false
        sideWidth = Swift.max(Side.min, Swift.min(x, Side.max, pageWidth - Side.room)).rounded()
    }

    func focusSearch() {
        if sideClosed { sideClosed = false }
        searchFocus += 1
    }

    func leaveSearch() {
        query = ""
        onFocusScreen(focusPane)
    }

    // MARK: a new terminal

    /// One can leave the panel: there is a terminal to go back to.
    var canLeaveCreate: Bool {
        TerminalPanes.pane(layout, focusPane)?.term != nil || paneList.contains { $0.term != nil } || many
    }

    /// The new-terminal panel in the pane in focus; `folder`: started from a folder's `+`.
    func showCreate(folder: String? = nil) {
        creating = true
        createError = ""
        // What was picked last, while it can still be had: an agent installed, a shell the service opens.
        if !(pickedShell ? shellOffered : agents.contains(pickedAgent)), let first = agents.first { pickedAgent = first }
        if !TerminalListText.modes.contains(where: { $0.id == pickedMode }) { pickedMode = "manual" }
        if let folder { folderText = TerminalTree.tilde(folder) } else if folderText.isEmpty { folderText = "~" }
        // The profiles to choose between, as they are now; the panel offers the one last chosen until another is.
        pickedProfiles = [:]
        Task { await refreshProfiles() }
    }

    /// Each agent's profiles (docs/profiles-v0.md §3.3): what the new-terminal panel and `Resume As` choose between.
    func refreshProfiles() async {
        guard let all = try? await client().profiles() else { return }
        if profiles != all { profiles = all }
    }

    /// The panel has a shell picked, not an agent: a folder is all there is to choose.
    var pickedShell: Bool { pickedAgent == TerminalKind.shell }

    /// The profile the panel has chosen for the agent picked: nil when the agent has only the Mac's own.
    var pickedProfile: AgentProfile? {
        guard let list = profiles[pickedAgent], list.several else { return nil }
        return pickedProfiles[pickedAgent].flatMap { id in list.profiles.first { $0.id == id } } ?? list.offered
    }

    func cancelCreate() {
        guard creating, canLeaveCreate else { return }
        creating = false
        createError = ""
        focus(pane: focusPane, force: true)
    }

    /// The folders offered under the panel's field: where the terminals and the sessions are.
    var knownFolders: [String] {
        var seen: Set<String> = []
        return (terminals.map(\.cwd) + sessions.map(\.cwd)).map(TerminalTree.tilde).filter { seen.insert($0).inserted }.prefix(30).map { $0 }
    }

    func start() {
        guard creating, !starting else { return }
        let cwd = folderText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cwd.isEmpty else { createError = "请填写文件夹。"; return }
        starting = true
        createError = ""
        let agent = pickedAgent
        let model = pickedModel
        let shell = pickedShell
        let grid = gridHere
        let body = NewTerminalRequest(harness: agent, cwd: cwd, model: model, effort: pickedEffort, mode: pickedMode, cols: grid?.cols, rows: grid?.rows, profile: pickedProfile?.id)
        let c = client()
        Task {
            defer { starting = false }
            do {
                // A shell is a folder and a size: it has no model, no profile, no way of asking.
                let made = shell ? try await c.createShell(cwd: cwd, cols: grid?.cols, rows: grid?.rows) : try await c.createTerminal(body)
                defaults?.set(cwd, forKey: Keys.folder)
                unfold(made.cwd)
                // What was just made is in the list: a list of another agent's alone would not show it.
                if let chosen = filter.agent, chosen != made.harness { filter = TerminalListFilter(agent: nil, active: filter.active) }
                await refresh()
                select(made.id, loading: "Starting \(TerminalListText.agentName(agent))")
            } catch {
                createError = Self.reason(error)
            }
        }
    }

    // MARK: going on with a session

    /// Continues a session in the pane in focus. Open here already: that terminal. Open in another program: asked
    /// whether to fork (one writer at a time). Its folder gone: asked where to go on (docs/terminal-v0.md §5).
    /// `profile`: `Resume As` — under that one; nil: under the one it last ran under.
    func resume(_ session: SessionSummary, as profile: String? = nil) {
        guard TerminalListText.resumable.contains(session.harness), opening == nil else { return }
        if let open = openedAs(session) { return select(open.id) }
        let name = TerminalListText.brief(session.title)
        let c = client()
        Task {
            if !TerminalListText.checked.contains(session.harness), session.active {
                let answer = await ask(TerminalSheet(title: "继续「\(name)」？", body: TerminalListText.mayBeOpen(session.harness), confirm: "Resume"))
                guard answer.ok else { return }
            }
            opening = session.sessionId
            creating = false
            focused?.say("Opening 「\(name)」")
            defer { opening = nil }
            do {
                // How it asks: as its record says; a record that does not say (pi's, OpenCode's) as last picked for a new
                // terminal, and with nothing picked yet — the panel was never opened on this page — the service's own
                // choice. An empty mode was sent then, and refused (2026-10-11: 无法继续「你好」：mode: Invalid option).
                let picked = TerminalListText.modes.contains { $0.id == pickedMode } ? pickedMode : nil
                var body = ResumeTerminalRequest(harness: session.harness, cwd: session.cwd, agentSessionId: session.sessionId,
                                                 title: session.title.isEmpty ? nil : session.title, mode: session.mode ?? picked,
                                                 cols: gridHere?.cols, rows: gridHere?.rows, profile: profile)
                var first: (cwd: String, alike: [String], near: String?)?
                while true {
                    switch try await c.resumeTerminal(body) {
                    case .started(let terminal):
                        unfold(terminal.cwd)
                        await refresh()
                        return select(terminal.id, loading: "Opening 「\(name)」")
                    case .existing(let terminal):
                        unfold(terminal.cwd)
                        await refresh()
                        return select(terminal.id)
                    case .elsewhere(let app, _):
                        let app = app ?? "其他程序"
                        let answer = await ask(TerminalSheet(title: "「\(name)」正在 \(app) 中运行",
                                                             body: "同一会话同时只能由一个程序写入，否则记录会分叉。请先在 \(app) 中退出该会话后再继续，或创建分支：新会话包含全部历史，原会话保持不变。",
                                                             confirm: "Fork"))
                        guard answer.ok, body.fork != true else { return left() }
                        body = body.forking()
                    case .folderGone(let cwd, let alike, let near):
                        let was = first ?? (cwd, alike, near)
                        first = was
                        let again = cwd != was.cwd
                        let offers = was.alike + (was.near.map { [$0] } ?? [])
                        let answer = await ask(TerminalSheet(title: "「\(name)」的文件夹已不存在",
                                                             body: "这段会话原来在 \(TerminalTree.tilde(was.cwd))，该文件夹可能已被移动、改名或删除。\(again ? "所选的 \(TerminalTree.tilde(cwd)) 也不存在。" : "")请选择一个文件夹，会话将在那里继续。",
                                                             confirm: "Resume", offers: offers), folder: again ? cwd : was.alike.first ?? "")
                        guard answer.ok, !answer.folder.isEmpty else { return left() }
                        body = body.continuing(in: answer.folder)
                    }
                }
            } catch {
                say("无法继续「\(name)」：\(Self.reason(error))")
                left()
            }
        }
    }

    /// Going on was left or failed: the pane shows what it held, else the first terminal, else the panel.
    private func left() {
        focused?.say(nil)
        if TerminalPanes.pane(layout, focusPane)?.term != nil || many { return focus(pane: focusPane, force: true) }
        if let first = order.first(where: here) { select(first) } else { showCreate() }
    }

    // MARK: names, closing, deleting

    func startRename(_ id: String) {
        guard let terminal = terminal(id) else { return }
        renameText = terminal.name
        renaming = id
        renameFocus += 1
    }

    func finishRename(save: Bool) {
        guard let id = renaming else { return }
        renaming = nil
        let name = renameText
        onFocusScreen(focusPane)
        guard save, let terminal = terminal(id), name.trimmingCharacters(in: .whitespacesAndNewlines) != terminal.name else { return }
        let c = client()
        Task {
            do {
                try await c.renameTerminal(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : name)
                await refresh()
            } catch {
                say(Self.reason(error))
            }
        }
    }

    /// Closing a terminal ends its program and takes it off the list; the agent's own record stays, so the session can
    /// be continued later. An ended one goes at once; a running one asks first.
    func close(_ terminal: TerminalInfo) {
        let c = client()
        Task {
            var record = false
            if terminal.running {
                // Only a record this terminal started can go with it; one it went on writing is the user's own session.
                let own = terminal.agentSessionId != nil && terminal.harness == "claude-code" && (terminal.resumedFrom == nil || terminal.forked)
                let answer = await ask(TerminalSheet(title: "关闭「\(terminal.name)」？",
                                                     body: TerminalKind.isAgent(terminal.harness) ? "将结束 \(TerminalListText.agentName(terminal.harness)) 进程。会话记录保留，可稍后继续。"
                                                                                                  : "将结束这个 Shell，以及其中仍在运行的程序。",
                                                     confirm: "Close", destructive: true, check: own ? "同时删除会话记录（无法恢复）" : nil))
                guard answer.ok else { return onFocusScreen(focusPane) }
                record = answer.checked
            }
            do { try await c.closeTerminal(id: terminal.id, deleteRecord: record) } catch { say(Self.reason(error)) }
            await refresh()
            await refreshSessions()
            afterRemoval()
        }
    }

    /// Among several panes the one whose terminal went has closed; one pane alone shows the next terminal, or the panel.
    func afterRemoval() {
        guard !creating else { return }
        if many || current != nil { return onFocusScreen(focusPane) }
        if let next = order.first(where: here) { select(next) } else { showCreate() }
    }

    /// Deletes the agent's own record of a session: it leaves the list and cannot be continued again.
    func delete(_ session: SessionSummary) {
        let c = client()
        Task {
            let answer = await ask(TerminalSheet(title: "删除会话「\(session.title.isEmpty ? "无标题" : TerminalListText.brief(session.title, columns: 60))」？",
                                                 body: "将删除 \(TerminalListText.agentName(session.harness)) 保存的会话记录，此操作无法撤销。", confirm: "Delete", destructive: true))
            guard answer.ok else { return }
            do {
                try await c.deleteSession(harness: session.harness, id: session.sessionId)
                await refreshSessions()
            } catch {
                say(Self.reason(error))
            }
        }
    }

    // MARK: several sessions

    /// The sessions picked that the list still has.
    var pickedSessions: [SessionSummary] { sessions.filter { picked.contains($0.recordID) } }

    /// A folder's own sessions as the list has them now (what a filter hides is not among them).
    func ownSessions(in cwd: String) -> [SessionSummary] {
        TerminalTree.flatten(TerminalTree.filtered(tree, by: filter)).first { $0.folder.cwd == cwd }?.folder.sessions ?? []
    }

    /// `Select`: the list's session rows are picked from, this one first.
    func startSelecting(_ session: SessionSummary) {
        selecting = true
        picked = [session.recordID]
        pickAnchor = session.recordID
    }

    func endSelecting() {
        selecting = false
        picked = []
        pickAnchor = nil
    }

    /// A session's row clicked while picking: in or out; with ⇧, every session row from the one clicked before to it.
    func pick(_ session: SessionSummary, range: Bool = false) {
        let order = rows.compactMap { row -> String? in if case .session(let s, _, _) = row { s.recordID } else { nil } }
        picked = SessionPick.clicked(session.recordID, picked: picked, anchor: pickAnchor, order: order, range: range)
        pickAnchor = session.recordID
    }

    /// A folder is shown in the list with everything under it (`show`), hidden with everything under it (`hide`), or
    /// nothing is said of it any more (`forget`); the list is read again.
    func sessionFolder(_ action: String, _ folder: String) {
        let c = client()
        Task {
            do {
                folders = try await c.sessionFolder(action, folder)
                await refreshSessions()
            } catch { say((error as? DaemonError)?.reason ?? error.localizedDescription) }
        }
    }

    func deletePicked() { delete(pickedSessions) }
    func deleteAll(in cwd: String) { delete(ownSessions(in: cwd)) }

    /// Deletes the agents' own records of these sessions after one question; one in use is left, and said so.
    func delete(_ list: [SessionSummary]) {
        guard let first = list.first else { return }
        let c = client()
        Task {
            // One alone is asked about as one is from its own row.
            let one = TerminalSheet(title: "删除会话「\(first.title.isEmpty ? "无标题" : TerminalListText.brief(first.title, columns: 60))」？",
                                    body: "将删除 \(TerminalListText.agentName(first.harness)) 保存的会话记录，此操作无法撤销。", confirm: "Delete", destructive: true)
            let several = TerminalSheet(title: SessionDeleteWords.title(list.count), body: SessionDeleteWords.body(titles: list.map(\.title)), confirm: "Delete", destructive: true)
            let answer = await ask(list.count == 1 ? one : several)
            guard answer.ok else { return }
            do {
                let removal = try await c.deleteSessions(list)
                endSelecting()
                await refreshSessions()
                // One that went says nothing, as from its own row; one that stayed says why.
                if list.count == 1 { if let error = removal.results.first(where: { $0.outcome != "deleted" })?.error { say(error) } }
                else if let said = SessionDeleteWords.said(removal) { say(said) }
            } catch {
                say(Self.reason(error))
            }
        }
    }

    // MARK: keys

    /// A key of the page's, done; false when it is not for now (nothing to deny, no terminal to close).
    func perform(_ key: TerminalsPageKey) -> Bool {
        switch key {
        case .newTerminal: showCreate()
        case .closeTerminal:
            guard let current else { return true }
            close(current)
        case .toggleList: toggleList()
        case .search: focusSearch()
        case .split(let side): split(side)
        case .zoom: toggleZoom()
        case .toggleView: toggleSimple()
        case .neighbor(let dx, let dy): focusNeighbor(dx: dx, dy: dy)
        case .select(let number):
            guard order.indices.contains(number - 1) else { return true }
            select(order[number - 1])
        case .start: start()
        case .cancelCreate: cancelCreate()
        case .item: return false
        }
        return true
    }
}
