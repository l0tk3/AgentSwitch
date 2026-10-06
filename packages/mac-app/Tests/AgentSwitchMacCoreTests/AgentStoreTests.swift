import CryptoKit
import XCTest
@testable import AgentSwitchMacCore

/// docs/agents-v0.md §2, §5–§7: AgentSwitch's own store of betas and pinned versions. The vendors here are fixtures —
/// their release facts are fixed answers and their files local ones — so nothing is downloaded and nothing real runs.
final class AgentStoreTests: XCTestCase {
    // MARK: what a version is as a file

    func testAClaudeCodeManifestACodexReleaseAnOpenCodePackage() {
        let hex = String(repeating: "ab", count: 32)
        let manifest = Data(#"{"version":"2.1.291","platforms":{"darwin-arm64":{"binary":"claude","checksum":"\#(hex)","size":233211568},"linux-x64":{"binary":"claude","checksum":"00","size":1}}}"#.utf8)
        let claude = AgentArtifacts.claude(manifest: manifest, version: "2.1.291", platform: .arm64)
        XCTAssertEqual(claude, AgentArtifact(url: URL(string: "https://downloads.claude.ai/claude-code-releases/2.1.291/darwin-arm64/claude")!,
                                             digest: .sha256(hex), size: 233_211_568, kind: .program(name: "claude")))
        XCTAssertNil(AgentArtifacts.claude(manifest: manifest, version: "2.1.291", platform: .x64), "no file for this Mac")
        XCTAssertNil(AgentArtifacts.claude(manifest: Data(#"{"platforms":{"darwin-arm64":{"checksum":"not-a-digest"}}}"#.utf8), version: "2.1.291", platform: .arm64))

        let release = Data(#"""
        {"tag_name":"rust-v0.162.0-alpha.16","prerelease":true,"assets":[
          {"name":"codex-aarch64-apple-darwin.tar.gz","size":1,"digest":"sha256:\#(hex)","browser_download_url":"https://github.com/openai/codex/releases/download/rust-v0.162.0-alpha.16/codex-aarch64-apple-darwin.tar.gz"},
          {"name":"codex-package-aarch64-apple-darwin.tar.gz","size":129977637,"digest":"sha256:\#(hex.uppercased())","browser_download_url":"https://github.com/openai/codex/releases/download/rust-v0.162.0-alpha.16/codex-package-aarch64-apple-darwin.tar.gz"},
          {"name":"codex-package-x86_64-apple-darwin.tar.gz","size":2,"digest":"sha256:\#(hex)","browser_download_url":"https://evil.example/codex-package-x86_64-apple-darwin.tar.gz"}]}
        """#.utf8)
        let codex = AgentArtifacts.codex(release: release, platform: .arm64)
        XCTAssertEqual(codex?.url.absoluteString, "https://github.com/openai/codex/releases/download/rust-v0.162.0-alpha.16/codex-package-aarch64-apple-darwin.tar.gz")
        XCTAssertEqual(codex?.digest, .sha256(hex))
        XCTAssertEqual(codex?.size, 129_977_637)
        XCTAssertEqual(codex?.program, "bin/codex")
        XCTAssertNil(AgentArtifacts.codex(release: release, platform: .x64), "a file from another host is not taken")

        let integrity = "sha512-" + Data(repeating: 7, count: 64).base64EncodedString()
        let package = Data(#"{"name":"@opencode/cli-darwin-arm64","version":"0.0.0-beta-19507","dist":{"tarball":"https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-0.0.0-beta-19507.tgz","integrity":"\#(integrity)","unpackedSize":179357602}}"#.utf8)
        let opencode = AgentArtifacts.opencode(package: package, platform: .arm64)
        XCTAssertEqual(opencode?.kind, .packed(path: "package/bin/opencode", name: "opencode"))
        XCTAssertEqual(opencode?.digest, .sha512(Data(repeating: 7, count: 64).base64EncodedString()))
        XCTAssertNil(AgentArtifacts.opencode(package: package, platform: .x64), "another platform's package")
        XCTAssertNil(AgentArtifacts.opencode(package: Data(package.map { $0 == UInt8(ascii: "r") ? UInt8(ascii: "x") : $0 }), platform: .arm64))
        // Only a version makes an address; pi is not stored.
        XCTAssertNil(AgentArtifacts.lookup(.claude, version: "../x", platform: .arm64))
        XCTAssertNil(AgentArtifacts.lookup(.pi, version: "1.0.4", platform: .arm64))
        XCTAssertEqual(AgentArtifacts.lookup(.codex, version: "0.160.1", platform: .arm64)?.url.absoluteString, "https://api.github.com/repos/openai/codex/releases/tags/rust-v0.160.1")
        XCTAssertEqual(AgentArtifacts.lookup(.opencode, version: "2.0.24", platform: .arm64)?.url.absoluteString, "https://registry.npmjs.org/@opencode%2fcli-darwin-arm64/2.0.24")
    }

    func testADigestIsWhatTheFileHashesTo() throws {
        let file = TestSupport.tempDir("digest").appendingPathComponent("f")
        let data = Data((0..<300_000).map { UInt8($0 % 251) })
        try data.write(to: file)
        let sha256 = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let sha512 = Data(SHA512.hash(data: data)).base64EncodedString()
        XCTAssertTrue(try AgentDigest.sha256(sha256).matches(file: file))
        XCTAssertTrue(try XCTUnwrap(AgentDigest.sha256(parsing: "sha256:" + sha256.uppercased())).matches(file: file))
        XCTAssertTrue(try XCTUnwrap(AgentDigest.sha512(parsing: "sha512-" + sha512)).matches(file: file))
        XCTAssertFalse(try AgentDigest.sha256(String(repeating: "0", count: 64)).matches(file: file))
        XCTAssertNil(AgentDigest.sha256(parsing: "sha256:abc"))
        XCTAssertNil(AgentDigest.sha512(parsing: "sha512-AAAA"))
        XCTAssertNil(AgentDigest.sha512(parsing: sha512))
    }

    // MARK: a vendor made of fixtures

    /// A store in a temporary home, and vendors whose release files are local: `publish` puts a version out, the
    /// store's fetch and download are answered from what was published.
    private final class World: @unchecked Sendable {
        let root = TestSupport.tempDir("store").resolvingSymlinksInPath()
        let layout: AgentLayout
        private let lock = NSLock()
        private var answers: [String: Data] = [:]
        private var files: [String: URL] = [:]
        private var teams: [String: String] = [:]
        private var running: [String] = []
        private(set) var downloads = 0
        let fm = FileManager.default

        init() {
            // No ChatGPT.app in this world: the test never sees what is installed on the Mac it runs on.
            layout = AgentLayout(home: root.appendingPathComponent("home").path, appCodex: [])
            try? fm.createDirectory(atPath: layout.home, withIntermediateDirectories: true)
        }

        var store: AgentStore {
            var store = AgentStore(layout: layout, environment: ["PATH": "/usr/bin:/bin", "HOME": layout.home])
            store.platform = .arm64
            store.fetch = { [self] url in
                guard let data = locked({ answers[url.absoluteString] }) else { throw CommandError("404") }
                return data
            }
            store.download = { [self] from, to, progress in
                guard let file = locked({ files[from.absoluteString] }) else { throw AgentError("发布地址上没有这个文件。") }
                locked { downloads += 1 }
                progress(1, 2)
                try FileManager.default.copyItem(at: file, to: to)
                progress(2, 2)
            }
            // The signature is the fixture's: who the test says signed the staged program, by its file name.
            store.signer = { [self] program in locked({ teams[(program as NSString).lastPathComponent] }) }
            store.runningPrograms = { [self] in locked { running } }
            return store
        }

        private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }
        func signed(_ program: String, by team: String?) { locked { teams[program] = team } }
        func run(_ paths: [String]) { locked { running = paths } }

        private func script(_ says: String) -> String { "#!/bin/sh\necho '\(says)'\necho \"updater=${DISABLE_AUTOUPDATER:-on}${OPENCODE_DISABLE_AUTOUPDATE:-}\"\n" }

        private func sha256(_ url: URL) -> String { SHA256.hash(data: (try? Data(contentsOf: url)) ?? Data()).map { String(format: "%02x", $0) }.joined() }

        /// Claude Code: the program itself, described by a manifest.
        func publishClaude(_ version: String, says: String? = nil, digest: String? = nil) {
            let file = root.appendingPathComponent("vendor/claude-\(version)")
            try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: file.path, contents: Data(script(says ?? "\(version) (Claude Code)").utf8))
            let size = (try? fm.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
            let manifest = #"{"platforms":{"darwin-arm64":{"binary":"claude","checksum":"\#(digest ?? sha256(file))","size":\#(size)}}}"#
            locked {
                answers["\(AgentReleases.claudeBase)/\(version)/manifest.json"] = Data(manifest.utf8)
                files["\(AgentReleases.claudeBase)/\(version)/darwin-arm64/claude"] = file
            }
        }

        /// A `tar.gz` of `entries` (path → text; a text starting with `->` makes a link).
        func archive(_ name: String, _ entries: [String: String]) -> URL {
            let stage = root.appendingPathComponent("vendor/stage-\(UUID().uuidString.prefix(6))")
            for (path, text) in entries {
                let at = stage.appendingPathComponent(path)
                try? fm.createDirectory(at: at.deletingLastPathComponent(), withIntermediateDirectories: true)
                if text.hasPrefix("->") {
                    try? fm.createSymbolicLink(atPath: at.path, withDestinationPath: String(text.dropFirst(2)))
                } else {
                    fm.createFile(atPath: at.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o755])
                }
            }
            let out = root.appendingPathComponent("vendor/\(name)")
            let tops = (try? fm.contentsOfDirectory(atPath: stage.path)) ?? []
            _ = try? ProcessRunner.runBlocking(URL(fileURLWithPath: "/usr/bin/tar"), ["-czf", out.path, "-C", stage.path] + tops, timeout: 30)
            return out
        }

        /// Codex: its package, described by a GitHub release.
        func publishCodex(_ version: String, extra: [String: String] = [:]) {
            let file = archive("codex-package-\(version).tar.gz", ["bin/codex": script("codex-cli \(version)"), "bin/codex-code-mode-host": "host",
                                                                  "codex-package.json": "{}", "codex-path/rg": "rg"].merging(extra) { _, new in new })
            let url = "https://github.com/openai/codex/releases/download/rust-v\(version)/codex-package-aarch64-apple-darwin.tar.gz"
            let release = #"{"tag_name":"rust-v\#(version)","assets":[{"name":"codex-package-aarch64-apple-darwin.tar.gz","digest":"sha256:\#(sha256(file))","browser_download_url":"\#(url)"}]}"#
            locked {
                answers["\(AgentReleases.codexGitHub)/tags/rust-v\(version)"] = Data(release.utf8)
                files[url] = file
            }
        }

        /// OpenCode: an npm package whose program is `package/bin/opencode`.
        func publishOpenCode(_ version: String) {
            let file = archive("opencode-\(version).tgz", ["package/bin/opencode": script("opencode v\(version)"), "package/package.json": "{}"])
            let url = "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-\(version).tgz"
            let integrity = "sha512-" + Data(SHA512.hash(data: (try? Data(contentsOf: file)) ?? Data())).base64EncodedString()
            locked {
                answers["https://registry.npmjs.org/@opencode%2fcli-darwin-arm64/\(version)"] = Data(#"{"dist":{"tarball":"\#(url)","integrity":"\#(integrity)"}}"#.utf8)
                files[url] = file
            }
        }

        func found(_ agent: AgentCLI) -> AgentReport {
            AgentInventory.scan(layout: layout, path: "\(layout.binDir):/usr/bin").first { $0.agent == agent }!
        }

        func leftInDownloads() -> [String] { (try? fm.contentsOfDirectory(atPath: layout.downloads)) ?? [] }
        func names(_ folder: String) -> [String] { ((try? fm.contentsOfDirectory(atPath: folder)) ?? []).sorted() }
    }

    /// The phases a job reported, in order (reported from wherever the download calls back).
    private final class Phases: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [AgentStore.Phase] = []
        func add(_ phase: AgentStore.Phase) { lock.lock(); seen.append(phase); lock.unlock() }
        func get() -> [AgentStore.Phase] { lock.lock(); defer { lock.unlock() }; return seen }
    }

    private func output(_ program: String, _ arguments: [String] = ["--version"]) throws -> String {
        try ProcessRunner.runBlocking(URL(fileURLWithPath: program), arguments, environment: ["PATH": "/usr/bin:/bin"], timeout: 10).stdoutText
    }

    // MARK: installing

    func testABetaIsDownloadedCheckedPutInPlaceAndNamedOnTheCommandLine() async throws {
        let world = World()
        world.publishClaude("2.1.291")
        world.signed("claude", by: "Q6L2SF6YDW")
        let phases = Phases()
        let install = try await world.store.install(.claude, .beta, version: "2.1.291") { phases.add($0) }
        let l = world.layout
        XCTAssertEqual(install, AgentInstall(agent: .claude, source: .beta, key: "beta", binary: l.launcher(.claude, .beta, "2.1.291"), command: "claude-beta",
                                             location: l.storeVersion(.claude, .beta, "2.1.291"), version: "2.1.291"))
        XCTAssertEqual(world.names(install.location), ["claude", "launch"])
        // The scan finds what was installed, the same.
        XCTAssertEqual(world.found(.claude).installs, [install])
        // The launcher starts this copy with its own updater off; `claude-beta` is that launcher.
        XCTAssertEqual(try output(install.binary), "2.1.291 (Claude Code)\nupdater=1\n")
        XCTAssertEqual(try output("\(l.binDir)/claude-beta"), "2.1.291 (Claude Code)\nupdater=1\n")
        XCTAssertEqual(try world.fm.destinationOfSymbolicLink(atPath: "\(l.binDir)/claude-beta"), install.binary)
        XCTAssertEqual(world.leftInDownloads(), [], "the download is gone once it is used")
        XCTAssertEqual(phases.get().first, .resolving)
        XCTAssertEqual(phases.get().last, .checking)
        XCTAssertTrue(phases.get().contains(.downloading(received: 2, total: 2)))
        XCTAssertTrue(phases.get().contains(.verifying))
    }

    func testAFileThatIsNotTheVendorsNeverArrives() async throws {
        let world = World()
        world.signed("claude", by: "Q6L2SF6YDW")
        func refused(_ version: String, _ words: String, file: StaticString = #filePath, line: UInt = #line) async {
            do {
                _ = try await world.store.install(.claude, .beta, version: version)
                XCTFail("installed", file: file, line: line)
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(words), "\(error.localizedDescription)", file: file, line: line)
            }
            XCTAssertEqual(world.found(.claude).installs, [], file: file, line: line)
            XCTAssertEqual(world.leftInDownloads(), [], file: file, line: line)
            XCTAssertNil(try? world.fm.destinationOfSymbolicLink(atPath: "\(world.layout.binDir)/claude-beta"), file: file, line: line)
        }
        // Not the bytes the manifest names.
        world.publishClaude("2.1.290", digest: String(repeating: "0", count: 64))
        await refused("2.1.290", "校验值不符")
        // The right bytes, the wrong signer.
        world.publishClaude("2.1.291")
        world.signed("claude", by: "EVIL000000")
        await refused("2.1.291", "签名")
        world.signed("claude", by: nil)
        await refused("2.1.291", "签名")
        // Signed, but it is another version than the one asked for; or it does not run.
        world.signed("claude", by: "Q6L2SF6YDW")
        world.publishClaude("2.1.292", says: "2.1.200 (Claude Code)")
        await refused("2.1.292", "版本不是 2.1.292")
        // A version the vendor does not have; a version that is not one; pi.
        await refused("2.1.999", "未找到 Claude Code 2.1.999")
        await refused("latest", "不是一个版本号")
        do { _ = try await world.store.install(.pi, .beta, version: "1.0.4"); XCTFail("pi has no store") } catch {}
        do { _ = try await world.store.install(.claude, .stable, version: "2.1.291"); XCTFail("the vendor's own install is not the store's") } catch {}
    }

    func testCodexKeepsItsPackageAndOpenCodeOnlyItsProgram() async throws {
        let world = World()
        world.publishCodex("0.162.0-alpha.16")
        world.publishOpenCode("0.0.0-beta-19507")
        world.signed("codex", by: "2DC432GLL2")
        world.signed("opencode", by: "5NZ4Q7NXJ4")
        let codex = try await world.store.install(.codex, .beta, version: "0.162.0-alpha.16")
        XCTAssertEqual(world.names(codex.location), ["bin", "codex-package.json", "codex-path", "launch"])
        XCTAssertEqual(world.names("\(codex.location)/bin"), ["codex", "codex-code-mode-host"])
        XCTAssertEqual(try output(codex.binary), "codex-cli 0.162.0-alpha.16\nupdater=on\n", "Codex's copy has no updater to turn off")
        XCTAssertEqual(codex.command, "codex-beta")
        let opencode = try await world.store.install(.opencode, .pinned, version: "0.0.0-beta-19507")
        XCTAssertEqual(world.names(opencode.location), ["launch", "opencode"])
        XCTAssertEqual(try output(opencode.binary), "opencode v0.0.0-beta-19507\nupdater=on1\n")
        XCTAssertNil(opencode.command, "a pinned version is not on the command line")
        XCTAssertEqual(opencode.key, "pinned:0.0.0-beta-19507")
        XCTAssertFalse(world.fm.fileExists(atPath: "\(world.layout.binDir)/opencode-beta"))
        XCTAssertEqual(world.leftInDownloads(), [])
    }

    func testAnArchiveThatReachesOutIsRefused() async throws {
        XCTAssertTrue(AgentStore.safeEntry("bin/codex"))
        XCTAssertTrue(AgentStore.safeEntry("codex-resources/voice/lib/libz.1.dylib"))
        for bad in ["/etc/passwd", "../outside", "bin/../../outside", "a/..", "x\0y"] { XCTAssertFalse(AgentStore.safeEntry(bad), bad) }
        let world = World()
        world.signed("codex", by: "2DC432GLL2")
        // A link in the package that leads out of it.
        world.publishCodex("0.170.0", extra: ["codex-path/escape": "->/etc"])
        do { _ = try await world.store.install(.codex, .beta, version: "0.170.0"); XCTFail("unpacked") } catch {
            XCTAssertTrue(error.localizedDescription.contains("指向外面的链接"), error.localizedDescription)
        }
        XCTAssertEqual(world.found(.codex).installs, [])
        XCTAssertEqual(world.leftInDownloads(), [])
        // One that stays inside is fine.
        world.publishCodex("0.170.1", extra: ["codex-path/rg2": "->rg"])
        _ = try await world.store.install(.codex, .beta, version: "0.170.1")
    }

    // MARK: updating, deleting, sweeping

    func testANewBetaReplacesTheOldOneAndThePinnedOnesStay() async throws {
        let world = World(), l = world.layout
        world.signed("claude", by: "Q6L2SF6YDW")
        for version in ["2.1.280", "2.1.290", "2.1.291"] { world.publishClaude(version) }
        _ = try await world.store.install(.claude, .pinned, version: "2.1.280")
        _ = try await world.store.install(.claude, .beta, version: "2.1.290")
        _ = try await world.store.install(.claude, .beta, version: "2.1.291")
        XCTAssertEqual(world.names(l.storeFolder(.claude, .beta)), ["2.1.291"])
        XCTAssertEqual(world.found(.claude).installs.map(\.key), ["beta", "pinned:2.1.280"])
        XCTAssertEqual(try output("\(l.binDir)/claude-beta"), "2.1.291 (Claude Code)\nupdater=1\n")
        // An old beta still running is left for the sweep; installing the same version again replaces it.
        world.publishClaude("2.1.292")
        world.run(["\(l.storeVersion(.claude, .beta, "2.1.291"))/claude"])
        _ = try await world.store.install(.claude, .beta, version: "2.1.292")
        XCTAssertEqual(world.names(l.storeFolder(.claude, .beta)), ["2.1.291", "2.1.292"])
        XCTAssertEqual(world.found(.claude).install("beta")?.version, "2.1.292")
        world.run([])
        _ = try await world.store.install(.claude, .beta, version: "2.1.292")
        XCTAssertEqual(world.names(l.storeFolder(.claude, .beta)), ["2.1.292"])
    }

    func testANameThatIsSomebodyElsesIsLeftAlone() async throws {
        let world = World(), l = world.layout
        world.signed("claude", by: "Q6L2SF6YDW")
        world.publishClaude("2.1.291")
        try world.fm.createDirectory(atPath: l.binDir, withIntermediateDirectories: true)
        world.fm.createFile(atPath: "\(l.binDir)/claude-beta", contents: Data("#!/bin/sh\necho mine\n".utf8), attributes: [.posixPermissions: 0o755])
        let install = try await world.store.install(.claude, .beta, version: "2.1.291")
        XCTAssertNil(install.command)
        XCTAssertEqual(try output("\(l.binDir)/claude-beta"), "mine\n")
        XCTAssertNil(world.found(.claude).install("beta")?.command)
        // Deleting the beta does not take the user's file with it.
        try await world.store.remove(install)
        XCTAssertEqual(try output("\(l.binDir)/claude-beta"), "mine\n")
    }

    func testDeletingAStoredVersion() async throws {
        let world = World(), l = world.layout
        world.signed("claude", by: "Q6L2SF6YDW")
        for version in ["2.1.280", "2.1.291"] { world.publishClaude(version) }
        let pinned = try await world.store.install(.claude, .pinned, version: "2.1.280")
        let beta = try await world.store.install(.claude, .beta, version: "2.1.291")
        // While it runs: not deleted, and said why.
        world.run(["/usr/bin/zsh", "\(beta.location)/claude"])
        let blocked = await world.store.blocker(beta)
        XCTAssertEqual(blocked, "Claude Code 2.1.291 正在运行。请先关闭使用它的终端或任务。")
        do { try await world.store.remove(beta); XCTFail("deleted while running") } catch {}
        XCTAssertTrue(world.fm.fileExists(atPath: beta.location))
        world.run([])
        let free = await world.store.blocker(beta)
        XCTAssertNil(free)
        try await world.store.remove(beta)
        XCTAssertFalse(world.fm.fileExists(atPath: beta.location))
        XCTAssertNil(try? world.fm.destinationOfSymbolicLink(atPath: "\(l.binDir)/claude-beta"), "its name goes with it")
        XCTAssertEqual(world.found(.claude).installs.map(\.key), ["pinned:2.1.280"])
        try await world.store.remove(pinned)
        XCTAssertEqual(world.found(.claude).installs, [])
        // Only a version's folder in the store is ever deleted.
        let outside = TestSupport.tempDir("precious")
        world.fm.createFile(atPath: outside.appendingPathComponent("keep").path, contents: Data("x".utf8))
        for bad in [AgentInstall(agent: .claude, source: .pinned, key: "pinned:2.1.280", binary: "/x", location: outside.path, version: "2.1.280"),
                    AgentInstall(agent: .claude, source: .stable, key: "stable", binary: "/x", location: l.storeVersion(.claude, .pinned, "2.1.280"), version: "2.1.280"),
                    AgentInstall(agent: .claude, source: .pinned, key: "pinned:..", binary: "/x", location: l.storeFolder(.claude, .pinned), version: ".."),
                    AgentInstall(agent: .codex, source: .app, key: "app", binary: "/x", location: outside.path, version: "0.160.1")] {
            do { try await world.store.remove(bad); XCTFail("removed \(bad.location)") } catch {}
        }
        XCTAssertTrue(world.fm.fileExists(atPath: outside.appendingPathComponent("keep").path))
    }

    func testTheSweepLeavesNoRubbish() async throws {
        let world = World(), l = world.layout
        world.signed("claude", by: "Q6L2SF6YDW")
        for version in ["2.1.290", "2.1.291"] { world.publishClaude(version) }
        _ = try await world.store.install(.claude, .beta, version: "2.1.291")
        // What an interrupted run leaves: a download, a half-made beta, an older beta, a name pointing at nothing.
        try world.fm.createDirectory(atPath: "\(l.downloads)/ABCD/tree", withIntermediateDirectories: true)
        world.fm.createFile(atPath: "\(l.downloads)/ABCD/download", contents: Data(count: 1000))
        try world.fm.createDirectory(atPath: "\(l.storeFolder(.claude, .beta))/2.1.295", withIntermediateDirectories: true)   // no launcher
        try world.fm.createDirectory(atPath: l.storeVersion(.claude, .beta, "2.1.280"), withIntermediateDirectories: true)
        world.fm.createFile(atPath: l.launcher(.claude, .beta, "2.1.280"), contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        try world.fm.createDirectory(atPath: l.storeVersion(.codex, .beta, "0.1.0"), withIntermediateDirectories: true)
        try world.fm.createSymbolicLink(atPath: "\(l.binDir)/codex-beta", withDestinationPath: l.launcher(.codex, .beta, "0.1.0"))
        try world.fm.createDirectory(atPath: l.storeVersion(.claude, .pinned, "2.1.200"), withIntermediateDirectories: true)
        world.fm.createFile(atPath: l.launcher(.claude, .pinned, "2.1.200"), contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        let removed = await world.store.sweep()
        XCTAssertEqual(removed.count, 5)
        XCTAssertEqual(world.leftInDownloads(), [])
        XCTAssertEqual(world.names(l.storeFolder(.claude, .beta)), ["2.1.291"])
        XCTAssertEqual(world.names(l.storeFolder(.codex, .beta)), [])
        XCTAssertNil(try? world.fm.destinationOfSymbolicLink(atPath: "\(l.binDir)/codex-beta"))
        XCTAssertEqual(try output("\(l.binDir)/claude-beta"), "2.1.291 (Claude Code)\nupdater=1\n", "the live beta and its name are untouched")
        XCTAssertEqual(world.names(l.storeFolder(.claude, .pinned)), ["2.1.200"], "pinned versions are the user's to delete")
        let again = await world.store.sweep()
        XCTAssertEqual(again, [])
    }

    /// The real vendors, a home of its own (`AGENTSWITCH_AGENTS_LIVE=store swift test --filter AgentStoreTests/testLiveStore`):
    /// each agent's beta downloaded, checked against the published digest and the vendor's signature, unpacked, run,
    /// named on the command line of that home — some 450 MB, so it is skipped otherwise. Nothing of the real home is touched.
    func testLiveStore() async throws {
        guard ProcessInfo.processInfo.environment["AGENTSWITCH_AGENTS_LIVE"] == "store" else {
            throw XCTSkip("set AGENTSWITCH_AGENTS_LIVE=store to download the three betas into a temporary home")
        }
        let home = TestSupport.tempDir("live-store").resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: home) }
        let layout = AgentLayout(home: home.path, appCodex: [])
        let store = AgentStore(layout: layout, environment: ["HOME": home.path, "PATH": "/usr/bin:/bin"])
        let info = await AgentReleases.check()
        for agent in [AgentCLI.claude, .codex, .opencode] {
            let version = try XCTUnwrap(info.channels(agent)?.beta, "\(agent.title) has a beta")
            let started = Date()
            let last = Phases()
            let install = try await store.install(agent, .beta, version: version) { last.add($0) }
            let said = try output(install.binary).split(separator: "\n").first.map(String.init) ?? ""
            let received = last.get().compactMap { phase -> Int64? in if case .downloading(let got, _) = phase { return got } else { return nil } }.max() ?? 0
            print("== \(agent.title) beta \(version): \(received / 1_000_000) MB in \(Int(Date().timeIntervalSince(started))) s → \(said)  [\(install.command ?? "no command")]")
            XCTAssertEqual(HarnessEvaluator.parseVersion(said), version)
            XCTAssertEqual(install.command, agent.betaCommand)
        }
        let found = AgentInventory.scan(layout: layout, path: layout.binDir)
        XCTAssertEqual(found.flatMap(\.installs).map(\.key), ["beta", "beta", "beta"])
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: layout.downloads)) ?? []
        XCTAssertEqual(leftovers, [])
        print("store: \(AgentText.size(AgentInventory.size(of: layout.store)))")
    }

    func testWhatAJobSaysAndWhenItCanBeCalledOff() {
        XCTAssertEqual([AgentStore.Phase.resolving, .downloading(received: 112_400_000, total: 233_211_568), .downloading(received: 5_000_000, total: nil), .verifying, .unpacking, .checking].map(AgentText.phase),
                       ["Looking Up", "Downloading 112 / 233 MB", "Downloading 5 MB", "Verifying", "Unpacking", "Checking"])
        XCTAssertNil(AgentText.fraction(.resolving))
        XCTAssertEqual(AgentText.fraction(.downloading(received: 50, total: 100)) ?? 0, 0.45, accuracy: 0.001)
        XCTAssertNil(AgentText.fraction(.downloading(received: 50, total: nil)))
        XCTAssertEqual(AgentText.fraction(.checking), 0.98)
        var job = AgentJob(agent: .claude, row: "missing:beta", source: .beta, version: "2.1.291")
        XCTAssertTrue(job.cancellable)
        job.phase = .unpacking
        XCTAssertFalse(job.cancellable, "the files are being put in place")
        job.phase = .downloading(received: 1, total: 2)
        job.error = "下载失败"
        XCTAssertFalse(job.cancellable)
        XCTAssertTrue(job.failed)
        // A download reports every piece; the row hears of it a few times a second, and of every change of phase.
        let gate = AgentProgressGate(interval: 0.2)
        let t = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(gate.pass(.resolving, now: t))
        XCTAssertTrue(gate.pass(.downloading(received: 1, total: 100), now: t))
        XCTAssertFalse(gate.pass(.downloading(received: 2, total: 100), now: t.addingTimeInterval(0.05)))
        XCTAssertTrue(gate.pass(.downloading(received: 30, total: 100), now: t.addingTimeInterval(0.25)))
        XCTAssertTrue(gate.pass(.downloading(received: 100, total: 100), now: t.addingTimeInterval(0.26)), "the last piece")
        XCTAssertTrue(gate.pass(.verifying, now: t.addingTimeInterval(0.27)))
        XCTAssertTrue(gate.pass(.unpacking, now: t.addingTimeInterval(0.27)))
    }

    func testTheQuestionBeforeDeleting() {
        let l = AgentLayout(home: "/Users/u")
        let beta = AgentInstall(agent: .claude, source: .beta, key: "beta", binary: l.launcher(.claude, .beta, "2.1.291"), command: "claude-beta",
                                location: l.storeVersion(.claude, .beta, "2.1.291"), version: "2.1.291", bytes: 233_211_568)
        let stable = AgentInstall(agent: .claude, source: .stable, key: "stable", binary: l.command(.claude), command: "claude", location: "/x", version: "2.1.285")
        let plain = AgentText.deleteQuestion(beta, inUse: false, next: stable, home: l.home)
        XCTAssertEqual(plain.title, "删除 Claude Code Beta 2.1.291？")
        XCTAssertEqual(plain.message, "将从版本库中删除 Claude Code Beta 2.1.291（233 MB）：~/.local/share/agentswitch/cli/claude-code/beta/2.1.291\n命令行里的 claude-beta 将不可用。\n登录、配置和会话记录不受影响。")
        let used = AgentText.deleteQuestion(beta, inUse: true, next: stable, home: l.home)
        XCTAssertTrue(used.message.hasSuffix("AgentSwitch 正在使用此版本，删除后改用 Stable 2.1.285，重启服务后生效。"))
        let pinned = AgentInstall(agent: .codex, source: .pinned, key: "pinned:0.158.0", binary: "/x", location: l.storeVersion(.codex, .pinned, "0.158.0"), version: "0.158.0")
        let last = AgentText.deleteQuestion(pinned, inUse: true, next: nil, home: l.home)
        XCTAssertEqual(last.message, "将从版本库中删除 Codex Pinned 0.158.0：~/.local/share/agentswitch/cli/codex/pinned/0.158.0\n登录、配置和会话记录不受影响。\nAgentSwitch 正在使用此版本，删除后将没有可用的 Codex。")
    }

    func testTheLauncherQuotesWhatItRuns() {
        let text = AgentStore.launcherText(.claude, .beta, version: "2.1.291", program: "/Users/o'brien/.local/share/agentswitch/cli/claude-code/beta/2.1.291/claude")
        XCTAssertTrue(text.hasPrefix("#!/bin/sh\n"))
        XCTAssertTrue(text.contains("DISABLE_AUTOUPDATER='1'; export DISABLE_AUTOUPDATER\n"))
        XCTAssertTrue(text.hasSuffix("exec '/Users/o'\\''brien/.local/share/agentswitch/cli/claude-code/beta/2.1.291/claude' \"$@\"\n"))
        XCTAssertFalse(AgentStore.launcherText(.codex, .pinned, version: "0.160.1", program: "/x/bin/codex").contains("export"))
        XCTAssertTrue(AgentStore.launcherText(.opencode, .beta, version: "2.0.24", program: "/x/opencode").contains("OPENCODE_DISABLE_AUTOUPDATE='1'"))
    }
}
