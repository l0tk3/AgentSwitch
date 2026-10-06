import XCTest
@testable import AgentSwitchMacCore

/// docs/agents-v0.md: what is installed, what is newer, which one AgentSwitch uses. The layouts and the vendors' answers
/// are the ones measured on 2026-10-06.
final class AgentsTests: XCTestCase {
    // MARK: versions

    func testVersionsOrderAsTheVendorsMeanThem() {
        let ordered = ["0.0.0-beta-9", "0.0.0-beta-19507", "0.158.0-alpha.2.1", "0.158.0", "0.160.1", "0.161.0-alpha.13", "0.161.0-alpha.13.1",
                       "0.162.0-alpha.9", "0.162.0-alpha.16", "0.162.0", "2.0.18", "2.0.24", "2.1.285", "2.1.291"]
        XCTAssertEqual(ordered.shuffled().sorted { AgentVersion($0) < AgentVersion($1) }, ordered)
        XCTAssertEqual(AgentVersion("v2.0.18"), AgentVersion("2.0.18"))
        XCTAssertEqual(AgentVersion(" 2.1.291\n").text, "2.1.291")
        XCTAssertTrue(AgentVersion("0.162.0-alpha.16").isPrerelease)
        XCTAssertFalse(AgentVersion("1.0.4").isPrerelease)
        XCTAssertEqual(AgentVersion("1.18.34").major, 1)
    }

    func testOnlyAVersionGoesIntoAPathOrAnAddress() {
        for good in ["2.1.291", "0.162.0-alpha.16", "0.161.0-alpha.13.1", "0.0.0-beta-19507"] { XCTAssertTrue(AgentVersion.isWellFormed(good), good) }
        for bad in ["", "latest", "2.1", "2.1.291/../x", "2.1.291 ", "../2.1.291", "2.1.291;rm", "v2.1.291", "2.1.291-", "<html>"] {
            XCTAssertFalse(AgentVersion.isWellFormed(bad), bad)
        }
    }

    // MARK: what the vendors publish

