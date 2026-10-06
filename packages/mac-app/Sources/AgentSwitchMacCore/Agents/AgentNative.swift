import CryptoKit
import Foundation

/// The vendor's own install of an agent, made, updated and removed the vendor's own way (docs/agents-v0.md §0, §5):
/// what ends up on the disk is what the vendor's instructions would have put there — the same folders, the same command,
/// the vendor's own updater left on — so with AgentSwitch gone it is an ordinary install. Installing runs the vendor's
/// installer (Claude Code: its own program's `install`; the others: their published script, asked no questions and
/// otherwise left to do what it does by hand — a script that finds its command's folder missing from the PATH adds its
/// line to the shell profile, as it would there); updating runs the installed program's own update command; removing
/// deletes the program files in the few places listed here and nothing else — never a login, a setting or a session.
/// Measured against the real installers in a home of their own on 2026-10-06.
public struct AgentNative: Sendable {
    public let layout: AgentLayout
    /// What the vendors' programs run with: `HOME`, `USER`, `SHELL`, `LANG`, and the login `PATH` as it is.
    public var environment: [String: String]
    public var platform: AgentPlatform = .current
    public var fetch: AgentReleases.Fetch = AgentReleases.fetch
    public var download: AgentTransfer.Download = AgentTransfer.download
    public var signer: @Sendable (String) async -> String?
    public var runningPrograms: @Sendable () async -> [String]
    /// `(program, arguments, environment, timeout)`: run to its end, its output kept.
    public var run: @Sendable (String, [String], [String: String], TimeInterval) async throws -> CommandResult
    /// The operation's log (AgentLog): what was fetched, what was run, how it ended.
    public var log: @Sendable (String) -> Void = { _ in }

    public static let installTimeout: TimeInterval = 30 * 60
    public static let codexScript = "https://chatgpt.com/codex/install.sh"
    public static let opencodeScript = "https://opencode.ai/v2/install"
    public static let piScript = "https://pi.dev/install.sh"
    /// pi's installer refuses an older Node.js.
    public static let piNodeFloor = AgentVersion("22.19.0")

    public init(layout: AgentLayout, environment: [String: String]) {
        self.layout = layout
        self.environment = environment
        signer = { program in await AgentStore.team(of: program) }
        runningPrograms = { await AgentStore.processes() }
        run = { program, arguments, environment, timeout in
            try await ProcessRunner.run(URL(fileURLWithPath: program), arguments, environment: environment, timeout: timeout)
        }
    }

    // MARK: installing

