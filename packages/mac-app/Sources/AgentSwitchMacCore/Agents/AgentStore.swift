import Foundation

/// AgentSwitch's own versions of the agents (docs/agents-v0.md §2, §5–§7): betas and pinned versions under
/// `~/.local/share/agentswitch/cli`, apart from each vendor's own install. A version is a folder — the program, what it
/// needs beside it, and a launcher that starts it with its own updater off — put in place only after the download
/// matched the vendor's digest, the program carries the vendor's signature and says the version asked for. Nothing here
/// depends on the app: what is in the store goes on working without it, and can be deleted as a whole.
public struct AgentStore: Sendable {
    public let layout: AgentLayout
    public var platform: AgentPlatform = .current
    /// What the launched checks run with (`HOME`, `PATH`, …).
    public var environment: [String: String]
    public var fetch: AgentReleases.Fetch = AgentReleases.fetch
    public var download: AgentTransfer.Download = AgentTransfer.download
    /// The version a program says (`--version`), under the given extra variables.
    public var versionOf: @Sendable (String, [String: String]) async -> String?
    /// The team whose signature a program carries; nil when unsigned or the signature does not hold.
    public var signer: @Sendable (String) async -> String?
    /// What is running now, each process's whole command line (a program started by `node` is told by its arguments).
    public var runningPrograms: @Sendable () async -> [String]
    /// The operation's log (AgentLog): what was downloaded, what it was checked against, where it went.
    public var log: @Sendable (String) -> Void = { _ in }

    /// Who signs each vendor's releases (measured 2026-10-06 on the stable and the test builds alike).
    public static let teams: [AgentCLI: String] = [.claude: "Q6L2SF6YDW", .codex: "2DC432GLL2", .opencode: "5NZ4Q7NXJ4"]

    public enum Phase: Sendable, Equatable {
        case resolving
        case downloading(received: Int64, total: Int64?)
        case verifying, unpacking, checking
        /// The vendor's own installer or updater at work on the vendor's own install (AgentNative).
        case installing, updating, removing
    }

    public init(layout: AgentLayout, environment: [String: String]) {
        self.layout = layout
        self.environment = environment
        let env = environment
        versionOf = { program, extra in
            let result = try? await ProcessRunner.run(URL(fileURLWithPath: program), ["--version"], environment: env.merging(extra) { _, new in new }, timeout: 30)
            return result.flatMap { HarnessEvaluator.parseVersion($0.stdoutText + $0.stderrText) }
        }
        signer = { program in await AgentStore.team(of: program) }
        runningPrograms = { await AgentStore.processes() }
    }

    // MARK: installing

    /// Downloads `version` of `agent` into the store as its beta or as a pinned version. The beta replaces the one
    /// before it and takes the `*-beta` name on the command line. Whatever fails, nothing half-made stays.
    @discardableResult
    public func install(_ agent: AgentCLI, _ source: AgentSource, version: String,
                        report: @escaping @Sendable (Phase) -> Void = { _ in }) async throws -> AgentInstall {
        guard source == .beta || source == .pinned, agent.betaCommand != nil else { throw AgentError("\(agent.title) 不能安装到版本库。") }
        guard AgentVersion.isWellFormed(version) else { throw AgentError("“\(version)”不是一个版本号。") }
        let fm = FileManager.default
        report(.resolving)
        let artifact = try await AgentArtifacts.resolve(agent, version: version, platform: platform, fetch: fetch)
        log("download \(artifact.url.absoluteString) \(artifact.digest)")

        let job = try AgentStore.jobFolder(layout)
        defer {
            try? fm.removeItem(atPath: job)
            AgentStore.tidy(layout)
        }
        let file = URL(fileURLWithPath: "\(job)/download")
        report(.downloading(received: 0, total: artifact.size))
        try await download(artifact.url, file) { received, total in report(.downloading(received: received, total: total ?? artifact.size)) }
        try Task.checkCancellation()

        report(.verifying)
        let size = (try? fm.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value
        guard artifact.size == nil || artifact.size == size, try artifact.digest.matches(file: file) else {
            throw AgentError("下载的文件与官方校验值不符，已丢弃。未做任何更改。")
        }

        report(.unpacking)
        let tree = "\(job)/tree"
        try fm.createDirectory(atPath: tree, withIntermediateDirectories: true)
        switch artifact.kind {
        case .program(let name):
            try fm.moveItem(atPath: file.path, toPath: "\(tree)/\(name)")
        case .tree:
            try await AgentStore.unpack(file.path, into: tree)
        case .packed(let path, let name):
            let unpacked = "\(job)/unpacked"
            try fm.createDirectory(atPath: unpacked, withIntermediateDirectories: true)
            try await AgentStore.unpack(file.path, into: unpacked)
            try fm.moveItem(atPath: "\(unpacked)/\(path)", toPath: "\(tree)/\(name)")
        }
        let staged = "\(tree)/\(artifact.program)"
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: staged, isDirectory: &isDirectory), !isDirectory.boolValue else { throw AgentError("发布文件里没有 \(agent.title) 的程序。") }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: staged)

