import CryptoKit
import XCTest
@testable import AgentSwitchMacCore

/// docs/agents-v0.md §0, §5: the vendor's own install, made, updated and removed the vendor's way. The vendors here
/// are fixtures: their installers and programs are a few lines of shell that put files where the real ones do (as
/// measured on 2026-10-06), in a home of the test's own. Nothing is downloaded, nothing real runs, the real home is
/// never read.
final class AgentNativeTests: XCTestCase {
    private final class Vendor: @unchecked Sendable {
        let root = TestSupport.tempDir("native").resolvingSymlinksInPath()
        let layout: AgentLayout
        let fm = FileManager.default
        private let lock = NSLock()
        private var answers: [String: Data] = [:]
        private var files: [String: URL] = [:]
        private var team: String? = "Q6L2SF6YDW"
        private var running: [String] = []

        var home: String { layout.home }
        var tools: String { root.appendingPathComponent("tools").path }
        var vendor: String { root.appendingPathComponent("vendor").path }

        init() {
            layout = AgentLayout(home: root.appendingPathComponent("home").path, appCodex: [])
            for folder in [layout.home, tools, vendor] { try? fm.createDirectory(atPath: folder, withIntermediateDirectories: true) }
            node("v22.19.0")
            for agent in AgentCLI.allCases { write("\(vendor)/\(agent.command)", program(agent)) }
        }

        var native: AgentNative {
            var native = AgentNative(layout: layout, environment: ["HOME": home, "PATH": "\(tools):/usr/bin:/bin", "SHELL": "/bin/zsh"])
            native.platform = .arm64
            native.fetch = { [self] url in
                guard let data = locked({ answers[url.absoluteString] }) else { throw CommandError("404") }
                return data
            }
            native.download = { [self] from, to, progress in
                guard let file = locked({ files[from.absoluteString] }) else { throw AgentError("发布地址上没有这个文件。") }
                try FileManager.default.copyItem(at: file, to: to)
                progress(2, 2)
            }
            native.signer = { [self] _ in locked { team } }
            native.runningPrograms = { [self] in locked { running } }
            return native
        }

        private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
        func signed(by team: String?) { locked { self.team = team } }
        func run(_ lines: [String]) { locked { running = lines } }
        func answer(_ address: String, _ text: String) { locked { answers[address] = Data(text.utf8) } }

