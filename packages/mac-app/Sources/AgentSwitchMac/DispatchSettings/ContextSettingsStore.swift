import AgentSwitchMacCore
import Foundation
import Observation

/// Context's files and experience (docs/dispatch-v0.md §3; the phone's ContextEditorView, the web's Context page).
/// Held by the settings window (`SettingsNavigation.context`), not by the page: edits not yet saved survive the window
/// closing, and the window asks before another page opens over them.
///
/// context.md is saved as a task is sent (router-v0 §9): the sealer marks the credentials, the daemon stores tokens and
/// drops credential-looking plaintext it could not seal; what was kept is read back into the editor. memory.md gets the
/// same lint without the sealer.
@MainActor
@Observable
final class ContextSettingsStore {
    var contextText = ""
    var memoryText = ""
    /// The files as last read; nil until the first read succeeds (nothing can be saved before).
    private(set) var storedContext: String?
    private(set) var storedMemory: String?
    /// Lines the daemon dropped when it read context.md (plaintext that looked like a credential).
    private(set) var contextWarnings: [String] = []
    private(set) var memoryWarnings: [String] = []
    private(set) var loadProblem: String?

    private(set) var saving = false
    /// What the last save of each file said: sealed fields, lines removed.
    private(set) var contextResult: DispatchSaveResult?
    private(set) var memoryResult: DispatchSaveResult?
    private(set) var saveProblem: String?

    /// Platform experience; nil until read.
    private(set) var experience: [DispatchPlatformMemory]?
    private(set) var experienceProblem: String?
    private(set) var deleting: Set<String> = []

    var contextDirty: Bool { storedContext.map { $0 != contextText } ?? false }
    var memoryDirty: Bool { storedMemory.map { $0 != memoryText } ?? false }
    var dirty: Bool { contextDirty || memoryDirty }
    var loaded: Bool { storedContext != nil }

    /// The files whose edits are not saved, for the question before leaving.
    var dirtyFiles: [String] { (contextDirty ? ["context.md"] : []) + (memoryDirty ? ["memory.md"] : []) }

    // MARK: reading

    /// Both files and the experience. Edits not yet saved stay in the editors.
    func load(_ service: any DispatchService) async {
        do {
            async let context = service.context()
            async let memory = service.memory()
            let (c, m) = try await (context, memory)
            // Edits not saved stay; so does anything typed before the first read (then it is an edit of the file).
            if !contextDirty && (storedContext != nil || contextText.isEmpty) { contextText = c.text }
            if !memoryDirty && (storedMemory != nil || memoryText.isEmpty) { memoryText = m.text }
            storedContext = c.text
            storedMemory = m.text
            contextWarnings = c.warnings
            memoryWarnings = m.warnings
            loadProblem = nil
        } catch {
            loadProblem = DispatchSettingsProblem.text(error)
        }
        await loadExperience(service)
    }

    func loadExperience(_ service: any DispatchService) async {
        do {
            experience = try await service.platformMemory()
            experienceProblem = nil
        } catch {
            experienceProblem = DispatchSettingsProblem.text(error)
        }
    }

    /// `Load Example`: the daemon's template in the empty editor.
    func loadExample(_ service: any DispatchService) async {
        do {
            contextText = try await service.contextExample()
            saveProblem = nil
        } catch {
            saveProblem = DispatchSettingsProblem.text(error)
        }
    }

    // MARK: changing

    /// Saves each file that changed; true when every one was taken. context.md may wait for the sealer.
    @discardableResult
    func save(_ service: any DispatchService) async -> Bool {
        guard dirty, !saving else { return !dirty }
        saving = true
        defer { saving = false }
        var problems: [String] = []
        if contextDirty {
            do {
                contextResult = try await service.saveContext(contextText)
                let kept = try await service.context()   // what the daemon kept, after sealing and the lint
                (contextText, storedContext, contextWarnings) = (kept.text, kept.text, kept.warnings)
            } catch {
                problems.append("context.md 未保存：" + DispatchSettingsProblem.text(error))
            }
        }
        if memoryDirty {
            do {
                memoryResult = try await service.saveMemory(memoryText)
                let kept = try await service.memory()
                (memoryText, storedMemory, memoryWarnings) = (kept.text, kept.text, kept.warnings)
            } catch {
                problems.append("memory.md 未保存：" + DispatchSettingsProblem.text(error))
            }
        }
        saveProblem = problems.isEmpty ? nil : problems.joined(separator: "\n")
        return problems.isEmpty
    }

    /// `Don't Save`: the editors back to the files as last read.
    func revert() {
        contextText = storedContext ?? ""
        memoryText = storedMemory ?? ""
        saveProblem = nil
    }

    func deleteExperience(id: String, _ service: any DispatchService) async {
        deleting.insert(id)
        defer { deleting.remove(id) }
        do {
            try await service.deletePlatformMemory(id: id)
            experience = experience?.filter { $0.id != id }
            experienceProblem = nil
        } catch {
            experienceProblem = DispatchSettingsProblem.text(error)
        }
    }
}
