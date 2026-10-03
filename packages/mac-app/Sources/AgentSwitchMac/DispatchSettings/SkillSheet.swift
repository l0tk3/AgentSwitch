import AgentSwitchMacCore
import SwiftUI

/// `+ New Skill…` / `Edit…` (the web's skill form): the folder's name, its SKILL.md and who gets it. The daemon adds the
/// frontmatter's name and description when they are missing. An existing skill can be deleted here too.
struct SkillSheet: View {
    /// The skill to edit; nil: a new one.
    let name: String?
    /// After a save or a delete: the page reads the list again.
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @Environment(\.dismiss) private var dismiss
    @State private var draft = DispatchSkillDraft()
    /// The skill as read (editing): Save stays off until something changed, and until it is read at all (a SKILL.md
    /// never read is not written over).
    @State private var original: DispatchSkillDraft?
    @State private var loading = false
    @State private var saving = false
    @State private var problem: String?
    @State private var confirmDelete = false

    /// The skills there are: a new one may not take one of their names.
    let existing: Set<String>

    init(name: String?, existing: Set<String>, done: @escaping () -> Void) {
        self.name = name
        self.existing = existing
        self.done = done
    }

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }
    /// Editing a skill whose SKILL.md was not read (still loading, or failed).
    private var unread: Bool { name != nil && original == nil }

    static let size = CGSize(width: 560, height: 540)

    var body: some View {
        let problems = draft.problems(existing: existing)
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: $draft.name, prompt: Text("release-notes"))
                        .font(.system(size: 12.5, design: .monospaced))
                        .disabled(name != nil)
                    LabeledContent("Executors") { SettingsHarnessCheckboxes(selection: $draft.harnesses) }
                } header: {
                    SectionLabel(name == nil ? "New Skill" : "Skill")
                } footer: {
                    Footer("名称即文件夹名，仅可使用小写字母、数字、- 和 _。")
                }
                Section {
                    SettingsTextEditor(text: $draft.content, fontSize: 12, editable: !unread)
                        .frame(height: 220)
                        .overlay {
                            if loading { ProgressView().controlSize(.small) }
                        }
                } header: {
                    SectionLabel("SKILL.md")
                } footer: {
                    Footer("执行器按此说明操作。未写 frontmatter 时，保存时自动补充 name 与 description。")
                }
                if draft != (original ?? DispatchSkillDraft()) && !problems.isEmpty {
                    Section { ForEach(problems, id: \.self) { SettingsNoteLine(text: $0) } }
                }
                if let problem {
                    Section { SettingsProblemLine(text: problem) }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack(spacing: 10) {
                if name != nil {
                    SettingsDeleteButton("Delete…") { confirmDelete = true }
                        .disabled(saving || loading)
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!problems.isEmpty || saving || unread || draft == original)
            }
            .padding(16)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .tint(.brand)
        .task { await load() }
        .confirmationDialog("删除 skill \(draft.name)？", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text(ExtensionRemoval.skill(draft.name).detail)
        }
    }

    private func load() async {
        guard let name, original == nil else { return }
        loading = true
        defer { loading = false }
        do {
            let detail = try await source.service.skill(name: name)
            let read = DispatchSkillDraft(name: detail.skill.name, content: detail.content, harnesses: detail.skill.harnesses, isNew: false)
            (draft, original) = (read, read)
        } catch {
            draft.name = name
            problem = DispatchSettingsProblem.text(error)
        }
    }

    private func save() async {
        guard !unread else { return }
        saving = true
        defer { saving = false }
        do {
            // A new skill's name taken meanwhile (another window, the web console): not written over.
            if draft.isNew, try await source.service.skills().contains(where: { $0.name == draft.trimmedName }) {
                problem = DispatchSkillDraft.nameTaken
                return
            }
            _ = try await source.service.saveSkill(name: draft.trimmedName, draft.update)
            done()
            dismiss()
        } catch {
            problem = "未保存：" + DispatchSettingsProblem.text(error)
        }
    }

    private func delete() async {
        saving = true
        defer { saving = false }
        do {
            try await source.service.deleteSkill(name: draft.trimmedName)
            done()
            dismiss()
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
    }
}

/// `Import…`: the skills in the user's own agent folders (~/.claude/skills, ~/.codex/skills…) not yet imported, each
/// copied in by its `Import` button.
struct SkillImportSheet: View {
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @Environment(\.dismiss) private var dismiss
    @State private var found: [DispatchDiscoveredSkill]?
    @State private var imported: Set<String> = []
    @State private var working: String?
    @State private var problem: String?

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }

    static let size = CGSize(width: 560, height: 440)

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    if let found {
                        let shown = found.filter { !$0.installed }
                        if shown.isEmpty { Text("No Skills to Import").foregroundStyle(.secondary) }
                        ForEach(shown) { skill in row(skill) }
                    } else if problem == nil {
                        ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                    }
                } header: {
                    SectionLabel("Import Skills")
                } footer: {
                    Footer("本机 agent 文件夹中的 skill（~/.claude/skills、~/.codex/skills 等）。导入时复制整个文件夹，已导入的不再列出。")
                }
                if let problem {
                    Section { SettingsProblemLine(text: problem) }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .tint(.brand)
        .task {
            do { found = try await source.service.discoverSkills() } catch { problem = DispatchSettingsProblem.text(error) }
        }
    }

    private func row(_ skill: DispatchDiscoveredSkill) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(skill.name).mono(12.5)
                    Text(skill.source).mono(11).foregroundStyle(.secondary)
                }
                if !skill.description.isEmpty {
                    Text(skill.description).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(skill.path)
            if imported.contains(skill.path) {
                Text("Imported").mono(12).foregroundStyle(Color.ok)
            } else {
                Button("Import") { Task { await importSkill(skill) } }
                    .disabled(working != nil)
            }
        }
    }

    private func importSkill(_ skill: DispatchDiscoveredSkill) async {
        working = skill.path
        defer { working = nil }
        do {
            _ = try await source.service.importSkill(path: skill.path)
            imported.insert(skill.path)
            problem = nil
            done()
        } catch {
            problem = DispatchSettingsProblem.text(error)
        }
    }
}