        func write(_ path: String, _ text: String, mode: Int = 0o755) {
            try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try? fm.removeItem(atPath: path)
            fm.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: mode])
        }
        func read(_ path: String) -> String? { fm.contents(atPath: path).map { String(decoding: $0, as: UTF8.self) } }
        func exists(_ path: String) -> Bool { (try? fm.attributesOfItem(atPath: path)) != nil }
        func names(_ folder: String) -> [String] { ((try? fm.contentsOfDirectory(atPath: folder)) ?? []).sorted() }
        func node(_ version: String?) {
            if let version { write("\(tools)/node", "#!/bin/sh\necho \(version)\n") } else { try? fm.removeItem(atPath: "\(tools)/node") }
        }

        /// A vendor's program: says its version (the one in `~/version-<name>` once an update has run), and on any
        /// other command notes what it was asked and takes the version waiting in `~/next-<name>`. Claude Code's also
        /// installs itself, as the real one does.
        func program(_ agent: AgentCLI) -> String {
            let name = agent.command
            let says: String
            let first: String
            switch agent {
            case .claude: says = "echo \"$V (Claude Code)\""; first = "2.1.285"
            case .codex: says = "echo \"codex-cli $V\""; first = "0.160.1"
            case .opencode: says = "echo \"opencode v$V\""; first = "2.0.24"
            case .pi: says = "echo \"$V\""; first = "1.0.4"
            }
            let install = agent != .claude ? "" : """
              install)
                mkdir -p "$HOME/.local/share/claude/versions" "$HOME/.local/bin" "$HOME/.claude"
                cp "$0" "$HOME/.local/share/claude/versions/$V"
                ln -sf "$HOME/.local/share/claude/versions/$V" "$HOME/.local/bin/claude"
                printf '{"autoUpdatesChannel":"%s"}' "$2" > "$HOME/.claude/settings.json" ;;

            """
            return """
            #!/bin/sh
            V=$(cat "$HOME/version-\(name)" 2>/dev/null || echo \(first))
            if [ -f "$HOME/fail-\(name)" ]; then printf '\\033[?25l\\033[31merror:\\033[0m no space left on device\\n' >&2; exit 1; fi
            case "$1" in
              --version) \(says) ;;
            \(install)  *)
                echo "$*" >> "$HOME/ran-\(name)"
                if [ -f "$HOME/next-\(name)" ]; then mv "$HOME/next-\(name)" "$HOME/version-\(name)"; fi ;;
            esac

            """
        }

        /// Claude Code as its vendor publishes it: a manifest and the program.
        func publishClaude(_ version: String, digest: String? = nil) {
            let file = URL(fileURLWithPath: "\(vendor)/claude")
            let sha = SHA256.hash(data: (try? Data(contentsOf: file)) ?? Data()).map { String(format: "%02x", $0) }.joined()
            answer("\(AgentReleases.claudeBase)/\(version)/manifest.json", #"{"platforms":{"darwin-arm64":{"binary":"claude","checksum":"\#(digest ?? sha)"}}}"#)
            locked { files["\(AgentReleases.claudeBase)/\(version)/darwin-arm64/claude"] = file }
        }

        /// The three published installers: each notes what it was run with and puts the program where the real one does.
        func publishInstallers() {
            let head = "#!/bin/sh\n# A vendor's installer as a fixture: it puts a program where the real script does, and nothing else.\n"
            let fail = "if [ -f \"$HOME/fail-installer\" ]; then printf '\\033[31merror:\\033[0m no space left on device\\n' >&2; exit 1; fi\n"
            answer(AgentNative.codexScript, head + "echo \"$CODEX_NON_INTERACTIVE|$*\" > \"$HOME/installer-codex\"\n" + fail + """
            R="$HOME/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin"
            mkdir -p "$R/bin" "$HOME/.local/bin"
            cp "\(vendor)/codex" "$R/bin/codex"; cp "\(vendor)/codex" "$R/bin/codex-code-mode-host"
            ln -sfn "$R" "$HOME/.codex/packages/standalone/current"
            ln -sf "$HOME/.codex/packages/standalone/current/bin/codex" "$HOME/.local/bin/codex"
            ln -sf "$HOME/.codex/packages/standalone/current/bin/codex-code-mode-host" "$HOME/.local/bin/codex-code-mode-host"

            """)
            answer(AgentNative.opencodeScript, head + "echo \"$*\" > \"$HOME/installer-opencode\"\n" + fail + """
            mkdir -p "$HOME/.opencode/bin"
            cp "\(vendor)/opencode" "$HOME/.opencode/bin/opencode"
            printf '#!/bin/sh\\nexec "$(dirname "$0")/opencode" "$@"\\n' > "$HOME/.opencode/bin/opencode2"; chmod 755 "$HOME/.opencode/bin/opencode2"

            """)
            answer(AgentNative.piScript, head + "echo \"$*\" > \"$HOME/installer-pi\"\n" + fail + """
            A="$HOME/.pi/agent"
            mkdir -p "$A/bin" "$A/install/releases/1.0.4/node_modules" "$HOME/.local/bin"
            cp "\(vendor)/pi" "$A/bin/pi"; echo rg > "$A/bin/rg"
            echo 1.0.4 > "$A/install/current-version"
            # Where its command goes is the installer's to pick from the PATH: `~/pi-bin` names the folder here.
            B=$(cat "$HOME/pi-bin" 2>/dev/null || echo "$HOME/.local/bin")
            if [ "$B" = "$A/bin" ]; then T=script; else T=symlink; mkdir -p "$B"; ln -sf "$A/bin/pi" "$B/pi"; fi
            printf '{"kind":"pi-managed-install","entrypoint":{"type":"%s","path":"%s/pi"}}' "$T" "$B" > "$A/install/managed-install.json"

            """)
        }

        func stable(_ agent: AgentCLI) -> AgentInstall? { AgentInventory.stable(agent, layout: layout, fm: fm) }
        func leftInDownloads() -> [String] { names(layout.downloads) }
    }

    private final class Phases: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [AgentStore.Phase] = []
        func add(_ phase: AgentStore.Phase) { lock.lock(); seen.append(phase); lock.unlock() }
        func get() -> [AgentStore.Phase] { lock.lock(); defer { lock.unlock() }; return seen }
    }

    private func refused(_ words: String, file: StaticString = #filePath, line: UInt = #line, _ body: () async throws -> Void) async {
        do {
            try await body()
            XCTFail("it went through", file: file, line: line)
        } catch {
            XCTAssertTrue(error.localizedDescription.contains(words), error.localizedDescription, file: file, line: line)
        }
    }

    // MARK: installing

    func testClaudeCodeIsDownloadedCheckedAndInstalledByItsOwnProgram() async throws {
        let v = Vendor()
        v.publishClaude("2.1.285")
        XCTAssertNil(v.stable(.claude))
        let phases = Phases()
        try await v.native.install(.claude, version: "2.1.285") { phases.add($0) }
        let install = try XCTUnwrap(v.stable(.claude))
        XCTAssertEqual(install.version, "2.1.285")
        XCTAssertEqual(install.binary, "\(v.home)/.local/bin/claude")
        XCTAssertEqual(install.channel, "stable", "its own installer set the channel it follows")
        XCTAssertEqual(v.names("\(v.home)/.local/share/claude/versions"), ["2.1.285"])
        XCTAssertFalse(v.exists("\(v.home)/.local/share/agentswitch"), "the downloaded copy is gone once it has installed itself, and the folder it was in")
        XCTAssertEqual(phases.get(), [.resolving, .downloading(received: 0, total: nil), .downloading(received: 2, total: 2), .verifying, .installing, .checking])
        // What is there is the vendor's install and nothing of AgentSwitch's: no launcher, no store, no switch set.
        XCTAssertEqual(v.names(v.home), [".claude", ".local"])
        XCTAssertEqual(v.names("\(v.home)/.local/bin"), ["claude"])
        await refused("已经安装") { try await v.native.install(.claude, version: "2.1.285") }
    }

    func testADownloadThatIsNotClaudeCodeIsNeverRun() async {
        let v = Vendor()
        await refused("请先检查更新") { try await v.native.install(.claude, version: nil) }
        v.publishClaude("2.1.285", digest: String(repeating: "0", count: 64))
        await refused("校验值不符") { try await v.native.install(.claude, version: "2.1.285") }
        v.publishClaude("2.1.285")
        v.signed(by: "EVIL000000")
        await refused("签名") { try await v.native.install(.claude, version: "2.1.285") }
        v.signed(by: nil)
        await refused("签名") { try await v.native.install(.claude, version: "2.1.285") }
        await refused("未找到 Claude Code 2.1.999") { try await v.native.install(.claude, version: "2.1.999") }
        XCTAssertEqual(v.names("\(v.home)/.local/share"), [], "the program never ran, and what was downloaded is gone")
        XCTAssertNil(v.stable(.claude))
    }

    func testTheOthersAreInstalledByTheirPublishedScripts() async throws {
        let v = Vendor()
        v.publishInstallers()
        try await v.native.install(.codex, version: "0.160.1")
        XCTAssertEqual(v.read("\(v.home)/installer-codex"), "1|\n", "asked no questions, given no version: its own latest")
        XCTAssertEqual(v.stable(.codex)?.location, "\(v.home)/.codex/packages/standalone")
        try await v.native.install(.opencode, version: "2.0.24")
        XCTAssertEqual(v.read("\(v.home)/installer-opencode"), "--version 2.0.24\n", "the second line, by its number")
        XCTAssertEqual(v.stable(.opencode)?.binary, "\(v.home)/.opencode/bin/opencode")
        try await v.native.install(.pi, version: "1.0.4")
        XCTAssertEqual(v.read("\(v.home)/installer-pi"), "\n")
        XCTAssertEqual(v.stable(.pi)?.version, "1.0.4")
        XCTAssertFalse(v.exists(v.layout.store), "the scripts are gone once they have run")
        for agent in [AgentCLI.codex, .opencode, .pi] { await refused("已经安装") { try await v.native.install(agent, version: nil) } }
    }

    func testAnInstallerThatFailsSaysWhyAndLeavesNothing() async {
        let v = Vendor()
        // The vendor does not answer; answers with something that is no script.
        await refused("未能取得官方安装脚本") { try await v.native.install(.codex, version: nil) }
        v.answer(AgentNative.codexScript, "<!doctype html><html><head><title>Just a moment…</title></head><body>" + String(repeating: "x", count: 200) + "</body></html>")
        await refused("chatgpt.com 给出的不是安装脚本") { try await v.native.install(.codex, version: nil) }
        // It runs and fails: its last words, without the colours.
        v.publishInstallers()
        v.write("\(v.home)/fail-installer", "")
        await refused("安装未完成：error: no space left on device") { try await v.native.install(.opencode, version: "2.0.24") }
        // It runs to its end and nothing is there.
        try? v.fm.removeItem(atPath: "\(v.home)/fail-installer")
        v.answer(AgentNative.codexScript, "#!/bin/sh\n# an installer that does nothing at all, padded to pass for a script " + String(repeating: "#", count: 80) + "\nexit 0\n")
        await refused("没有找到 Codex 的安装") { try await v.native.install(.codex, version: nil) }
        // pi's installer needs Node.js, and without a terminal does not install it.
        v.node("v20.11.0")
        await refused("pi 需要 Node.js 22.19.0 或更新的版本，当前为 20.11.0") { try await v.native.install(.pi, version: nil) }
        v.node(nil)
        await refused("未找到 node") { try await v.native.install(.pi, version: nil) }
        XCTAssertFalse(v.exists("\(v.home)/installer-pi"), "its script was not run")
        XCTAssertEqual(v.leftInDownloads(), [])
        for agent in AgentCLI.allCases { XCTAssertNil(v.stable(agent)) }
    }

    // MARK: updating

    func testUpdatingRunsTheProgramsOwnUpdate() async throws {
        let v = Vendor()
        v.publishClaude("2.1.285")
        v.publishInstallers()
        let next: [AgentCLI: String] = [.claude: "2.1.291", .codex: "0.161.0", .opencode: "2.0.25", .pi: "1.0.5"]
        let asked: [AgentCLI: String] = [.claude: "update\n", .codex: "update\n", .opencode: "upgrade 2.0.25 --method curl\n", .pi: "update self\n"]
        for agent in AgentCLI.allCases {
            try await v.native.install(agent, version: agent == .claude ? "2.1.285" : nil)
            let install = try XCTUnwrap(v.stable(agent))
            let name = agent.command
            // Nothing newer came of it: said, not passed off as done.
            await refused("版本仍是") { try await v.native.update(install, to: next[agent]!) }
            try? v.fm.removeItem(atPath: "\(v.home)/ran-\(name)")
            v.write("\(v.home)/next-\(name)", next[agent]!)
            let phases = Phases()
            try await v.native.update(install, to: next[agent]!) { phases.add($0) }
            XCTAssertEqual(v.read("\(v.home)/ran-\(name)"), asked[agent], agent.title)
            XCTAssertEqual(phases.get(), [.updating, .checking])
            v.write("\(v.home)/fail-\(name)", "")
            await refused("更新未完成：error: no space left on device") { try await v.native.update(install, to: "9.9.9") }
            try? v.fm.removeItem(atPath: "\(v.home)/fail-\(name)")
        }
        // Only the vendor's own install is updated this way, and only while it is still the one that was asked about.
        let beta = AgentInstall(agent: .claude, source: .beta, key: "beta", binary: "/x/launch", location: "/x", version: "2.1.291")
        await refused("不能在这里更新") { try await v.native.update(beta, to: "2.1.292") }
        let codex = try XCTUnwrap(v.stable(.codex))
        await refused("不能在这里更新") { try await v.native.update(codex, to: "latest") }
        v.write("\(v.home)/.local/bin/codex", "#!/bin/sh\necho mine\n")
        await refused("已有变化") { try await v.native.update(codex, to: "0.162.0") }
        // pi's update is npm's: no Node.js, no update.
        v.node(nil)
        await refused("未找到 node") { try await v.native.update(try XCTUnwrap(v.stable(.pi)), to: "1.0.6") }
    }

    // MARK: removing

    func testUninstallingRemovesTheProgramAndKeepsWhatIsTheUsers() async throws {
        let v = Vendor(), home = v.home
        v.publishClaude("2.1.285")
        v.publishInstallers()
        for agent in AgentCLI.allCases { try await v.native.install(agent, version: agent == .claude ? "2.1.285" : nil) }
        // What is the user's: logins, settings, sessions; a name of their own beside the vendors' commands.
        let kept = ["\(home)/.claude.json", "\(home)/.claude/settings.json", "\(home)/.claude/projects/p/s.jsonl", "\(home)/.codex/auth.json", "\(home)/.codex/config.toml",
                    "\(home)/.codex/sessions/2026/s.jsonl", "\(home)/.config/opencode/opencode.json", "\(home)/.local/share/opencode/opencode.db",
                    "\(home)/.pi/agent/auth.json", "\(home)/.pi/agent/sessions/s.jsonl", "\(home)/.pi/agent/bin/rg", "\(home)/.local/bin/claude-beta"]
        for path in kept where !v.exists(path) { v.write(path, "mine") }
        XCTAssertEqual(AgentNative.uninstallPaths(.claude, layout: v.layout), ["\(home)/.local/bin/claude", "\(home)/.local/share/claude"])
        XCTAssertEqual(AgentNative.uninstallPaths(.codex, layout: v.layout), ["\(home)/.local/bin/codex", "\(home)/.local/bin/codex-code-mode-host", "\(home)/.codex/packages/standalone"])
        XCTAssertEqual(AgentNative.uninstallPaths(.opencode, layout: v.layout), ["\(home)/.opencode/bin/opencode", "\(home)/.opencode/bin/opencode2"])
        XCTAssertEqual(AgentNative.uninstallPaths(.pi, layout: v.layout), ["\(home)/.local/bin/pi", "\(home)/.pi/agent/bin/pi", "\(home)/.pi/agent/install"])

        // While one of its programs runs — by its real path, or (pi) as the script `node` was given — it stays.
        let running: [AgentCLI: String] = [.claude: "\(home)/.local/share/claude/versions/2.1.285",
                                           .codex: "\(home)/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex",
                                           .opencode: "\(home)/.opencode/bin/opencode",
                                           .pi: "node \(home)/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc"]
        for agent in AgentCLI.allCases {
            let install = try XCTUnwrap(v.stable(agent))
            v.run(["/sbin/launchd", running[agent]!])
            let blocked = await v.native.blocker(install)
            XCTAssertNotNil(blocked, agent.title)
            await refused("正在运行") { try await v.native.uninstall(install) }
            XCTAssertNotNil(v.stable(agent), agent.title)
            // Another agent's programs, or the user's own files of a like name, do not hold it.
            v.run(["/sbin/launchd", "\(home)/.local/bin/claude-beta", "/opt/homebrew/bin/\(agent.command)", "vim \(home)/notes/\(agent.command).md"])
            let free = await v.native.blocker(install)
            XCTAssertNil(free, agent.title)
            let phases = Phases()
            try await v.native.uninstall(install) { phases.add($0) }
            XCTAssertEqual(phases.get(), [.removing])
            XCTAssertNil(v.stable(agent), agent.title)
            XCTAssertEqual(AgentNative.uninstallPaths(agent, layout: v.layout), [], agent.title)
        }
        for path in kept { XCTAssertTrue(v.exists(path), path) }
        XCTAssertEqual(v.names("\(home)/.local/bin"), ["claude-beta"])
        XCTAssertFalse(v.exists("\(home)/.opencode"), "the folder its script made, empty now")
        XCTAssertEqual(v.names("\(home)/.pi/agent/bin"), ["rg"])
        XCTAssertFalse(v.exists("\(home)/.codex/packages/standalone"))
        XCTAssertFalse(v.exists("\(home)/.local/share/claude"))
    }

    func testOnlyTheVendorsOwnInstallIsUninstalled() async throws {
        let v = Vendor(), home = v.home
        v.publishClaude("2.1.285")
        v.publishInstallers()
        try await v.native.install(.claude, version: "2.1.285")
        let install = try XCTUnwrap(v.stable(.claude))
        // The command has become the user's own file since the page was drawn: nothing is removed.
        v.write("\(home)/.local/bin/claude", "#!/bin/sh\necho mine\n")
        await refused("已有变化") { try await v.native.uninstall(install) }
        XCTAssertEqual(v.names("\(home)/.local/share/claude/versions"), ["2.1.285"])
        XCTAssertEqual(v.read("\(home)/.local/bin/claude"), "#!/bin/sh\necho mine\n")
        // A stored version is the store's to delete; ChatGPT App's Codex is nobody's.
        for other in [AgentInstall(agent: .claude, source: .beta, key: "beta", binary: "/x", location: "\(home)/.local/share/claude", version: "2.1.291"),
                      AgentInstall(agent: .codex, source: .app, key: "app", binary: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", location: "/Applications/ChatGPT.app", version: "0.160.1"),
                      AgentInstall(agent: .claude, source: .other, key: "other:/opt/homebrew/bin/claude", binary: "/opt/homebrew/bin/claude", location: "/opt/homebrew/bin/claude")] {
            await refused("不能在这里卸载") { try await v.native.uninstall(other) }
        }
        // A program folder that is a link to somewhere else is left where it is: only the command goes.
        let elsewhere = v.root.appendingPathComponent("volume/claude").path
        try v.fm.createDirectory(atPath: "\(elsewhere)/versions", withIntermediateDirectories: true)
        try v.fm.removeItem(atPath: "\(home)/.local/share/claude")
        try v.fm.createSymbolicLink(atPath: "\(home)/.local/share/claude", withDestinationPath: elsewhere)
        v.write("\(elsewhere)/versions/2.1.285", "#!/bin/sh\necho '2.1.285 (Claude Code)'\n")
        try v.fm.removeItem(atPath: "\(home)/.local/bin/claude")
        try v.fm.createSymbolicLink(atPath: "\(home)/.local/bin/claude", withDestinationPath: "\(home)/.local/share/claude/versions/2.1.285")
        XCTAssertEqual(AgentNative.uninstallPaths(.claude, layout: v.layout), ["\(home)/.local/bin/claude"])
        // An OpenCode folder with something else in it stays; an `opencode2` that is not the script's stays.
        try await v.native.install(.opencode, version: "2.0.24")
        v.write("\(home)/.opencode/bin/opencode2", "#!/bin/sh\necho my own second opencode\n")
        v.write("\(home)/.opencode/notes.txt", "mine")
        try await v.native.uninstall(try XCTUnwrap(v.stable(.opencode)))
        XCTAssertEqual(v.names("\(home)/.opencode/bin"), ["opencode2"])
        XCTAssertTrue(v.exists("\(home)/.opencode/notes.txt"))
    }

    func testPiIsFoundWhereverItsInstallerPutItsCommand() async throws {
        let v = Vendor(), home = v.home
        v.publishInstallers()
        // No folder of the PATH to put it in: the launcher is the command, and the row says it is not on the PATH.
        v.write("\(home)/pi-bin", "\(home)/.pi/agent/bin")
        try await v.native.install(.pi, version: nil)
        var install = try XCTUnwrap(v.stable(.pi))
        XCTAssertEqual(install.binary, "\(home)/.pi/agent/bin/pi")
        XCTAssertEqual(install.version, "1.0.4")
        XCTAssertEqual(AgentText.offPathFolder(install, layout: v.layout, path: "/usr/bin:\(home)/.local/bin"), "\(home)/.pi/agent/bin")
        XCTAssertEqual(AgentNative.uninstallPaths(.pi, layout: v.layout), ["\(home)/.pi/agent/bin/pi", "\(home)/.pi/agent/install"])
        try await v.native.uninstall(install)
        XCTAssertNil(v.stable(.pi))
        // Homebrew's bin (here a folder standing for it): the command is a link there, found by pi's own note of it.
        let brew = v.root.appendingPathComponent("homebrew/bin").path
        v.write("\(home)/pi-bin", brew)
        try await v.native.install(.pi, version: nil)
        install = try XCTUnwrap(v.stable(.pi))
        XCTAssertEqual(install.binary, "\(brew)/pi")
        XCTAssertNil(AgentText.offPathFolder(install, layout: v.layout, path: "\(brew):/usr/bin"))
        // It is one install, not the vendor's and an unknown other.
        let report = try XCTUnwrap(AgentInventory.scan(layout: v.layout, path: "\(brew):/usr/bin").first { $0.agent == .pi })
        XCTAssertEqual(report.installs.map(\.key), ["stable"])
        XCTAssertEqual(AgentNative.uninstallPaths(.pi, layout: v.layout), ["\(brew)/pi", "\(home)/.pi/agent/bin/pi", "\(home)/.pi/agent/install"])
        try await v.native.uninstall(install)
        XCTAssertFalse(v.exists("\(brew)/pi"))
        XCTAssertNil(v.stable(.pi))
        // A note that names a command which is not pi's launcher is not believed.
        v.write("\(home)/pi-bin", "\(home)/.local/bin")
        try await v.native.install(.pi, version: nil)
        v.write("\(home)/.pi/agent/install/managed-install.json", #"{"entrypoint":{"type":"symlink","path":"/bin/ls"}}"#, mode: 0o644)
        XCTAssertEqual(v.stable(.pi)?.binary, "\(home)/.local/bin/pi")
        XCTAssertEqual(AgentNative.uninstallPaths(.pi, layout: v.layout), ["\(home)/.local/bin/pi", "\(home)/.pi/agent/bin/pi", "\(home)/.pi/agent/install"])
    }

    func testOldVersionsAreCleared() async throws {
        let v = Vendor(), home = v.home
        v.publishClaude("2.1.285")
        v.publishInstallers()
        try await v.native.install(.claude, version: "2.1.285")
        try await v.native.install(.pi, version: nil)
        try await v.native.install(.codex, version: nil)
        let versions = "\(home)/.local/share/claude/versions"
        for old in ["2.1.28", "2.1.280", "2.1.284"] { v.write("\(versions)/\(old)", "old") }
        v.write("\(versions)/notes.txt", "not a version")
        v.write("\(home)/.pi/agent/install/releases/1.0.3/node_modules/x.js", "old")
        // One of the old ones still runs: it stays and is named; the rest go. `2.1.28` is not `2.1.280`.
        v.run(["\(versions)/2.1.280", "\(versions)/2.1.285"])
        await refused("未能清除 2.1.280") { try await v.native.clean(.claude) }
        XCTAssertEqual(v.names(versions), ["2.1.280", "2.1.285", "notes.txt"])
        v.run(["\(versions)/2.1.285"])
        let phases = Phases()
        try await v.native.clean(.claude) { phases.add($0) }
        XCTAssertEqual(phases.get(), [.removing])
        XCTAssertEqual(v.names(versions), ["2.1.285", "notes.txt"], "the current one, and what is no version, stay")
        XCTAssertEqual(v.stable(.claude)?.version, "2.1.285")
        try await v.native.clean(.pi)
        XCTAssertEqual(v.names("\(home)/.pi/agent/install/releases"), ["1.0.4"])
        // Nothing to clear is no error; Codex and OpenCode keep nothing beside the current one.
        let nothing = Phases()
        try await v.native.clean(.claude) { nothing.add($0) }
        try await v.native.clean(.codex) { nothing.add($0) }
        try await v.native.clean(.opencode) { nothing.add($0) }
        XCTAssertEqual(nothing.get(), [])
    }

    // MARK: what is said, what runs

    /// The real vendors, a home of its own (`AGENTSWITCH_AGENTS_LIVE=native swift test --filter AgentNativeTests/testLiveNative`):
    /// each agent installed by its vendor's own installer, updated by its own updater, uninstalled — some 600 MB
    /// downloaded, so it is skipped otherwise. The installers are given that home and nothing of the real one.
    func testLiveNative() async throws {
        guard ProcessInfo.processInfo.environment["AGENTSWITCH_AGENTS_LIVE"] == "native" else {
            throw XCTSkip("set AGENTSWITCH_AGENTS_LIVE=native to run the four vendors' installers in a temporary home")
        }
        let fm = FileManager.default
        let root = TestSupport.tempDir("live-native").resolvingSymlinksInPath()
        defer { try? fm.removeItem(at: root) }
        let home = root.appendingPathComponent("home").path, tools = root.appendingPathComponent("tools").path
        for folder in [home, tools] { try fm.createDirectory(atPath: folder, withIntermediateDirectories: true) }
        // pi's installer needs node and npm: those two and nothing else of this Mac's own tools.
        for tool in ["node", "npm"] {
            let found = TestSupport.searchPath.split(separator: ":").map { "\($0)/\(tool)" }.first { fm.isExecutableFile(atPath: $0) }
            try fm.createSymbolicLink(atPath: "\(tools)/\(tool)", withDestinationPath: AgentInventory.real(try XCTUnwrap(found, "\(tool) is needed for pi")))
        }
        let layout = AgentLayout(home: home, appCodex: [])
        let path = "\(tools):/usr/bin:/bin:/usr/sbin:/sbin"
        let environment = ["HOME": home, "PATH": path, "SHELL": "/bin/zsh", "USER": NSUserName(), "LANG": "en_US.UTF-8"]
        let native = AgentNative(layout: layout, environment: environment)
        let info = await AgentReleases.check()
        func found(_ agent: AgentCLI) async -> AgentInstall? {
            let reports = await AgentInventory.withVersions(AgentInventory.scan(layout: layout, path: path), path: path, environment: environment)
            return reports.first { $0.agent == agent }?.install("stable")
        }
        // `AGENTSWITCH_AGENTS_ONLY=opencode,pi` runs some of the four.
        let only = ProcessInfo.processInfo.environment["AGENTSWITCH_AGENTS_ONLY"]?.split(separator: ",").map(String.init)
        let chosen = AgentCLI.allCases.filter { only?.contains($0.rawValue) ?? true }
        for agent in chosen {
            let version = try XCTUnwrap(info.channels(agent)?.stable, "\(agent.title) has a stable version")
            let started = Date()
            try await native.install(agent, version: version)
            let now = await found(agent)
            let install = try XCTUnwrap(now, "\(agent.title) is installed")
            print("== \(agent.title) \(install.version ?? "?") in \(Int(Date().timeIntervalSince(started))) s → \(install.binary.replacingOccurrences(of: home, with: "~"))")
            XCTAssertEqual(install.version, version, agent.title)
            XCTAssertEqual(AgentStore.teams[agent] == nil, agent == .pi)
            // Its own updater, with nothing newer to find.
            try await native.update(install, to: version)
            let after = await found(agent)
            XCTAssertEqual(after?.version, version, "\(agent.title) after its own update")
        }
        let profiles = [".zshrc", ".zshenv", ".zprofile", ".profile", ".bashrc"].compactMap { name in
            fm.contents(atPath: "\(home)/\(name)").map { "\(name):\n" + String(decoding: $0, as: UTF8.self) }
        }
        print("== shell profiles the installers wrote:\n\(profiles.joined(separator: "\n"))")
        print("== home with all four: \(((try? fm.contentsOfDirectory(atPath: home)) ?? []).sorted()) \(AgentText.size(AgentInventory.size(of: home)))")
        for agent in chosen {
            let now = await found(agent)
            let install = try XCTUnwrap(now)
            try await native.uninstall(install)
            let gone = await found(agent)
            XCTAssertNil(gone, "\(agent.title) is uninstalled")
        }
        print("== home after uninstalling: \(((try? fm.contentsOfDirectory(atPath: home)) ?? []).sorted()) \(AgentText.size(AgentInventory.size(of: home)))")
        XCTAssertFalse(fm.fileExists(atPath: "\(home)/.local/share/agentswitch"))
    }

    func testTheQuestionsBeforeUninstallingAndClearing() {
        let l = AgentLayout(home: "/Users/u")
        let claude = AgentInstall(agent: .claude, source: .stable, key: "stable", binary: l.command(.claude), command: "claude",
                                  location: "/Users/u/.local/share/claude/versions/2.1.291", version: "2.1.291", bytes: 233_211_568)
        let app = AgentInstall(agent: .codex, source: .app, key: "app", binary: "/Applications/ChatGPT.app/x", location: "/Applications/ChatGPT.app/x", version: "0.160.1")
        let plain = AgentText.uninstallQuestion(claude, paths: ["/Users/u/.local/bin/claude", "/Users/u/.local/share/claude"], bytes: 692_000_000, inUse: false, next: nil, home: l.home)
        XCTAssertEqual(plain.title, "卸载 Claude Code Stable 2.1.291？")
        XCTAssertEqual(plain.message, "将从这台 Mac 上卸载 Claude Code 2.1.291（692 MB）。命令行里的 claude 将不可用。\n~/.local/bin/claude\n~/.local/share/claude\n登录、配置和会话记录不受影响。")
        let codex = AgentInstall(agent: .codex, source: .stable, key: "stable", binary: l.command(.codex), command: "codex", location: l.programRoot(.codex))
        let used = AgentText.uninstallQuestion(codex, paths: [l.command(.codex)], bytes: nil, inUse: true, next: app, home: l.home)
        XCTAssertEqual(used.title, "卸载 Codex Stable？")
        XCTAssertEqual(used.message, "将从这台 Mac 上卸载 Codex。命令行里的 codex 将不可用。\n~/.local/bin/codex\n登录、配置和会话记录不受影响。\nAgentSwitch 正在使用此版本，卸载后改用 ChatGPT App 0.160.1，重启服务后生效。")
        XCTAssertTrue(AgentText.uninstallQuestion(claude, paths: [], bytes: nil, inUse: true, next: nil, home: l.home).message.hasSuffix("AgentSwitch 正在使用此版本，卸载后将没有可用的 Claude Code。"))
        let old = AgentLeftovers(versions: ["2.1.288", "2.1.289"], paths: ["/Users/u/.local/share/claude/versions/2.1.288", "/Users/u/.local/share/claude/versions/2.1.289"], bytes: 459_000_000)
        let clean = AgentText.cleanQuestion(.claude, leftovers: old, current: "2.1.291", home: l.home)
        XCTAssertEqual(clean.title, "清除 Claude Code 的旧版本？")
        XCTAssertEqual(clean.message, "将删除 2.1.288、2.1.289，共 459 MB。当前版本 2.1.291 保留。\n~/.local/share/claude/versions")
    }

    func testAnOperationLeavesOneLogAndTheNextStartsItOver() async throws {
        let v = Vendor()
        v.publishInstallers()
        let file = v.root.appendingPathComponent("logs/agent-codex.log")
        var log = AgentLog(file: file, title: "Install Codex Stable")
        var native = v.native
        native.log = { [log] in log.add($0) }
        try await native.install(.codex, version: nil)
        var text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("=== 20"), text)
        XCTAssertTrue(text.contains("Install Codex Stable\ninstaller https://chatgpt.com/codex/install.sh sha256:"), text)
        XCTAssertTrue(text.contains("$ /bin/sh \(v.layout.downloads)/"), text)
        XCTAssertTrue(text.contains("  [CODEX_NON_INTERACTIVE]\n"), "what was set for it is named, not its value")
        XCTAssertTrue(text.hasSuffix("exit 0\n"), text)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        // A failure: the end of what the program said, as it said it, and how it ended.
        log = AgentLog(file: file, title: "Uninstall Codex Stable")
        native.log = { [log] in log.add($0) }
        let install = try XCTUnwrap(v.stable(.codex))
        try await native.uninstall(install)
        text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(text.contains("Install Codex Stable"), "the one before is gone")
        XCTAssertTrue(text.contains("removed \(v.home)/.local/bin/codex\n"), text)
        XCTAssertTrue(text.contains("removed \(v.home)/.codex/packages/standalone\n"), text)
        v.write("\(v.home)/fail-installer", "")
        log = AgentLog(file: file, title: "Install Codex Stable")
        native.log = { [log] in log.add($0) }
        await refused("安装未完成") { try await native.install(.codex, version: nil) }
        text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(text.hasSuffix("  error: no space left on device\nexit 1\n"), text)
    }

    func testTheLastWordsOfAProgram() {
        let spinner = "\u{1B}[?25l│\n◒  Upgrading\u{1B}[999D\u{1B}[J◐  Upgrading.\u{1B}[999D\u{1B}[J◇  Upgrade complete\n\u{1B}[?25h│\n└  Done\n\n"
        XCTAssertEqual(AgentNative.lastWords(spinner), "Upgrade complete Done")
        XCTAssertEqual(AgentNative.lastWords(spinner, lines: 9), "Upgrading Upgrading. Upgrade complete Done")
        XCTAssertEqual(AgentNative.plainLines("◒  Upgrading\u{1B}[999D\u{1B}[J◐  Upgrading\u{1B}[999D\u{1B}[J◓  Upgrading.\n"), ["Upgrading", "Upgrading."], "a frame drawn again is one line")
        XCTAssertEqual(AgentNative.lastWords("\u{1B}[31merror:\u{1B}[0m no space left on device\n\n"), "error: no space left on device")
        XCTAssertEqual(AgentNative.lastWords("a\nb\r\nc\n", lines: 2), "b c")
        XCTAssertEqual(AgentNative.lastWords("│\n└\n"), "")
        XCTAssertEqual(AgentNative.lastWords(String(repeating: "x", count: 900)).count, 300)
    }

    func testWhatCountsAsRunning() {
        let path = "/Users/u/.local/share/claude/versions/2.1.28"
        XCTAssertTrue(AgentStore.runs(path, path))
        XCTAssertTrue(AgentStore.runs("\(path) --resume", path))
        XCTAssertTrue(AgentStore.runs("node \(path)/cli.js", path))
        XCTAssertTrue(AgentStore.runs("/bin/sh \(path)", path))
        XCTAssertFalse(AgentStore.runs("\(path)8", path), "2.1.288 is another version")
        XCTAssertFalse(AgentStore.runs("\(path)8 --resume", path))
        XCTAssertFalse(AgentStore.runs("/usr/bin/vim notes", path))
        // The processes of this Mac are told by the real path of their program: this test's own is among them.
        let me = AgentInventory.real(Bundle.main.executablePath ?? CommandLine.arguments[0])
        XCTAssertTrue(AgentStore.executables().contains(me), me)
    }

    func testACommandThatIsNotOnThePathIsSaid() {
        let l = AgentLayout(home: "/Users/u")
        let claude = AgentInstall(agent: .claude, source: .stable, key: "stable", binary: l.command(.claude), command: "claude", location: "/x", version: "2.1.285")
        let opencode = AgentInstall(agent: .opencode, source: .stable, key: "stable", binary: l.command(.opencode), command: "opencode", location: l.command(.opencode))
        let beta = AgentInstall(agent: .codex, source: .beta, key: "beta", binary: l.launcher(.codex, .beta, "0.162.0-alpha.16"), command: "codex-beta", location: "/x")
        let path = "/usr/bin:/bin:/Users/u/.local/bin"
        XCTAssertNil(AgentText.offPathFolder(claude, layout: l, path: path))
        XCTAssertNil(AgentText.offPathFolder(beta, layout: l, path: path), "the beta's name is in ~/.local/bin, not where its launcher is")
        XCTAssertEqual(AgentText.offPathFolder(opencode, layout: l, path: path), "/Users/u/.opencode/bin")
        XCTAssertEqual(AgentText.offPathFolder(beta, layout: l, path: "/usr/bin:/bin"), "/Users/u/.local/bin")
        // A beta whose name was taken, a pinned version, the app's copy: no name to miss.
        let unnamed = AgentInstall(agent: .codex, source: .beta, key: "beta", binary: "/x", location: "/x")
        let app = AgentInstall(agent: .codex, source: .app, key: "app", binary: "/Applications/ChatGPT.app/x", location: "/Applications/ChatGPT.app/x")
        XCTAssertNil(AgentText.offPathFolder(unnamed, layout: l, path: "/usr/bin"))
        XCTAssertNil(AgentText.offPathFolder(app, layout: l, path: "/usr/bin"))
        // At the foot of the page: each folder once, its commands, the line to add. Nothing when the shell could not be asked.
        let reports = [AgentReport(agent: .claude, installs: [claude]), AgentReport(agent: .codex, installs: [beta, app]), AgentReport(agent: .opencode, installs: [opencode])]
        XCTAssertEqual(AgentText.pathNotes(reports, layout: l, path: path), ["~/.opencode/bin 不在 PATH 中，新开的终端里还不能直接使用 opencode。可在 shell 配置中加入：export PATH=\"$HOME/.opencode/bin:$PATH\""])
        XCTAssertEqual(AgentText.pathNotes(reports, layout: l, path: "/usr/bin:/Users/u/.opencode/bin"),
                       ["~/.local/bin 不在 PATH 中，新开的终端里还不能直接使用 claude、codex-beta。可在 shell 配置中加入：export PATH=\"$HOME/.local/bin:$PATH\""])
        XCTAssertEqual(AgentText.pathNotes(reports, layout: l, path: "/Users/u/.local/bin:/Users/u/.opencode/bin"), [])
        XCTAssertEqual(AgentText.pathNotes(reports, layout: l, path: nil), [])
    }
}
