import AgentSwitchMacCore
import SwiftUI

/// Context (docs/dispatch-v0.md §3; demo `mac-window.html?set=context`): context.md, which the dispatch model reads before
/// every task (saved through the sealer, as the phone does); memory.md, the facts it kept from results; and the platform
/// experience, deleted one by one. `Save` (⌘S) saves whichever file changed.
struct ContextSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(SettingsNavigation.self) private var navigation
    @Environment(\.dispatchSettings) private var dispatch
    @State private var removing: DispatchPlatformMemory?

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }

    var body: some View {
        let store = navigation.context
        DispatchSettingsGate {
            if store.loaded || store.loadProblem == nil {
                form(store)
            } else if let problem = store.loadProblem {
                EmptyPage(title: "Context: Unavailable", symbol: "exclamationmark.triangle", message: problem) {
                    Button("Retry") { Task { await store.load(source.service) } }
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { Task { await store.load(source.service) } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Reload")
                    .disabled(!source.ready || store.saving)
                Button { Task { await store.save(source.service) } } label: {
                    Text(store.saving ? "Saving" : "Save")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("s", modifiers: .command)
                .help("Save ⌘S")
                .disabled(!source.ready || !store.dirty || store.saving)
            }
        }
        .task(id: source.ready) {
            if source.ready { await store.load(source.service) }
        }
        .confirmationDialog("删除这条经验？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            presenting: removing) { record in
            Button("Delete", role: .destructive) { Task { await store.deleteExperience(id: record.id, source.service) } }
        } message: { _ in
            Text("删除后，后续任务不再参考此经验，且无法恢复。")
        }
    }

    private func form(_ store: ContextSettingsStore) -> some View {
        @Bindable var store = store
        return Form {
            if let problem = store.saveProblem {
                Section { SettingsProblemLine(text: problem) }
            }
            Section {
                // Not before the files are read: nothing typed is laid over by them.
                SettingsTextEditor(text: $store.contextText, editable: store.loaded && !store.saving)
                    .frame(height: 172)
                    .overlay(alignment: .topLeading) {
                        if store.contextText.isEmpty && store.loaded {
                            Text("站点与账号、环境限制、各项目偏好的执行器…").mono(12.5).foregroundStyle(.tertiary)
                                .padding(.top, 4).padding(.leading, 5).allowsHitTesting(false)
                        }
                    }
            } header: {
                SectionLabel("context.md")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Footer("调度模型每次调度前读取：站点、账号、环境限制与偏好。保存时，明文凭据替换为密文。")
                        Text(DispatchFileSize.ofContextLimit(store.contextText))
                            .mono(11)
                            .foregroundStyle(DispatchFileSize.exceedsContextLimit(store.contextText) ? Color.failed : Color.secondary)
                            .fixedSize()
                            .help("超出 64 KB 的部分在读取时截断")
                    }
                    if store.contextText.isEmpty && store.loaded {
                        Button("Load Example") { Task { await store.loadExample(source.service) } }
                            .controlSize(.small)
                    }
                }
            }
            contextNotes(store)
            Section {
                SettingsTextEditor(text: $store.memoryText, editable: store.loaded && !store.saving)
                    .frame(height: 84)
            } header: {
                SectionLabel("memory.md")
            } footer: {
                Footer("调度模型从执行结果中提取的长期事实，注明来源任务；有误的行可直接删除。")
            }
            if let result = store.memoryResult, !store.memoryDirty, !result.warnings.isEmpty {
                Section { SettingsNoteLine(text: "已移除 \(result.warnings.count) 行疑似明文凭据。") }
            } else if !store.memoryWarnings.isEmpty {
                Section { SettingsNoteLine(text: "读取时已移除 \(store.memoryWarnings.count) 行疑似明文凭据，调度模型无法读取这些行。") }
            }
            experience(store)
        }
        .formStyle(.grouped)
    }

    /// After a save: what was sealed and which lines were dropped; before: lines the daemon dropped when it read the file.
    @ViewBuilder
    private func contextNotes(_ store: ContextSettingsStore) -> some View {
        if let result = store.contextResult, !store.contextDirty {
            Section {
                Label(result.savedLine, systemImage: "checkmark.circle.fill").foregroundStyle(Color.ok)
                ForEach(Array(result.sealed.enumerated()), id: \.offset) { _, field in
                    HStack(spacing: 8) {
                        Image(systemName: "lock").foregroundStyle(.secondary).frame(width: 16)
                        Text(field.field.isEmpty ? field.label : field.field)
                        Text(([field.label] + field.hosts).filter { !$0.isEmpty && $0 != field.field }.joined(separator: " · "))
                            .mono(11).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }
                ForEach(result.warnings, id: \.self) { line in
                    Text(line).mono(11).foregroundStyle(Color.waiting).lineLimit(2).textSelection(.enabled)
                }
            } footer: {
                if !result.warnings.isEmpty { Footer("以上行疑似明文凭据且无法加密，已移除。") }
            }
        } else if !store.contextWarnings.isEmpty {
            Section {
                SettingsNoteLine(text: "读取时已移除 \(store.contextWarnings.count) 行疑似明文凭据，调度模型无法读取这些行：")
                ForEach(store.contextWarnings, id: \.self) { line in
                    Text(line).mono(11).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
                }
            }
        }
    }

    private func experience(_ store: ContextSettingsStore) -> some View {
        Section {
            if let problem = store.experienceProblem {
                SettingsProblemLine(text: problem)
            }
            if let records = store.experience {
                if records.isEmpty {
                    Text("No Experience").foregroundStyle(.secondary)
                }
                ForEach(records) { record in
                    ExperienceRow(record: record, deleting: store.deleting.contains(record.id),
                                  openSource: { dispatch.openTask(record.sourceTaskId) }, delete: { removing = record })
                }
            } else if store.experienceProblem == nil {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            }
        } header: {
            SectionLabel("Experience")
        } footer: {
            Footer("执行器在具体网站上获得的经验，附来源与有效期；过期的经验不再用于后续任务，也不代表操作授权。")
        }
    }
}

/// One platform observation: its state as a square and a word, what was learned, then the site, the kind, the source
/// task and how long it holds; `Delete` asks first.
private struct ExperienceRow: View {
    let record: DispatchPlatformMemory
    let deleting: Bool
    let openSource: () -> Void
    let delete: () -> Void

    var body: some View {
        let word = record.stateWord()
        HStack(alignment: .center, spacing: 10) {
            mark(word)
            Text(word).mono(12).frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(record.text).lineLimit(3).textSelection(.enabled)
                HStack(spacing: 0) {
                    Text(meta(word)).mono(10.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if !record.sourceTaskId.isEmpty {
                        Text(" · ").mono(10.5).foregroundStyle(.secondary)
                        Button(action: openSource) { Text("Task \(record.sourceTaskId.prefix(8))").mono(10.5).underline() }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .help(record.sourceQuote.isEmpty ? "Open Task" : record.sourceQuote)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            SettingsDeleteButton("Delete", action: delete)
                .disabled(deleting)
        }
        .opacity(word == "Expired" ? 0.7 : 1)
        .padding(.vertical, 2)
        .contextMenu {
            if !record.sourceTaskId.isEmpty { Button("Open Source Task", systemImage: "arrow.up.right.square", action: openSource) }
            Button("Delete", systemImage: "trash", role: .destructive, action: delete)
        }
    }

    /// Verified: a green square; Pending: an amber hollow one; Expired: a faint hollow one.
    @ViewBuilder
    private func mark(_ word: String) -> some View {
        switch word {
        case "Verified": PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
        case "Pending": PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .waiting)
        default: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
        }
    }

    /// `fin.example.com · Operation · Until 10/30`.
    private func meta(_ word: String) -> String {
        let site = URL(string: record.origin)?.host ?? record.origin
        let until = (word == "Expired" ? "Expired " : "Until ") + TimeText.day(record.expires)
        return [site, record.kindWord, until].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