    /// Installs the vendor's stable version where the vendor installs it. `version` is the stable channel's newest:
    /// Claude Code's download and OpenCode's line need it; Codex's and pi's installers pick their own latest.
    public func install(_ agent: AgentCLI, version: String?, report: @escaping @Sendable (AgentStore.Phase) -> Void = { _ in }) async throws {
        let fm = FileManager.default
        guard AgentInventory.stable(agent, layout: layout, fm: fm) == nil else { throw AgentError("\(agent.title) 已经安装。") }
        let job = try AgentStore.jobFolder(layout)
        defer {
            try? fm.removeItem(atPath: job)
            AgentStore.tidy(layout)
        }
        report(.resolving)
        switch agent {
        case .claude:
            // What its own script does: the program downloaded and checked, then asked to install itself. The stable
            // channel is asked here when the page had not read it yet (an install started from the checklist).
            let wanted: String
            if let version { wanted = version } else { wanted = try await stableVersion(.claude) }
            let version = wanted
            let artifact = try await AgentArtifacts.resolve(.claude, version: version, platform: platform, fetch: fetch)
            log("download \(artifact.url.absoluteString) \(artifact.digest)")
            let file = "\(job)/claude"
            report(.downloading(received: 0, total: artifact.size))
            try await download(artifact.url, URL(fileURLWithPath: file)) { received, total in report(.downloading(received: received, total: total ?? artifact.size)) }
            try Task.checkCancellation()
            report(.verifying)
            guard try artifact.digest.matches(file: URL(fileURLWithPath: file)) else { throw AgentError("下载的文件与官方校验值不符，已丢弃。未做任何更改。") }
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file)
            guard await signer(file) == AgentStore.teams[.claude] else { throw AgentError("下载的程序没有 Claude Code 发行方的签名，已丢弃。") }
            report(.installing)
            try await ran(file, ["install", "stable"], doing: "安装")
        case .codex:
            let script = try await script(AgentNative.codexScript, into: job)
            report(.installing)
            try await ran("/bin/sh", [script], extra: ["CODEX_NON_INTERACTIVE": "1"], doing: "安装")
        case .opencode:
            // The second line's own script (the first line's installs 1.x), the version named.
            let script = try await script(AgentNative.opencodeScript, into: job)
            report(.installing)
            try await ran("/bin/bash", [script] + (version.map { ["--version", $0] } ?? []), doing: "安装")
        case .pi:
            try await requireNode()
            let script = try await script(AgentNative.piScript, into: job)
            report(.installing)
            try await ran("/bin/sh", [script], doing: "安装")
        }
        report(.checking)
        guard AgentInventory.stable(agent, layout: layout, fm: fm) != nil else { throw AgentError("安装程序已运行，但没有找到 \(agent.title) 的安装。") }
    }

    /// What the agent's stable channel has now.
    func stableVersion(_ agent: AgentCLI) async throws -> String {
        for lookup in AgentReleases.lookups(agent, platform: platform).stable {
            if let data = try? await fetch(lookup.url), let version = lookup.read(data) { return version }
        }
        throw AgentError("未能读取 \(agent.title) 的正式版版本号，请检查网络后重试。")
    }

    /// The vendor's published installer, fetched to a file of the job's own. Only a shell script is taken.
    func script(_ address: String, into job: String) async throws -> String {
        guard let url = URL(string: address), AgentReleases.allowed(url) else { throw AgentError("不在允许的发布地址之内：\(address)") }
        let data: Data
        do { data = try await fetch(url) } catch { throw AgentError("未能取得官方安装脚本：\(error.localizedDescription)") }
        guard data.count > 100, data.prefix(2) == Data("#!".utf8) else { throw AgentError("\(url.host ?? "") 给出的不是安装脚本。") }
        log("installer \(address) sha256:\(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()) \(data.count) bytes")
        let path = "\(job)/install.sh"
        guard FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o700]) else { throw AgentError("无法保存安装脚本。") }
        return path
    }

    /// pi is a set of npm packages: its installer needs Node.js, and installing that is not AgentSwitch's to do.
    func requireNode() async throws {
        let result = try? await run("/usr/bin/env", ["node", "--version"], environment, 20)
        let version = result.flatMap { $0.ok ? HarnessEvaluator.parseVersion($0.stdoutText) : nil }
        guard let version, AgentVersion(version) >= AgentNative.piNodeFloor else {
            throw AgentError("pi 需要 Node.js \(AgentNative.piNodeFloor) 或更新的版本\(version.map { "，当前为 \($0)" } ?? "，未找到 node")。请先安装 Node.js，再回到这里安装 pi。")
        }
    }

    // MARK: updating

    /// The installed program's own update: Claude Code's and Codex's `update`, OpenCode's `upgrade <version> --method
    /// curl`, pi's `update self`. `version` is what its channel now has.
    public func update(_ install: AgentInstall, to version: String, report: @escaping @Sendable (AgentStore.Phase) -> Void = { _ in }) async throws {
        guard install.source == .stable, AgentVersion.isWellFormed(version) else { throw AgentError("这一项不是 \(install.agent.title) 自己的安装，不能在这里更新。") }
        guard AgentInventory.stable(install.agent, layout: layout, fm: .default)?.binary == install.binary else { throw AgentError("\(install.agent.title) 的安装已有变化，请重新检查。") }
        report(.updating)
        switch install.agent {
        case .claude, .codex: try await ran(install.binary, ["update"], doing: "更新")
        // `--method curl`: the install its own script made, which is the only one this is (it cannot always tell —
        // with `~/.opencode/bin` not on the PATH it asks for the method).
        case .opencode: try await ran(install.binary, ["upgrade", version, "--method", "curl"], doing: "更新")
        case .pi:
            try await requireNode()
            try await ran(install.binary, ["update", "self"], doing: "更新")
        }
        report(.checking)
        let said = try? await run(install.binary, ["--version"], environment.merging(install.agent.noSelfUpdate) { _, new in new }, 30)
        let now = said.flatMap { HarnessEvaluator.parseVersion($0.stdoutText + $0.stderrText) }
        if let now, AgentVersion(now) < AgentVersion(version) { throw AgentError("更新程序已运行，但版本仍是 \(now)。") }
    }

    /// Runs one of the vendor's programs to its end; a failure is said with the last thing it printed.
    func ran(_ program: String, _ arguments: [String], extra: [String: String] = [:], doing: String) async throws {
        let result: CommandResult
        log("$ \(([program] + arguments).joined(separator: " "))\(extra.isEmpty ? "" : "  [\(extra.keys.sorted().joined(separator: " "))]")")
        do {
            result = try await run(program, arguments, environment.merging(extra) { _, new in new }, AgentNative.installTimeout)
        } catch {
            log("could not start: \(error.localizedDescription)")
            throw AgentError("\(doing)未能开始：\(error.localizedDescription)")
        }
        for line in AgentNative.plainLines(result.stdoutText + "\n" + result.stderrText).suffix(80) { log("  \(line)") }
        log(result.timedOut ? "timed out" : "exit \(result.status)")
        if result.timedOut { throw AgentError("\(doing)超时，已停止。") }
        guard result.ok else {
            let said = AgentNative.lastWords(result.stderrText + "\n" + result.stdoutText)
            throw AgentError("\(doing)未完成\(said.isEmpty ? "（退出码 \(result.status)）" : "：\(said)")")
        }
    }

    /// The last lines a program printed, as text: colours taken out, a spinner's frames (each drawn over the one
    /// before by moving the cursor back) taken as lines of their own, the marks they start with dropped.
    static func lastWords(_ output: String, lines: Int = 2, limit: Int = 300) -> String {
        let text = plainLines(output).suffix(lines).joined(separator: " ")
        return text.count > limit ? String(text.suffix(limit)) : text
    }

    /// A program's output as the lines it said: each spinner frame once, in the order they first came.
    static func plainLines(_ output: String) -> [String] {
        let plain = output
            .replacingOccurrences(of: #"\x1B\[[0-9;]*[DGJK]"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"\x1B\[[0-9;?]*[A-Za-z]"#, with: "", options: .regularExpression)
        let marks = CharacterSet.symbols.union(.whitespaces)
        var last: String?
        return plain.split(whereSeparator: \.isNewline)
            .map { String(String.UnicodeScalarView($0.unicodeScalars.drop(while: marks.contains))).trimmingCharacters(in: .whitespaces) }
            .filter { line in
                // A spinner draws the same words again and again.
                guard line != last, line.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else { return false }
                last = line
                return true
            }
    }

    // MARK: removing

    /// Why the vendor's install cannot be removed now: one of its programs runs. nil when it can.
    public func blocker(_ install: AgentInstall) async -> String? {
        let marks = AgentNative.runningMarks(install.agent, layout: layout)
        let running = await runningPrograms()
        return running.contains { line in marks.contains { AgentStore.runs(line, $0) } } ? AgentStore.runningNotice(install) : nil
    }

    /// Where a running program of the vendor's install is: its program by its real path, or (pi, run by `node`) the
    /// script in its command line.
    static func runningMarks(_ agent: AgentCLI, layout: AgentLayout) -> [String] {
        switch agent {
        case .claude: return [layout.programRoot(.claude)]
        case .codex: return [layout.programRoot(.codex)]
        case .opencode: return [layout.command(.opencode)]
        case .pi: return ["\(layout.programRoot(.pi))/install", "\(layout.programRoot(.pi))/bin/pi"]
        }
    }

    /// What uninstalling removes, as found now: the command when it is the vendor's (a link into its program folder),
    /// and the program folders themselves — real folders only, never one that is a link to somewhere else.
    public static func uninstallPaths(_ agent: AgentCLI, layout: AgentLayout, fileManager fm: FileManager = .default) -> [String] {
        func link(_ path: String, into root: String) -> String? {
            (try? fm.destinationOfSymbolicLink(atPath: path)) != nil && AgentInventory.inside(path, root) ? path : nil
        }
        func kind(_ path: String) -> FileAttributeType? { (try? fm.attributesOfItem(atPath: path))?[.type] as? FileAttributeType }
        func folder(_ path: String) -> String? { kind(path) == .typeDirectory ? path : nil }
        func file(_ path: String) -> String? { kind(path) == .typeRegular ? path : nil }
        let home = layout.home
        switch agent {
        case .claude:
            return [link(layout.command(.claude), into: layout.programRoot(.claude)), folder("\(home)/.local/share/claude")].compactMap { $0 }
        case .codex:
            let root = layout.programRoot(.codex)
            return [link("\(layout.binDir)/codex", into: root), link("\(layout.binDir)/codex-code-mode-host", into: root), folder(root)].compactMap { $0 }
        case .opencode:
            // Its script also leaves `opencode2`, three lines that start `opencode`: that goes with it.
            let wrapper = "\(home)/.opencode/bin/opencode2"
            let isWrapper = file(wrapper) != nil && (fm.contents(atPath: wrapper).map { $0.count < 400 && String(decoding: $0, as: UTF8.self).contains("/opencode\"") } ?? false)
            return [file(layout.command(.opencode)), isWrapper ? wrapper : nil].compactMap { $0 }
        case .pi:
            // What its own installer's uninstall removes: the command, the launcher, the releases. `fd` and `rg`
            // beside the launcher are its tools' and stay, as they do there.
            // Its command is a link wherever its installer found room on the PATH, or the launcher itself.
            let root = layout.programRoot(.pi)
            let command = AgentInventory.piStable(layout: layout, fm: fm)?.binary ?? layout.command(.pi)
            return [link(command, into: root), file("\(root)/bin/pi"), folder("\(root)/install")].compactMap { $0 }
        }
    }

    /// Removes the vendor's own install: its program files and its command. Logins, settings and sessions stay.
    public func uninstall(_ install: AgentInstall, report: @escaping @Sendable (AgentStore.Phase) -> Void = { _ in }) async throws {
        guard install.source == .stable else { throw AgentError("这一项不是 \(install.agent.title) 自己的安装，不能在这里卸载。") }
        let fm = FileManager.default
        // Still the install that was asked about: a command that has since become something else is not touched.
        guard AgentInventory.stable(install.agent, layout: layout, fm: fm)?.binary == install.binary else { throw AgentError("\(install.agent.title) 的安装已有变化，请重新检查。") }
        if let blocked = await blocker(install) { throw AgentError(blocked) }
        report(.removing)
        let paths = AgentNative.uninstallPaths(install.agent, layout: layout, fileManager: fm)
        guard !paths.isEmpty else { throw AgentError("没有找到 \(install.agent.title) 的安装。") }
        var failed: [String] = []
        for path in paths {
            do {
                try fm.removeItem(atPath: path)
                log("removed \(path)")
            } catch {
                log("could not remove \(path): \(error.localizedDescription)")
                failed.append(path)
            }
        }
        if install.agent == .opencode {
            // The folders its script made, when nothing else is in them.
            for folder in ["\(layout.home)/.opencode/bin", "\(layout.home)/.opencode"] where (try? fm.contentsOfDirectory(atPath: folder))?.isEmpty == true {
                try? fm.removeItem(atPath: folder)
            }
        }
        guard failed.isEmpty else { throw AgentError("有 \(failed.count) 项未能删除：\(failed.joined(separator: "、"))") }
    }

    /// Clears the earlier versions a vendor keeps beside the current one: each a version-named entry directly in the
    /// vendor's versions folder, not the current one, not running.
    public func clean(_ agent: AgentCLI, report: @escaping @Sendable (AgentStore.Phase) -> Void = { _ in }) async throws {
        let fm = FileManager.default
        guard let current = AgentInventory.stable(agent, layout: layout, fm: fm),
              let leftovers = AgentInventory.leftovers(agent, current: current, layout: layout, fm: fm) else { return }
        report(.removing)
        let running = await runningPrograms()
        var failed: [String] = []
        for (version, path) in zip(leftovers.versions, leftovers.paths) where version != current.version && AgentVersion.isWellFormed(version) {
            if running.contains(where: { AgentStore.runs($0, path) }) {
                log("still running: \(path)")
                failed.append(version)
                continue
            }
            do {
                try fm.removeItem(atPath: path)
                log("removed \(path)")
            } catch {
                log("could not remove \(path): \(error.localizedDescription)")
                failed.append(version)
            }
        }
        guard failed.isEmpty else { throw AgentError("未能清除 \(failed.joined(separator: "、"))：仍在运行，或无法删除。") }
    }
}