        report(.checking)
        if let team = AgentStore.teams[agent] {
            guard await signer(staged) == team else { throw AgentError("下载的程序没有 \(agent.title) 发行方的签名，已丢弃。") }
        }
        let said = await versionOf(staged, agent.noSelfUpdate)
        log("checked: digest matches, signed by \(AgentStore.teams[agent] ?? "-"), says \(said ?? "nothing")")
        guard let said, AgentVersion(said) == AgentVersion(version) else {
            throw AgentError("下载的程序无法运行，或报告的版本不是 \(version)，已丢弃。")
        }
        try Task.checkCancellation()

        // In place: the folder moved whole, its launcher naming where it now is.
        let final = layout.storeVersion(agent, source, version)
        let launcher = "\(tree)/\(AgentLayout.launcherName)"
        try AgentStore.launcherText(agent, source, version: version, program: "\(final)/\(artifact.program)").write(toFile: launcher, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher)
        try fm.createDirectory(atPath: layout.storeFolder(agent, source), withIntermediateDirectories: true)
        if fm.fileExists(atPath: final) { try fm.removeItem(atPath: final) }
        try fm.moveItem(atPath: tree, toPath: final)
        log("in place: \(final)")

        var command: String?
        if source == .beta {
            if linkBeta(agent, to: layout.launcher(agent, .beta, version)) { command = agent.betaCommand }
            await dropOtherBetas(agent, keeping: version)
        }
        return AgentInstall(agent: agent, source: source, key: source == .beta ? "beta" : AgentInstall.pinnedKey(version), binary: layout.launcher(agent, source, version),
                            command: command, location: final, version: version)
    }

    /// The launcher: this copy started with its own updater off, so the vendor's install stays as it is.
    static func launcherText(_ agent: AgentCLI, _ source: AgentSource, version: String, program: String) -> String {
        var lines = ["#!/bin/sh",
                     "# AgentSwitch (docs/agents-v0.md): \(agent.title) \(version), \(source.rawValue). Starts this copy with its own updater off,",
                     "# so the vendor's own install on this Mac stays as it is. Safe to delete with its folder."]
        for (key, value) in agent.noSelfUpdate.sorted(by: { $0.key < $1.key }) { lines.append("\(key)=\(quoted(value)); export \(key)") }
        lines.append("exec \(quoted(program)) \"$@\"")
        return lines.joined(separator: "\n") + "\n"
    }

    /// Single-quoted for `sh`, a quote inside written `'\''`.
    static func quoted(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /// `~/.local/bin/<name>-beta` → the launcher. A name that is taken by something not ours is left alone (false).
    func linkBeta(_ agent: AgentCLI, to launcher: String) -> Bool {
        guard let link = layout.betaCommand(agent) else { return false }
        let fm = FileManager.default
        if (try? fm.attributesOfItem(atPath: link)) != nil {
            guard ownsLink(link) else { return false }
            try? fm.removeItem(atPath: link)
        }
        do {
            try fm.createDirectory(atPath: layout.binDir, withIntermediateDirectories: true)
            try fm.createSymbolicLink(atPath: link, withDestinationPath: launcher)
            return true
        } catch {
            return false
        }
    }

    /// A link that points into the store is one AgentSwitch made.
    func ownsLink(_ link: String) -> Bool {
        guard let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: link) else { return false }
        return destination.hasPrefix(layout.store + "/")
    }

    /// The betas before this one: gone, unless one still runs (the next sweep takes it).
    func dropOtherBetas(_ agent: AgentCLI, keeping version: String) async {
        let fm = FileManager.default
        let folder = layout.storeFolder(agent, .beta)
        let running = await runningPrograms()
        for name in (try? fm.contentsOfDirectory(atPath: folder)) ?? [] where name != version {
            let path = "\(folder)/\(name)"
            if running.contains(where: { AgentStore.runs($0, path) }) { continue }
            try? fm.removeItem(atPath: path)
        }
    }

    // MARK: deleting

    /// Why a stored version cannot be deleted now: a program of it is running. nil when it can.
    public func blocker(_ install: AgentInstall) async -> String? {
        let running = await runningPrograms()
        return running.contains { AgentStore.runs($0, install.location) } ? AgentStore.runningNotice(install) : nil
    }

    /// Deletes a beta or a pinned version: its folder in the store, and the `*-beta` name when it pointed there.
    public func remove(_ install: AgentInstall) async throws {
        guard install.source == .beta || install.source == .pinned, let version = install.version, AgentVersion.isWellFormed(version) else {
            throw AgentError("这一项不在版本库中，不能在这里删除。")
        }
        let folder = layout.storeVersion(install.agent, install.source, version)
        // Only ever a version's folder inside the store, by its real path.
        guard install.location == folder, AgentInventory.inside(folder, layout.storeFolder(install.agent, install.source)),
              AgentInventory.real(folder) != AgentInventory.real(layout.storeFolder(install.agent, install.source)) else {
            throw AgentError("路径不在版本库之内，未删除。")
        }
        if let blocked = await blocker(install) { throw AgentError(blocked) }
        let fm = FileManager.default
        if fm.fileExists(atPath: folder) { try fm.removeItem(atPath: folder) }
        log("removed \(folder)")
        if install.source == .beta, let link = layout.betaCommand(install.agent), ownsLink(link),
           (try? fm.destinationOfSymbolicLink(atPath: link)) == layout.launcher(install.agent, .beta, version) {
            try? fm.removeItem(atPath: link)
        }
        AgentStore.tidy(layout)
    }

    static func runningNotice(_ install: AgentInstall) -> String {
        "\(install.agent.title) \(install.version ?? "") 正在运行。请先关闭使用它的终端或任务。".replacingOccurrences(of: "  ", with: " ")
    }

    // MARK: sweeping

    /// At launch (agents-v0 §6): unfinished downloads go; of each agent's betas only the newest whole one stays; a
    /// `*-beta` name left pointing at nothing goes. Returns what was removed.
    @discardableResult
    public func sweep() async -> [String] {
        let fm = FileManager.default
        var removed: [String] = []
        for name in (try? fm.contentsOfDirectory(atPath: layout.downloads)) ?? [] {
            let path = "\(layout.downloads)/\(name)"
            if (try? fm.removeItem(atPath: path)) != nil { removed.append(path) }
        }
        let running = await runningPrograms()
        for agent in AgentCLI.allCases where agent.betaCommand != nil {
            let folder = layout.storeFolder(agent, .beta)
            let names = (try? fm.contentsOfDirectory(atPath: folder)) ?? []
            let whole = names.filter { AgentVersion.isWellFormed($0) && fm.isExecutableFile(atPath: layout.launcher(agent, .beta, $0)) }
            let keep = whole.max { AgentVersion($0) < AgentVersion($1) }
            for name in names where name != keep {
                let path = "\(folder)/\(name)"
                if running.contains(where: { AgentStore.runs($0, path) }) { continue }
                if (try? fm.removeItem(atPath: path)) != nil { removed.append(path) }
            }
            if let link = layout.betaCommand(agent), ownsLink(link), !fm.fileExists(atPath: link) {
                if (try? fm.removeItem(atPath: link)) != nil { removed.append(link) }
            }
        }
        AgentStore.tidy(layout)
        return removed
    }

    /// A folder of one job's own under `downloads`, for what it downloads and unpacks.
    static func jobFolder(_ layout: AgentLayout) throws -> String {
        let fm = FileManager.default
        let job = "\(layout.downloads)/\(UUID().uuidString)"
        do {
            try fm.createDirectory(atPath: job, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            // Another job ending this instant may have tidied the empty folders above it away.
            try fm.createDirectory(atPath: job, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        return job
    }

    /// Folders of the store that hold nothing are not kept: with no beta, no pinned version and no download under
    /// way there is no store on the disk. `rmdir`, so a folder something was just put in stays.
    static func tidy(_ layout: AgentLayout) {
        var folders = [layout.downloads]
        for agent in AgentCLI.allCases {
            folders += [layout.storeFolder(agent, .beta), layout.storeFolder(agent, .pinned), "\(layout.store)/\(agent.rawValue)"]
        }
        folders.append(layout.store)
        if layout.store.hasSuffix("/agentswitch/cli") { folders.append((layout.store as NSString).deletingLastPathComponent) }
        for folder in folders { rmdir(folder) }
    }

    // MARK: archives, signatures, processes

    /// Unpacks a `tar.gz` whose every entry stays inside `folder`: no absolute path, no `..`, no link leading out.
    static func unpack(_ archive: String, into folder: String) async throws {
        let tar = URL(fileURLWithPath: "/usr/bin/tar")
        let listed = try await ProcessRunner.run(tar, ["-tzf", archive], timeout: 120)
        guard listed.ok else { throw AgentError("发布文件无法读取。") }
        let entries = listed.stdoutText.split(separator: "\n").map(String.init)
        guard !entries.isEmpty, entries.count < 50_000, entries.allSatisfy(AgentStore.safeEntry) else { throw AgentError("发布文件里有不该有的路径，已丢弃。") }
        let result = try await ProcessRunner.run(tar, ["-xzf", archive, "-C", folder], timeout: 300)
        guard result.ok else { throw AgentError("发布文件无法解开。") }
        guard linksStayInside(folder) else { throw AgentError("发布文件里有指向外面的链接，已丢弃。") }
    }

    /// Every link under `folder` leads to something under it.
    static func linksStayInside(_ folder: String) -> Bool {
        let fm = FileManager.default
        let root = AgentInventory.real(folder)
        guard let walk = fm.enumerator(atPath: folder) else { return true }
        while let name = walk.nextObject() as? String {
            let path = "\(folder)/\(name)"
            guard let destination = try? fm.destinationOfSymbolicLink(atPath: path) else { continue }
            let target = destination.hasPrefix("/") ? destination : ((path as NSString).deletingLastPathComponent as NSString).appendingPathComponent(destination)
            let resolved = URL(fileURLWithPath: target).standardizedFileURL.resolvingSymlinksInPath().path
            if resolved != root && !resolved.hasPrefix(root + "/") { return false }
        }
        return true
    }

    /// An entry that stays where it is unpacked.
    static func safeEntry(_ entry: String) -> Bool {
        !entry.hasPrefix("/") && !entry.split(separator: "/").contains("..") && !entry.contains("\0")
    }

    /// The team identifier of a program whose signature holds.
    static func team(of program: String) async -> String? {
        let codesign = URL(fileURLWithPath: "/usr/bin/codesign")
        guard let verified = try? await ProcessRunner.run(codesign, ["--verify", "--strict", program], timeout: 60), verified.ok,
              let described = try? await ProcessRunner.run(codesign, ["-dv", program], timeout: 30) else { return nil }
        let text = described.stderrText + described.stdoutText
        guard let range = text.range(of: #"TeamIdentifier=([A-Z0-9]{10})"#, options: .regularExpression) else { return nil }
        return String(text[range].dropFirst("TeamIdentifier=".count))
    }

    /// What is running now: each process's program by the path the kernel has for it, links followed (`claude` started
    /// from `~/.local/bin` is `~/.local/share/claude/versions/2.1.291`), and each process's command line (a program
    /// run by `node` or a shell is told by its arguments).
    static func processes() async -> [String] {
        var out = executables()
        if let result = try? await ProcessRunner.run(URL(fileURLWithPath: "/bin/ps"), ["-axo", "command="], timeout: 10), result.ok {
            out += result.stdoutText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        return out
    }

    /// `proc_pidpath` of every process this user may ask about.
    static func executables() -> [String] {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(count) + 64)
        let filled = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard filled > 0 else { return [] }
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        var seen = Set<String>()
        for pid in pids.prefix(Int(filled)) where pid > 0 {
            if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 { seen.insert(String(cString: buffer)) }
        }
        return Array(seen)
    }

    /// Whether a running process (its program's path, or its command line) is `path` or something in it. `…/2.1.28`
    /// is not `…/2.1.288`.
    static func runs(_ line: String, _ path: String) -> Bool {
        let real = AgentInventory.real(path)
        return (real == path ? [path] : [path, real]).contains { line.hasSuffix($0) || line.contains($0 + "/") || line.contains($0 + " ") }
    }
}
