import XCTest
@testable import AgentSwitchMacCore

/// docs/control-v0.md §6: login commands, the setup checklist and the first-run wizard's state.
final class HarnessLoginTests: XCTestCase {
    func testTheContractsCommands() {
        XCTAssertEqual(HarnessLogin.displayCommand(.claude), "claude auth login")
        XCTAssertEqual(HarnessLogin.displayCommand(.codex), "codex login")
        XCTAssertEqual(HarnessLogin.displayCommand(.opencode), "opencode auth login")
    }

    func testTheShellLineUsesTheDetectedBinaryAndTheLoginPath() {
        let line = HarnessLogin.shellCommand(.claude, binary: "/Users/me/.local/bin/claude", path: "/opt/homebrew/bin:/usr/bin")
        XCTAssertEqual(line, "/usr/bin/env PATH=/opt/homebrew/bin:/usr/bin /Users/me/.local/bin/claude auth login")
        XCTAssertEqual(HarnessLogin.shellCommand(.codex, binary: nil, path: "/usr/bin"), "/usr/bin/env PATH=/usr/bin codex login")
    }

    func testAwkwardPathsAreQuotedAndRoundTripThroughAShell() throws {
        let binary = "/Users/me/My Tools/it's $HOME;`x`/opencode"
        let path = "/Users/me/bin with space:/usr/bin"
        let line = HarnessLogin.shellCommand(.opencode, binary: binary, path: path)
        XCTAssertEqual(line, #"/usr/bin/env 'PATH=/Users/me/bin with space:/usr/bin' '/Users/me/My Tools/it'\''s $HOME;`x`/opencode' auth login"#)
        // What /bin/sh makes of it: exactly the intended words, nothing expanded or run.
        let words = try ProcessRunner.runBlocking(URL(fileURLWithPath: "/bin/sh"), ["-c", "printf '%s\\n' " + line.dropFirst("/usr/bin/env ".count)])
        XCTAssertEqual(words.stdoutText.split(separator: "\n").map(String.init), ["PATH=" + path, binary, "auth", "login"])
    }

    func testShellQuote() {
        XCTAssertEqual(ShellQuote.quote("plain-word_1.2/x:y"), "plain-word_1.2/x:y")
        XCTAssertEqual(ShellQuote.quote(""), "''")
        XCTAssertEqual(ShellQuote.quote("a b"), "'a b'")
        XCTAssertEqual(ShellQuote.quote("it's"), #"'it'\''s'"#)
        XCTAssertEqual(ShellQuote.quote("中文"), "'中文'")
    }

    func testTheCommandTravelsAsAnArgumentNotAsScriptText() {
        let args = HarnessLogin.terminalScriptArguments(command: #"say "hi" \ there"#)
        XCTAssertEqual(args.last, #"say "hi" \ there"#)
        let script = stride(from: 1, to: args.count - 1, by: 2).map { args[$0] }
        XCTAssertEqual(script, ["on run argv", "tell application \"Terminal\"", "activate", "do script (item 1 of argv)", "end tell", "end run"])
        XCTAssertTrue(stride(from: 0, to: args.count - 1, by: 2).allSatisfy { args[$0] == "-e" })
    }

    func testProblemsSayWhatToDo() {
        func result(_ status: Int32, _ stderr: String, timedOut: Bool = false) -> CommandResult {
            CommandResult(status: status, stdout: Data(), stderr: Data(stderr.utf8), timedOut: timedOut)
        }
        XCTAssertNil(HarnessLogin.problem(.claude, result: result(0, "")))
        let denied = HarnessLogin.problem(.codex, result: result(1, "execution error: Not authorized to send Apple events to Terminal. (-1743)"))
        XCTAssertTrue(denied?.contains("自动化") == true)
        XCTAssertTrue(denied?.hasSuffix("也可在终端中手动运行 codex login。") == true)
        XCTAssertTrue(HarnessLogin.problem(.claude, result: result(-1, "", timedOut: true))?.hasPrefix("“终端”无响应") == true)
        XCTAssertEqual(HarnessLogin.problem(.opencode, result: result(1, "boom\n")), "无法打开“终端”：boom。也可在终端中手动运行 opencode auth login。")
        XCTAssertEqual(HarnessLogin.problem(.opencode, result: nil), "无法打开“终端”。也可在终端中手动运行 opencode auth login。")
    }

    func testTheWatchRechecksUntilLoggedInOrTooLate() {
        let t0 = Date(timeIntervalSince1970: 1_790_000_000)
        let empty = LoginWatch()
        XCTAssertFalse(empty.shouldRecheck(now: t0))
        let watch = empty.starting(.opencode, at: t0).starting(.codex, at: t0)
        XCTAssertTrue(empty.started.isEmpty, "starting returns a new watch")
        XCTAssertTrue(watch.shouldRecheck(now: t0.addingTimeInterval(60)))
        XCTAssertFalse(watch.shouldRecheck(now: t0.addingTimeInterval(LoginWatch.window + 1)))
        let reports = [report(.opencode, loggedIn: true), report(.codex, loggedIn: false)]
        XCTAssertEqual(Set(watch.settled(by: reports, now: t0.addingTimeInterval(60)).started.keys), [.codex])
        XCTAssertTrue(watch.settled(by: reports, now: t0.addingTimeInterval(LoginWatch.window + 1)).started.isEmpty)
        XCTAssertEqual(Set(watch.dropping(.codex).started.keys), [.opencode])
    }

    func testComingBackRechecksWhileALoginIsOpenOrSomethingIsMissing() {
        let t0 = Date(timeIntervalSince1970: 1_790_000_000)
        let open = LoginWatch().starting(.claude, at: t0)
        XCTAssertTrue(open.recheckDue(now: t0.addingTimeInterval(5), unmet: 0, lastDetected: t0.addingTimeInterval(4)))
        let idle = LoginWatch()
        XCTAssertFalse(idle.recheckDue(now: t0, unmet: 0, lastDetected: nil))
        XCTAssertTrue(idle.recheckDue(now: t0, unmet: 2, lastDetected: nil))
        XCTAssertFalse(idle.recheckDue(now: t0.addingTimeInterval(10), unmet: 2, lastDetected: t0))
        XCTAssertTrue(idle.recheckDue(now: t0.addingTimeInterval(30), unmet: 2, lastDetected: t0))
    }

    private func report(_ h: Harness, loggedIn: Bool) -> HarnessReport {
        HarnessEvaluator.evaluate(HarnessFacts(harness: h, binary: "/bin/\(h.rawValue)", versionOutput: "1.0.0", loginEvidence: loggedIn ? "x" : nil))
    }
}

final class SetupChecklistTests: XCTestCase {
    private let home = "/Users/me"

    private func facts(harnesses: [HarnessReport], devices: [Device]?, tailscale: TailscaleStatus?, workDir: WorkDirFact) -> SetupFacts {
        SetupFacts(harnesses: harnesses, devices: devices, tailscale: tailscale, workDir: workDir, home: home)
    }

    private func report(_ h: Harness, binary: Bool = true, loggedIn: Bool = true) -> HarnessReport {
        HarnessEvaluator.evaluate(HarnessFacts(harness: h, binary: binary ? "/bin/\(h.rawValue)" : nil, versionOutput: nil,
                                               loginEvidence: loggedIn ? "x" : nil))
    }

    private let phone = Device(id: "d", name: "iPhone", platform: "ios", createdAt: nil, lastSeenAt: nil, revokedAt: nil)
    private let running = TailscaleStatus(state: .running, binary: "/x", backendState: "Running", dnsName: nil, ipv4: ["100.64.0.1"])

    func testEverythingDone() {
        let items = SetupChecklist.items(facts(harnesses: Harness.allCases.map { report($0) }, devices: [phone], tailscale: running,
                                               workDir: .known(WorkDirSettings(path: "/Users/me/AgentSwitch", defaultPath: nil, problem: nil))))
        XCTAssertEqual(items.map(\.id), ["claude", "codex", "opencode", "phone", "tailscale", "workdir"])
        XCTAssertEqual(SetupChecklist.unmet(items), 0)
        XCTAssertTrue(items.allSatisfy { $0.action == nil })
        XCTAssertEqual(items.last?.status, "~/AgentSwitch")
        XCTAssertEqual(items[3].status, "1 paired")
    }

    func testAFreshMacHasOneActionPerUnmetItem() {
        let revoked = Device(id: "old", name: "old", platform: "ios", createdAt: nil, lastSeenAt: nil, revokedAt: Date())
        let items = SetupChecklist.items(facts(
            harnesses: [report(.claude), report(.codex, binary: false), report(.opencode, loggedIn: false)],
            devices: [revoked], tailscale: .notInstalled,
            workDir: .known(WorkDirSettings(path: "/Users/me/AgentSwitch", defaultPath: nil, problem: "不能写入"))))
        XCTAssertEqual(SetupChecklist.unmet(items), 5)
        let actions = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.action) })
        XCTAssertEqual(actions["claude"], .some(nil))
        XCTAssertEqual(actions["codex"], .copyInstall(.codex))
        XCTAssertEqual(actions["opencode"], .login(.opencode))
        XCTAssertEqual(actions["phone"], .pair)
        XCTAssertEqual(actions["tailscale"], .installTailscale)
        XCTAssertEqual(actions["workdir"], .chooseWorkDir)
        XCTAssertEqual(items.first { $0.id == "codex" }?.detail, "brew install codex")
        XCTAssertEqual(items.first { $0.id == "workdir" }?.detail, "~/AgentSwitch：不能写入")
        XCTAssertEqual(SetupAction.login(.claude).title, "sign in")
    }

    func testUnknownIsCheckingNotMissing() {
        let items = SetupChecklist.items(facts(harnesses: [], devices: nil, tailscale: nil, workDir: .unknown))
        XCTAssertEqual(items.count, 6)
        XCTAssertTrue(items.allSatisfy { $0.state == .checking })
        XCTAssertEqual(SetupChecklist.unmet(items), 0)
    }

    func testAStoppedTailscaleOpensTheAppAndAnOldDaemonHidesTheFolderRow() {
        let stopped = TailscaleStatus(state: .stopped, binary: "/x", backendState: "Stopped", dnsName: nil, ipv4: [])
        let items = SetupChecklist.items(facts(harnesses: [], devices: [], tailscale: stopped, workDir: .unsupported))
        XCTAssertEqual(items.map(\.id), ["claude", "codex", "opencode", "phone", "tailscale"])
        XCTAssertEqual(items.last?.action, .openTailscale)
        XCTAssertEqual(SetupChecklist.unmet(items), 2)
    }

    func testTailnetAddressesFromThePollMeanConnected() {
        let stopped = TailscaleStatus(state: .stopped, binary: "/x", backendState: "Stopped", dnsName: nil, ipv4: [])
        let items = SetupChecklist.items(SetupFacts(harnesses: [], devices: [], tailscale: stopped, tailnet: ["100.64.0.2"],
                                                    workDir: .unsupported, home: home))
        XCTAssertEqual(items.first { $0.id == "tailscale" }?.state, .done)
    }

    func testTheTailscaleAppOfItsCLI() {
        XCTAssertEqual(SetupChecklist.tailscaleApp(binary: "/Applications/Tailscale.app/Contents/MacOS/Tailscale"), "/Applications/Tailscale.app")
        XCTAssertNil(SetupChecklist.tailscaleApp(binary: "/opt/homebrew/bin/tailscale"))
        XCTAssertNil(SetupChecklist.tailscaleApp(binary: nil))
    }
}

final class SetupWizardTests: XCTestCase {
    func testStepsAndProgress() {
        XCTAssertEqual(SetupStep.allCases.map(\.title), ["executors", "pair iPhone", "permissions & launch", "done"])
        XCTAssertEqual(SetupStep.executors.next, .pairing)
        XCTAssertNil(SetupStep.done.next)
        XCTAssertNil(SetupStep.executors.previous)
        let fresh = SetupWizardState.fresh
        XCTAssertEqual(fresh.resumeStep, .executors)
        let two = fresh.completing(.executors).completing(.pairing)
        XCTAssertEqual(two.lastCompletedStep, 1)
        XCTAssertEqual(two.resumeStep, .permissions)
        XCTAssertEqual(two.completing(.executors).lastCompletedStep, 1, "going back never lowers the progress")
        XCTAssertEqual(fresh.lastCompletedStep, -1, "completing returns a new state")
        XCTAssertEqual(fresh.completing(.done).resumeStep, .done)
        XCTAssertFalse(two.isClosed)
        let closed = two.closing(.skipped, at: Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertTrue(closed.isClosed)
        XCTAssertEqual(closed.outcome, .skipped)
        XCTAssertEqual(closed.lastCompletedStep, 1)
    }

    func testDictionaryRoundTripAndStore() throws {
        let state = SetupWizardState.fresh.completing(.executors).closing(.completed, at: Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertEqual(SetupWizardState(dictionary: state.dictionary), state)
        XCTAssertTrue(PropertyListSerialization.propertyList(state.dictionary, isValidFor: .binary))
        XCTAssertEqual(SetupWizardState(dictionary: ["flowVersion": 1, "closedAt": 1_790_000_000_000.0])?.closedAt,
                       Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertNil(SetupWizardState(dictionary: ["lastCompletedStep": 2]))

        let suite = "agentswitch-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = SetupWizardStore(defaults: defaults)
        XCTAssertNil(store.load())
        store.save(state)
        XCTAssertEqual(store.load(), state)
        let memory = SetupWizardStore(defaults: nil)
        memory.save(state)
        XCTAssertNil(memory.load(), "the preview store keeps nothing")
    }

    func testLaunchDecision() {
        let open = SetupWizardState.fresh.completing(.executors)
        XCTAssertEqual(SetupWizardLaunch.decide(state: nil, pairedDevices: 0, gaveUpWaiting: false), .show(.executors))
        XCTAssertEqual(SetupWizardLaunch.decide(state: open, pairedDevices: 0, gaveUpWaiting: false), .show(.pairing))
        XCTAssertEqual(SetupWizardLaunch.decide(state: nil, pairedDevices: 2, gaveUpWaiting: false), .markAlreadySetUp)
        XCTAssertEqual(SetupWizardLaunch.decide(state: nil, pairedDevices: nil, gaveUpWaiting: false), .wait)
        XCTAssertEqual(SetupWizardLaunch.decide(state: open, pairedDevices: nil, gaveUpWaiting: true), .show(.pairing))
        let closed = open.closing(.skipped, at: Date())
        XCTAssertEqual(SetupWizardLaunch.decide(state: closed, pairedDevices: 0, gaveUpWaiting: true), .nothing)
        let olderFlow = SetupWizardState(flowVersion: 0, lastCompletedStep: 2, closedAt: Date(), outcome: .completed)
        XCTAssertEqual(SetupWizardLaunch.decide(state: olderFlow, pairedDevices: 0, gaveUpWaiting: false), .show(.executors),
                       "a new flow starts over")
    }

    func testTruthyArguments() {
        XCTAssertTrue(SetupWizardLaunch.truthy("YES"))
        XCTAssertTrue(SetupWizardLaunch.truthy("true"))
        XCTAssertTrue(SetupWizardLaunch.truthy(true))
        XCTAssertTrue(SetupWizardLaunch.truthy(NSNumber(value: 1)))
        XCTAssertFalse(SetupWizardLaunch.truthy("NO"))
        XCTAssertFalse(SetupWizardLaunch.truthy(nil))
    }
}