    func testTheVendorsAnswersAreRead() {
        XCTAssertEqual(AgentReleases.plainVersion(Data("2.1.291\n".utf8)), "2.1.291")
        XCTAssertNil(AgentReleases.plainVersion(Data("<html><body>Not available in your region</body></html>".utf8)))
        XCTAssertEqual(AgentReleases.codexTag(Data(#"{"assets":[{"name":"x","digest":"sha256:00"}],"tag_name":"rust-v0.160.1"}"#.utf8)), "0.160.1")
        // GitHub lists them as published, not in order: 0.161.0-alpha.13.1 came out after 0.162.0-alpha.16.
        let list = #"[{"tag_name":"rust-v0.161.0-alpha.13.1","prerelease":true},{"tag_name":"rust-v0.160.1","prerelease":false},"#
            + #"{"tag_name":"rust-v0.162.0-alpha.16","prerelease":true},{"tag_name":"rust-v0.163.0-alpha.1","prerelease":true,"draft":true},"#
            + #"{"tag_name":"rust-v0.162.0-alpha.9","prerelease":true}]"#
        XCTAssertEqual(AgentReleases.codexPrerelease(Data(list.utf8)), "0.162.0-alpha.16")
        XCTAssertEqual(AgentReleases.jsonVersion(Data(#"{"channel":"latest","name":"cli","version":"2.0.24","active":true}"#.utf8)), "2.0.24")
        XCTAssertEqual(AgentReleases.jsonVersion(Data(#"{"ok":true,"version":"1.0.4","packageName":"@earendil-works/pi-coding-agent"}"#.utf8)), "1.0.4")
        let tags = Data(#"{"reserved":"0.0.0-reserved","beta":"0.0.0-beta-19507","latest":"2.0.24","dev":"0.0.0-dev-20650"}"#.utf8)
        XCTAssertEqual(AgentReleases.npmTag("beta")(tags), "0.0.0-beta-19507")
        XCTAssertNil(AgentReleases.npmTag("nightly")(tags))
        // A version that is not one never leaves the reader.
        XCTAssertNil(AgentReleases.jsonVersion(Data(#"{"version":"../../etc"}"#.utf8)))
        XCTAssertNil(AgentReleases.codexTag(Data(#"{"tag_name":"rust-v0.160.1; rm -rf"}"#.utf8)))
    }

    func testOnlyTheVendorsHostsOverHTTPS() {
        for agent in AgentCLI.allCases {
            let places = AgentReleases.lookups(agent, platform: .arm64)
            for lookup in places.stable + places.beta { XCTAssertTrue(AgentReleases.allowed(lookup.url), lookup.url.absoluteString) }
        }
        XCTAssertTrue(AgentReleases.lookups(.pi, platform: .arm64).beta.isEmpty, "pi publishes no beta")
        XCTAssertFalse(AgentReleases.allowed(URL(string: "http://downloads.claude.ai/claude-code-releases/latest")))
        XCTAssertFalse(AgentReleases.allowed(URL(string: "https://downloads.claude.ai.example.com/latest")))
        XCTAssertFalse(AgentReleases.allowed(URL(string: "https://example.com/")))
        XCTAssertEqual(AgentReleases.opencodeTags(.x64), "https://registry.npmjs.org/-/package/@opencode%2fcli-darwin-x64/dist-tags")
    }

    func testACheckAsksEveryChannelAndKeepsWhatItHadWhenOneFails() async {
        let answers: [String: String] = [
            "\(AgentReleases.claudeBase)/stable": "2.1.285", "\(AgentReleases.claudeBase)/latest": "2.1.291",
            "\(AgentReleases.codexGitHub)/latest": #"{"tag_name":"rust-v0.160.1"}"#,   // the channel file is down: GitHub answers
            "\(AgentReleases.codexGitHub)?per_page=10": #"[{"tag_name":"rust-v0.162.0-alpha.16","prerelease":true}]"#,
            AgentReleases.opencodeLatest: #"{"version":"2.0.24"}"#,
            AgentReleases.piLatest: #"{"ok":true,"version":"1.0.4"}"#,
        ]
        let fetch: AgentReleases.Fetch = { url in
            guard let body = answers[url.absoluteString] else { throw CommandError("down") }
            return Data(body.utf8)
        }
        let before = AgentReleaseInfo(channels: ["opencode": AgentChannels(stable: "2.0.20", beta: "0.0.0-beta-19000")], checkedAt: Date(timeIntervalSince1970: 1))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let info = await AgentReleases.check(platform: .arm64, previous: before, now: now, fetch: fetch)
        XCTAssertEqual(info.channels(.claude), AgentChannels(stable: "2.1.285", beta: "2.1.291"))
        XCTAssertEqual(info.channels(.codex), AgentChannels(stable: "0.160.1", beta: "0.162.0-alpha.16"))
        // OpenCode's beta tag could not be read: the number from before stays, and it is said.
        XCTAssertEqual(info.channels(.opencode), AgentChannels(stable: "2.0.24", beta: "0.0.0-beta-19000"))
        XCTAssertEqual(info.channels(.pi), AgentChannels(stable: "1.0.4", beta: nil))
        XCTAssertEqual(info.failed, ["opencode"])
        XCTAssertEqual(info.checkedAt, now)
        XCTAssertTrue(info.isFresh(at: now.addingTimeInterval(11 * 3600)))
        XCTAssertFalse(info.isFresh(at: now.addingTimeInterval(13 * 3600)))
        // OpenCode did not answer: asked again after an hour, not after the twelve.
        XCTAssertFalse(info.isDue(at: now.addingTimeInterval(1800)))
        XCTAssertTrue(info.isDue(at: now.addingTimeInterval(3700)))
        var whole = info
        whole.failed = []
        XCTAssertFalse(whole.isDue(at: now.addingTimeInterval(11 * 3600)))
        XCTAssertTrue(whole.isDue(at: now.addingTimeInterval(13 * 3600)))
        XCTAssertTrue(whole.isDue(at: now.addingTimeInterval(-60)), "a clock set back")
        XCTAssertTrue(AgentReleaseInfo(channels: [:], checkedAt: nil, failed: []).isDue(at: now), "never asked")
        // Kept between launches.
        let file = TestSupport.tempDir("agents").appendingPathComponent("agents.json")
        try? info.save(to: file)
        XCTAssertEqual(AgentReleaseInfo.load(from: file), info)
        XCTAssertNil(AgentReleaseInfo.load(from: file.deletingLastPathComponent().appendingPathComponent("none.json")))
    }

    // MARK: what is installed

    /// A home laid out as the four vendors lay theirs out, a ChatGPT.app beside it, and one folder on the PATH.
    private struct Mac {
        let root: URL
        let home: String
        let layout: AgentLayout
        let path: String
        let fm = FileManager.default

        init() {
            // Resolved once: the temporary folder is itself behind a link (/var → /private/var).
            root = TestSupport.tempDir("mac").resolvingSymlinksInPath()
            home = root.appendingPathComponent("home").path
            let app = root.appendingPathComponent("Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex").path
            layout = AgentLayout(home: home, appCodex: [app, root.appendingPathComponent("Applications/Codex.app/codex").path])
            path = "\(home)/.local/bin:\(home)/.opencode/bin:\(root.path)/brew/bin:/usr/bin"
            try? fm.createDirectory(atPath: home, withIntermediateDirectories: true)
        }

        func program(_ path: String, _ text: String = "#!/bin/sh\necho test\n") {
            try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            fm.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o755])
        }

        func link(_ from: String, to destination: String) {
            try? fm.createDirectory(atPath: (from as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try? fm.removeItem(atPath: from)
            try? fm.createSymbolicLink(atPath: from, withDestinationPath: destination)
        }

        func write(_ path: String, _ text: String) {
            try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            fm.createFile(atPath: path, contents: Data(text.utf8))
        }

        /// This Mac on 2026-10-06: Claude Code native with two older versions, Codex only in ChatGPT.app, OpenCode 2
        /// where its script puts it, pi's managed install.
        func asMeasured() {
            for version in ["2.1.288", "2.1.289", "2.1.291"] { program("\(home)/.local/share/claude/versions/\(version)") }
            link("\(home)/.local/bin/claude", to: "\(home)/.local/share/claude/versions/2.1.291")
            program(layout.appCodex[0])
            program("\(home)/.opencode/bin/opencode")
            program("\(home)/.pi/agent/bin/pi")
            link("\(home)/.local/bin/pi", to: "../../.pi/agent/bin/pi")
            write("\(home)/.pi/agent/install/current-version", "0.87.1\n")
            program("\(home)/.pi/agent/install/releases/0.87.1/node_modules/.bin/pi")
        }

        func scan() -> [AgentCLI: AgentReport] {
            Dictionary(uniqueKeysWithValues: AgentInventory.scan(layout: layout, path: path).map { ($0.agent, $0) })
        }
    }

    func testThisMacAsItWasMeasured() {
        let mac = Mac()
        mac.asMeasured()
        let found = mac.scan()
        let claude = found[.claude]!
        XCTAssertEqual(claude.installs.map(\.key), ["stable"])
        XCTAssertEqual(claude.installs[0], AgentInstall(agent: .claude, source: .stable, key: "stable", binary: "\(mac.home)/.local/bin/claude", command: "claude",
                                                        location: "\(mac.home)/.local/share/claude/versions/2.1.291", version: "2.1.291", channel: "latest"))
        XCTAssertEqual(claude.leftovers?.versions, ["2.1.288", "2.1.289"])
        XCTAssertEqual(claude.leftovers?.paths.map { ($0 as NSString).lastPathComponent }, ["2.1.288", "2.1.289"])
        // Codex: no install of its own, the app's copy.
        XCTAssertEqual(found[.codex]!.installs.map(\.key), ["app"])
        XCTAssertEqual(found[.codex]!.installs[0].binary, mac.layout.appCodex[0])
        XCTAssertFalse(found[.codex]!.installs[0].deletable)
        XCTAssertNil(found[.codex]!.leftovers)
        XCTAssertEqual(found[.opencode]!.installs.map(\.key), ["stable"])
        XCTAssertNil(found[.opencode]!.installs[0].version, "asked of the program")
        let pi = found[.pi]!.installs[0]
        XCTAssertEqual(pi.version, "0.87.1")
        XCTAssertEqual(pi.location, "\(mac.home)/.pi/agent/install/releases/0.87.1")
        XCTAssertNil(found[.pi]!.leftovers)
    }

    func testAnEmptyMacHasNothing() {
        let found = Mac().scan()
        XCTAssertEqual(found.count, 4)
        XCTAssertTrue(found.values.allSatisfy { $0.installs.isEmpty && $0.leftovers == nil })
    }

    func testTheStoreTheStandaloneCodexAndWhatIsElsewhere() {
        let mac = Mac()
        mac.asMeasured()
        let l = mac.layout
        // Codex's own script: ~/.local/bin/codex into ~/.codex/packages/standalone.
        mac.program("\(mac.home)/.codex/packages/standalone/releases/0.160.1/bin/codex")
        mac.link("\(mac.home)/.codex/packages/standalone/current", to: "releases/0.160.1")
        mac.link("\(mac.home)/.local/bin/codex", to: "\(mac.home)/.codex/packages/standalone/current/bin/codex")
        // Homebrew has one too, and an OpenCode of the first line.
        mac.program("\(mac.root.path)/brew/bin/codex")
        mac.program("\(mac.root.path)/brew/bin/opencode")
        // The store: a beta with its name on the command line, a beta left from an interrupted update, two pinned.
        for version in ["2.1.290", "2.1.291"] { mac.program(l.launcher(.claude, .beta, version)) }
        mac.link(l.betaCommand(.claude)!, to: l.launcher(.claude, .beta, "2.1.291"))
        for version in ["2.1.280", "2.1.285"] { mac.program(l.launcher(.claude, .pinned, version)) }
        mac.program(l.launcher(.codex, .beta, "0.162.0-alpha.16"))                    // no link: not on the command line
        mac.write("\(l.storeFolder(.codex, .beta))/0.162.0-alpha.15/half-unpacked", "")   // no launcher: not an install
        mac.write("\(l.storeFolder(.claude, .pinned))/not-a-version/launch", "")

        let found = mac.scan()
        let claude = found[.claude]!
        XCTAssertEqual(claude.installs.map(\.key), ["stable", "beta", "pinned:2.1.285", "pinned:2.1.280"])
        XCTAssertEqual(claude.install("beta")?.version, "2.1.291")
        XCTAssertEqual(claude.install("beta")?.command, "claude-beta")
        XCTAssertEqual(claude.install("beta")?.binary, l.launcher(.claude, .beta, "2.1.291"))
        XCTAssertNil(claude.install("pinned:2.1.285")?.command)
        let codex = found[.codex]!
        XCTAssertEqual(codex.installs.map(\.key), ["stable", "app", "beta", "other:\(mac.root.path)/brew/bin/codex"])
        XCTAssertEqual(codex.install("stable")?.location, "\(mac.home)/.codex/packages/standalone")
        XCTAssertNil(codex.install("beta")?.command)
        XCTAssertEqual(codex.install(.other)?.deletable, false)
        XCTAssertEqual(found[.opencode]!.installs.map(\.key), ["stable", "other:\(mac.root.path)/brew/bin/opencode"])
        // pi has no store.
        mac.program(l.launcher(.pi, .beta, "9.9.9"))
        XCTAssertEqual(mac.scan()[.pi]!.installs.map(\.key), ["stable"])
    }

    func testACommandThatIsNotTheVendorsInstallIsSomethingElse() {
        let mac = Mac()
        // `claude` in ~/.local/bin is somebody's script, not a link into Claude Code's versions.
        mac.program("\(mac.home)/.local/bin/claude")
        // ~/.opencode/bin/opencode is a link out to Homebrew's.
        mac.program("\(mac.root.path)/brew/bin/opencode")
        mac.link("\(mac.home)/.opencode/bin/opencode", to: "\(mac.root.path)/brew/bin/opencode")
        // Claude Code follows its stable channel here.
        mac.write("\(mac.home)/.claude/settings.json", #"{"autoUpdatesChannel":"stable","env":{}}"#)
        let found = mac.scan()
        XCTAssertEqual(found[.claude]!.installs.map(\.source), [.other])
        XCTAssertEqual(found[.opencode]!.installs.map(\.source), [.other])
        XCTAssertEqual(found[.opencode]!.installs.count, 1, "the same file reached twice is listed once")
        for version in ["2.1.285"] { mac.program("\(mac.home)/.local/share/claude/versions/\(version)") }
        mac.link("\(mac.home)/.local/bin/claude", to: "\(mac.home)/.local/share/claude/versions/2.1.285")
        XCTAssertEqual(mac.scan()[.claude]!.install(.stable)?.channel, "stable")
    }

    func testVersionsAreAskedOfTheProgramsAndSizesCounted() async {
        let mac = Mac()
        mac.asMeasured()
        mac.program("\(mac.home)/.opencode/bin/opencode", "#!/bin/sh\necho 'opencode v2.0.18'\n")
        mac.program(mac.layout.appCodex[0], "#!/bin/sh\necho 'codex-cli 0.160.1'\n")
        mac.write("\(mac.home)/.local/share/claude/versions/2.1.288", String(repeating: "x", count: 300_000))
        var reports = AgentInventory.scan(layout: mac.layout, path: mac.path)
        reports = await AgentInventory.withVersions(reports, path: "/usr/bin:/bin", environment: [:])
        reports = await AgentInventory.withSizes(reports)
        let found = Dictionary(uniqueKeysWithValues: reports.map { ($0.agent, $0) })
        XCTAssertEqual(found[.opencode]!.installs[0].version, "2.0.18")
        XCTAssertEqual(found[.codex]!.installs[0].version, "0.160.1")
        XCTAssertNil(found[.codex]!.installs[0].bytes, "the app's copy is not ours to count")
        XCTAssertGreaterThan(found[.claude]!.installs[0].bytes ?? 0, 0)
        XCTAssertGreaterThanOrEqual(found[.claude]!.leftovers?.bytes ?? 0, 300_000)
        XCTAssertGreaterThan(found[.pi]!.installs[0].bytes ?? 0, 0)
    }

    /// This Mac as it is and the vendors as they answer now, printed for a look (`AGENTSWITCH_AGENTS_LIVE=1 swift test
    /// --filter AgentsTests/testLive`): reads the real home and asks the real hosts, so it is skipped otherwise.
    func testLive() async throws {
        guard ProcessInfo.processInfo.environment["AGENTSWITCH_AGENTS_LIVE"] == "1" else {
            throw XCTSkip("set AGENTSWITCH_AGENTS_LIVE=1 to scan this Mac and ask the vendors")
        }
        let layout = AgentLayout(home: NSHomeDirectory())
        var reports = AgentInventory.scan(layout: layout, path: TestSupport.searchPath)
        reports = await AgentInventory.withVersions(reports, path: TestSupport.searchPath, environment: ["HOME": NSHomeDirectory()])
        reports = await AgentInventory.withSizes(reports)
        let info = await AgentReleases.check()
        for report in reports {
            let channels = info.channels(report.agent)
            print("== \(report.agent.title)  stable \(channels?.stable ?? "-")  beta \(channels?.beta ?? "-")")
            for install in report.installs {
                let newer = AgentUpdates.newer(for: install, channels: channels).map { " → \($0)" } ?? ""
                let size = install.bytes.map { " \($0 / 1_000_000) MB" } ?? ""
                print("   \(install.source.title) \(install.version ?? "?")\(newer)\(size)  \(install.command ?? "-")  \(install.binary)\(install.channel.map { "  follows \($0)" } ?? "")")
            }
            if let left = report.leftovers { print("   old versions \(left.versions.joined(separator: " ")) \((left.bytes ?? 0) / 1_000_000) MB") }
            let used = AgentSelection.chosen(report, saved: nil)
            print("   AgentSwitch would use: \(used?.key ?? "nothing")")
        }
        print("failed lookups: \(info.failed)  updates: \(AgentUpdates.count(reports, info: info))")
        XCTAssertEqual(reports.count, 4)
    }

    func testWhatThePageWrites() {
        XCTAssertEqual([233_211_568, 458_871_776, 1_180_000_000, 157_286_400, 4096, 12].map { AgentText.size(Int64($0)) },
                       ["233 MB", "459 MB", "1.18 GB", "157 MB", "4 KB", "12 B"])
        let home = "/Users/u"
        let layout = AgentLayout(home: home)
        let claude = AgentInstall(agent: .claude, source: .stable, key: "stable", binary: layout.command(.claude), command: "claude", location: "/x", version: "2.1.291", channel: "latest")
        XCTAssertEqual(AgentText.detail(claude, home: home), "claude · ~/.local/bin · Follows Latest")
        let opencode = AgentInstall(agent: .opencode, source: .stable, key: "stable", binary: layout.command(.opencode), command: "opencode", location: "/x", version: "2.0.18")
        XCTAssertEqual(AgentText.detail(opencode, home: home), "opencode · ~/.opencode/bin")
        XCTAssertEqual(AgentText.detail(install(.claude, .pinned, "2.1.280"), home: home), "AgentSwitch Only")
        XCTAssertEqual(AgentText.detail(install(.codex, .app, "0.160.1"), home: home), "Updates with ChatGPT App")
        XCTAssertEqual(AgentText.detail(AgentInstall(agent: .claude, source: .beta, key: "beta", binary: "/s/launch", command: "claude-beta", location: "/s"), home: home), "claude-beta")
        XCTAssertEqual(AgentText.detail(install(.codex, .beta, "0.162.0-alpha.16"), home: home), "Not on the Command Line")
        XCTAssertEqual(AgentText.detail(AgentInstall(agent: .codex, source: .other, key: "other:/Users/u/brew/codex", binary: "/Users/u/brew/codex", location: "/x"), home: home), "~/brew/codex")
        XCTAssertEqual(AgentText.caution(install(.opencode, .other, "1.18.34")), "OpenCode 1.x 不受 AgentSwitch 支持，需要 2.x。")
        XCTAssertEqual(AgentText.caution(install(.codex, .other, "0.142.0")), "低于 AgentSwitch 验证过的版本（0.158.0）。")
        XCTAssertNil(AgentText.caution(install(.codex, .stable, "0.160.1")))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(AgentText.checked(AgentReleaseInfo(checkedAt: now.addingTimeInterval(-130)), checking: false, now: now), "Checked 2m ago")
        XCTAssertEqual(AgentText.checked(AgentReleaseInfo(checkedAt: now), checking: false, now: now), "Checked Now")
        XCTAssertEqual(AgentText.checked(nil, checking: false, now: now), "Not Checked")
        XCTAssertEqual(AgentText.checked(nil, checking: true, now: now), "Checking")
        XCTAssertEqual(AgentText.failed(AgentReleaseInfo(failed: ["codex", "pi"])), "未能读取 Codex、pi 的发布信息，显示的是上次的结果。")
        XCTAssertNil(AgentText.failed(AgentReleaseInfo()))
    }

    // MARK: updates and the choice

    private func install(_ agent: AgentCLI, _ source: AgentSource, _ version: String?, channel: String? = nil, key: String? = nil) -> AgentInstall {
        AgentInstall(agent: agent, source: source, key: key ?? source.rawValue, binary: "/x/\(agent.command)", location: "/x", version: version, channel: channel)
    }

    func testWhatCountsAsAnUpdate() {
        let claude = AgentChannels(stable: "2.1.285", beta: "2.1.291")
        // Claude Code's own install follows the channel its own setting names.
        XCTAssertNil(AgentUpdates.newer(for: install(.claude, .stable, "2.1.291", channel: "latest"), channels: claude), "ahead of stable is not behind")
        XCTAssertEqual(AgentUpdates.newer(for: install(.claude, .stable, "2.1.289", channel: "latest"), channels: claude), "2.1.291")
        XCTAssertEqual(AgentUpdates.newer(for: install(.claude, .stable, "2.1.280", channel: "stable"), channels: claude), "2.1.285")
        XCTAssertNil(AgentUpdates.newer(for: install(.claude, .stable, "2.1.289", channel: "stable"), channels: claude))
        XCTAssertEqual(AgentUpdates.newer(for: install(.claude, .beta, "2.1.290"), channels: claude), "2.1.291")
        XCTAssertNil(AgentUpdates.newer(for: install(.claude, .pinned, "2.1.200"), channels: claude), "a pinned version stays")
        let codex = AgentChannels(stable: "0.160.1", beta: "0.162.0-alpha.16")
        XCTAssertNil(AgentUpdates.newer(for: install(.codex, .app, "0.158.0-alpha.2.1"), channels: codex), "the app's copy goes with the app")
        XCTAssertEqual(AgentUpdates.newer(for: install(.codex, .beta, "0.162.0-alpha.9"), channels: codex), "0.162.0-alpha.16")
        XCTAssertEqual(AgentUpdates.newer(for: install(.opencode, .beta, "0.0.0-beta-19000"), channels: AgentChannels(stable: "2.0.24", beta: "0.0.0-beta-19507")), "0.0.0-beta-19507")
        XCTAssertEqual(AgentUpdates.newer(for: install(.pi, .stable, "0.87.1"), channels: AgentChannels(stable: "1.0.4")), "1.0.4")
        XCTAssertNil(AgentUpdates.newer(for: install(.pi, .stable, nil), channels: AgentChannels(stable: "1.0.4")), "a version not known yet")
        XCTAssertNil(AgentUpdates.newer(for: install(.pi, .stable, "0.87.1"), channels: nil))
        let reports = [AgentReport(agent: .opencode, installs: [install(.opencode, .stable, "2.0.18")]), AgentReport(agent: .pi, installs: [install(.pi, .stable, "0.87.1")]),
                       AgentReport(agent: .claude, installs: [install(.claude, .stable, "2.1.291", channel: "latest")])]
        let info = AgentReleaseInfo(channels: ["opencode": AgentChannels(stable: "2.0.24"), "pi": AgentChannels(stable: "1.0.4"), "claude-code": claude])
        XCTAssertEqual(AgentUpdates.count(reports, info: info), 2)
        XCTAssertEqual(AgentUpdates.count(reports, info: nil), 0)
    }

    func testWhichOneAgentSwitchUses() {
        let stable = install(.codex, .stable, "0.160.1"), app = install(.codex, .app, "0.160.1"), beta = install(.codex, .beta, "0.162.0-alpha.16")
        let pinned = install(.codex, .pinned, "0.158.0", key: "pinned:0.158.0")
        // Nothing chosen: the vendor's own install; without one, the app's copy; then what there is.
        XCTAssertEqual(AgentSelection.chosen(AgentReport(agent: .codex, installs: [stable, app, beta]), saved: nil)?.key, "stable")
        XCTAssertEqual(AgentSelection.chosen(AgentReport(agent: .codex, installs: [app, beta]), saved: nil)?.key, "app")
        XCTAssertEqual(AgentSelection.chosen(AgentReport(agent: .codex, installs: [beta, pinned]), saved: nil)?.key, "beta")
        XCTAssertNil(AgentSelection.chosen(AgentReport(agent: .codex, installs: []), saved: nil))
        // The choice holds while it is there; gone, the fallback is used and that is said.
        let all = AgentReport(agent: .codex, installs: [stable, app, beta, pinned])
        XCTAssertEqual(AgentSelection.chosen(all, saved: "pinned:0.158.0")?.key, "pinned:0.158.0")
        XCTAssertFalse(AgentSelection.lost(all, saved: "pinned:0.158.0"))
        XCTAssertEqual(AgentSelection.chosen(all, saved: "pinned:0.150.0")?.key, "stable")
        XCTAssertTrue(AgentSelection.lost(all, saved: "pinned:0.150.0"))
        XCTAssertFalse(AgentSelection.lost(all, saved: nil))
        // OpenCode's first line is listed and never used.
        let v1 = install(.opencode, .other, "1.18.34", key: "other:/brew/opencode")
        XCTAssertTrue(v1.unsupportedLine)
        XCTAssertNil(AgentSelection.chosen(AgentReport(agent: .opencode, installs: [v1]), saved: "other:/brew/opencode"))
        XCTAssertEqual(AgentSelection.binaries([all, AgentReport(agent: .pi, installs: [])], saved: ["codex": "beta"]), [.codex: "/x/codex"])
        // Below what was checked is said, not refused; a test build's number says nothing of its line.
        XCTAssertTrue(install(.codex, .other, "0.142.0").belowVerified)
        XCTAssertFalse(install(.codex, .stable, "0.160.1").belowVerified)
        XCTAssertFalse(install(.opencode, .beta, "0.0.0-beta-19507").belowVerified)
        XCTAssertFalse(install(.opencode, .beta, "0.0.0-beta-19507").unsupportedLine, "a test build of the second line")
        XCTAssertTrue(install(.opencode, .beta, "0.0.0-beta-19507").selectable)
        XCTAssertTrue(install(.pi, .stable, "0.80.0").belowVerified)
        XCTAssertEqual(AgentCLI.allCases.map(\.environmentKey), ["CLAUDE_BIN", "CODEX_BIN", "OPENCODE_BIN", "PI_BIN"])
        XCTAssertEqual(AgentCLI.allCases.map(\.betaCommand), ["claude-beta", "codex-beta", "opencode-beta", nil])
    }
}
