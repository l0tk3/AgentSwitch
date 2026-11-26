import AgentSwitchMacCore
import AppKit
import SwiftUI

/// Settings › Dispatch (the new one, 2026-11-24, design-dispatch-admin.md §7): which agent, profile and model run as
/// the dispatch, the permission mode it and the sessions it starts run in, how many sessions it may start, its
/// working instructions, and a new one in its place. Saved, it runs: started, or the same conversation resumed.
struct DispatchDeskView: View {
    @Environment(AppModel.self) private var model
    @State private var desk: DispatchDesk?
    @State private var draft: DispatchDesk.Settings?
    @State private var models: RoomModels?
    @State private var problem: String?
    @State private var saving = false
    @State private var editing = false

    private static let agents: [(String, String)] = [("claude-code", "Claude Code"), ("codex", "Codex"), ("opencode", "OpenCode"), ("pi", "pi"), ("grok", "Grok"), ("agy", "Antigravity")]

    var body: some View {
        Form {
            if let draft, let desk {
                Section {
                    Toggle("Dispatch", isOn: binding(\.on))
                    LabeledContent("Status") { Text(desk.state).foregroundStyle(desk.problem == nil ? Color.secondary : Color.red).textSelection(.enabled) }
                } header: {
                    SectionLabel("Dispatch")
                } footer: {
                    Footer("调度是一个普通会话，在「调度台」房间里等你说话：你说要做什么，它开房间、拉人或开新会话、写任务表、向你汇报。它不写代码。打开后一直在，结束了会自动恢复成同一个对话。")
                }
                Section {
                    Picker("Agent", selection: Binding(get: { draft.agent }, set: { v in update { $0.agent = v; $0.profile = nil; $0.model = nil } })) {
                        ForEach(Self.agents, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Picker("Profile", selection: Binding(get: { draft.profile ?? "" }, set: { v in update { $0.profile = v.isEmpty ? nil : v; $0.model = nil } })) {
                        Text("Current").tag("")
                        ForEach(profiles, id: \.id) { Text($0.elsewhere ? "\($0.name) · \($0.host ?? "")" : $0.name).tag($0.id) }
                    }
                    Picker("Model", selection: Binding(get: { draft.model ?? "" }, set: { v in update { $0.model = v.isEmpty ? nil : v } })) {
                        Text("Default").tag("")
                        ForEach(modelChoices) { Text($0.name).tag($0.id) }
                    }
                } header: {
                    SectionLabel("Who Dispatches")
                } footer: {
                    Footer("换了 agent、配置或模型，保存后正在跑的调度不受影响；点「Replace」让它先写交接，再按新的设置开一个新的。")
                }
                Section {
                    Picker("Permissions", selection: binding(\.mode)) {
                        Text("Bypass").tag("bypass")
                        Text("Auto").tag("auto")
                        Text("Ask").tag("manual")
                    }
                    Stepper("Sessions It May Start: \(draft.maxStarted)", value: binding(\.maxStarted), in: 1...16)
                } header: {
                    SectionLabel("What It May Do")
                } footer: {
                    Footer("权限模式同时用于调度自己和它开的会话。它开出来、还在房间里的会话不超过这个数。哪些模型能用，在聊天室的 Models 里按配置管。")
                }
                Section {
                    LabeledContent("Folder") { Text(model.shortPath(desk.folder)).lineLimit(1).truncationMode(.middle).textSelection(.enabled).help(desk.folder) }
                    HStack {
                        Button("Edit Instructions…") { editing = true }
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: desk.instructions)]) }
                        Spacer()
                        Button("Replace…") { replace() }.disabled(!desk.settings.on || desk.replacing || saving)
                            .help("旧调度先把交接写进 handoff.md，再按现在的设置开一个新的调度，从交接开始。")
                    }
                } header: {
                    SectionLabel("Instructions")
                } footer: {
                    Footer("工作说明是调度文件夹里的 AGENTS.md：它的职责、什么事必须先问你。改了下次叫醒它时生效。")
                }
                if let problem { Text(problem).foregroundStyle(.red).textSelection(.enabled) }
                HStack {
                    Spacer()
                    Button("Revert") { self.draft = desk.settings }.disabled(draft == desk.settings || saving)
                    Button("Save") { save() }.keyboardShortcut(.defaultAction).disabled(draft == desk.settings || saving)
                }
            } else {
                Text(problem ?? (model.daemonReady ? "Loading" : "Service Not Ready")).foregroundStyle(problem == nil ? Color.secondary : Color.red)
            }
        }
        .formStyle(.grouped)
        .task(id: model.daemonReady) {
            guard model.daemonReady else { return }
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .sheet(isPresented: $editing) { DispatchInstructionsSheet() }
    }

    private var profiles: [RoomModels.Profile] { models?.agents[draft?.agent ?? ""]?.profiles ?? [] }

    private var modelChoices: [RoomModels.Model] {
        guard let draft, let agent = models?.agents[draft.agent] else { return [] }
        let profile = agent.profiles.first { $0.id == (draft.profile ?? agent.current ?? "default") }
        return (profile?.models(agent) ?? agent.models).filter { !$0.isOlder }
    }

    private func binding<T>(_ path: WritableKeyPath<DispatchDesk.Settings, T>) -> Binding<T> {
        Binding(get: { draft![keyPath: path] }, set: { v in update { $0[keyPath: path] = v } })
    }

    private func update(_ change: (inout DispatchDesk.Settings) -> Void) {
        guard var next = draft else { return }
        change(&next)
        draft = next
    }

    private func load() async {
        do {
            let now = try await model.client.dispatchDesk()
            // What the user is changing stays as it is while the page is read again.
            if draft == nil || draft == desk?.settings { draft = now.settings }
            desk = now
            if models == nil { models = try? await model.client.roomModels() }
            if problem != nil, !saving { problem = nil }
        } catch {
            problem = (error as? DaemonError)?.reason ?? error.localizedDescription
        }
    }

    private func save() {
        guard let draft else { return }
        saving = true
        Task {
            defer { saving = false }
            do { desk = try await model.client.setDispatchDesk(draft); self.draft = desk?.settings; problem = nil }
            catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }

    private func replace() {
        Task {
            do { try await model.client.replaceDispatch(); await load() }
            catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }
}

/// The dispatch's working instructions (`AGENTS.md` in its folder), edited in place.
private struct DispatchInstructionsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var loaded = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Dispatch Instructions").font(.headline)
            TextEditor(text: $text).font(.system(size: 12.5, design: .monospaced)).frame(minWidth: 620, minHeight: 420).disabled(!loaded)
            if let problem { Text(problem).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") {
                    Task {
                        do { try await model.client.setDispatchInstructions(text); dismiss() }
                        catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
                    }
                }
                .keyboardShortcut(.defaultAction).disabled(!loaded)
            }
        }
        .padding(18)
        .task {
            do { text = try await model.client.dispatchInstructions(); loaded = true }
            catch { problem = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }
}
