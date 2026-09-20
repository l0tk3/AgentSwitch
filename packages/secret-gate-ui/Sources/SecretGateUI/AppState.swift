import Foundation
import SecretGateCore
import SwiftUI

/// All mutable UI state. Every mutation replaces whole values (no in-place edits of entries).
@MainActor
final class AppState: ObservableObject {
    @AppStorage("cliPath") var cliPath: String = GateCLI.defaultExecutable().path
    @AppStorage("gateHome") var gateHome: String = GateCLI.defaultHome().path

    @Published private(set) var keys: [Keypair] = []
    @Published var entries: [TokenEntry] = [TokenEntry()]
    @Published private(set) var results: [TokenResult] = []
    @Published private(set) var busy = false
    @Published var errorMessage: String?

    var current: Keypair? { keys.first(where: \.current) }

    private var cli: GateCLI {
        GateCLI(executable: URL(fileURLWithPath: cliPath), home: URL(fileURLWithPath: gateHome))
    }

    // MARK: keypairs

    func refreshKeys() { let cli = cli; perform { try cli.listKeys() } assign: { self.keys = $0 } }

    func createKey(named name: String, makeCurrent: Bool) {
        let cli = cli
        perform { try cli.newKey(named: name, makeCurrent: makeCurrent) } assign: { self.keys = $0 }
    }

    func useKey(_ key: Keypair) { let cli = cli; perform { try cli.useKey(named: key.name) } assign: { self.keys = $0 } }

    // MARK: entries

    func addEntry() { entries = entries + [TokenEntry()] }

    func update(_ entry: TokenEntry) {
        entries = entries.map { $0.id == entry.id ? entry : $0 }
    }

    func remove(_ entry: TokenEntry) {
        entries = entries.filter { $0.id != entry.id }
        if entries.isEmpty { entries = [TokenEntry()] }
    }

    func importCSV(_ text: String) {
        let imported = CSVImport.parse(text)
        guard !imported.isEmpty else { errorMessage = "没有解析到任何行。格式：label, host1|host2, [kind,] value"; return }
        entries = entries.filter { $0.problem == nil } + imported
    }

    // MARK: encryption

    var readyEntries: [TokenEntry] { entries.filter { $0.problem == nil } }

    func encryptAll() {
        let batch = readyEntries
        guard !batch.isEmpty else { errorMessage = "没有可生成的行"; return }
        let cli = cli
        perform { try cli.encrypt(batch) } assign: { results in
            self.results = results
            // Drop the plaintext of everything that succeeded; keep failed rows for correction.
            let okLabels = Set(results.filter(\.ok).compactMap(\.label))
            self.entries = self.entries.map { okLabels.contains($0.label) ? $0.with(value: "") : $0 }
        }
    }

    func clearResults() { results = [] }

    // MARK: plumbing

    private func perform<T: Sendable>(_ work: @escaping @Sendable () throws -> T, assign: @escaping (T) -> Void) {
        busy = true
        Task {
            do {
                let value = try await Task.detached(priority: .userInitiated) { try work() }.value
                assign(value)
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }
}
