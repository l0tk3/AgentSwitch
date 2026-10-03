import XCTest
@testable import AgentSwitchMacCore

/// A task's card and page (docs/dispatch-v0.md §2; the phone's FeedEntry and TaskDetailView rules): title, status line,
/// progress blocks, the current step or the outcome said once, files, inline approvals, actions.
final class DispatchTaskCardTests: XCTestCase {
    private typealias F = DispatchFixture

    func testTitlesAreTheTopicsForItsFirstTaskOnly() throws {
        let first = try F.task("a", created: 10, text: "把 iOS 端打包装到手机上", thread: "th")
        let later = try F.task("b", created: 20, text: "再装一次", thread: "th")
        let followUp = try F.task("c", created: 30, text: "顺便清理", thread: "th", extra: ["parentId": "a"])
        let all = [first, later, followUp]
        let threads = try F.decode([DispatchThread].self, object: [["id": "th", "createdAt": 0, "updatedAt": 0, "title": "构建 AgentSwitch.app", "status": "open"]])
        XCTAssertEqual(DispatchTaskTitle.of(first, threads: threads, tasks: all), "构建 AgentSwitch.app")
        XCTAssertEqual(DispatchTaskTitle.of(later, threads: threads, tasks: all), "再装一次", "a later task asks for something else")
        XCTAssertEqual(DispatchTaskTitle.of(followUp, threads: threads, tasks: all), "顺便清理", "a follow-up names itself")
        XCTAssertEqual(DispatchTaskTitle.of(first, threads: [], tasks: all), "把 iOS 端打包装到手机上", "no topic title yet")
    }

    func testARunningCardShowsItsStepProgressAndClock() throws {
        let task = try F.task("t1", "running", created: 1_000, thread: nil, extra: ["harness": "claude-code", "model": "claude-opus-5-5"])
        let tail = [F.event(1, "dispatched", ["model": .string("claude-opus-5-5")]),
                    F.call(2, "Bash", ["command": "xcodebuild -scheme AgentSwitch"])]
        let progress = DispatchProgress.of([F.event(1, "step", ["n": .number(1), "action": .string("dispatch")]),
                                            F.event(2, "step", ["n": .number(3), "action": .string("dispatch")])])
        let card = DispatchTaskCard(task: task, tasks: [task], threads: [], approvals: [], tail: tail, progress: progress,
                                    now: Date(dispatchMilliseconds: 135_000))
        XCTAssertEqual(card.statusWord, "Busy")
        XCTAssertEqual(card.level, .busy)
        XCTAssertEqual(card.who, "Claude Code · Opus 5.5")
        XCTAssertEqual(card.step, "运行 xcodebuild -scheme AgentSwitch")
        XCTAssertEqual(card.progress?.text, "3/5")
        XCTAssertEqual(card.progress?.blocks, [true, true, true, false, false])
        XCTAssertEqual(card.clock(now: Date(dispatchMilliseconds: 135_000)), "2m 14s")
        XCTAssertNil(card.result)
        XCTAssertNil(card.summary)
        XCTAssertEqual(card.actions, [])
    }

    func testProgressFollowsTheLoopsSteps() {
        XCTAssertNil(DispatchProgress.of([F.event(1, "text"), F.event(2, "step", ["n": .number(0), "action": .string("plan")])]),
                     "a single-step task has no blocks")
        let six = DispatchProgress.of([F.event(1, "step", ["n": .number(6), "action": .string("finish")])])
        XCTAssertEqual(six?.text, "6/6", "past the budget: the step itself")
        let kept = DispatchProgress.updated(DispatchProgress(step: 4), with: F.event(9, "step", ["n": .number(2), "action": .string("dispatch")]))
        XCTAssertEqual(kept?.step, 4, "never back")
    }

    func testAWaitingCardHoldsItsApprovalAndSaysWaiting() throws {
        let task = try F.task("t2", "running", created: 1)
        let approvals = try [F.approval("ap", task: "t2", action: "Bash: rm -rf build"), F.approval("other", task: "zz")]
        let card = DispatchTaskCard(task: task, tasks: [task], threads: [], approvals: approvals)
        XCTAssertTrue(card.waiting)
        XCTAssertEqual(card.statusWord, "Waiting")
        XCTAssertEqual(card.level, .warning)
        XCTAssertEqual(card.approvals.map(\.id), ["ap"], "only its own approvals sit in it")
    }

    func testAnEndedCardSaysTheOutcomeOnceAndListsItsFiles() throws {
        let files = (1...6).map { DispatchTaskFile(path: "out/f\($0).txt", size: 4096, isDeliverable: true) }
            + [DispatchTaskFile(path: "in/shot.png", size: 1, isDeliverable: false)]
        let withScript = try F.task("d", "done", created: 0, updated: 190_000,
                                    extra: ["speech": "**一共** 42 个文件，重复的 9 个。", "result": "# 报告\n- 9 个重复"])
        let card = DispatchTaskCard(task: withScript, tasks: [withScript], threads: [], approvals: [], files: files)
        XCTAssertEqual(card.summary, "一共 42 个文件，重复的 9 个。", "the spoken script, read as plain text")
        XCTAssertNil(card.result, "the result is not said twice")
        XCTAssertEqual(card.files.map(\.path), ["out/f1.txt", "out/f2.txt", "out/f3.txt", "out/f4.txt"])
        XCTAssertEqual(card.moreFiles, 2, "the deliverables only; the rest open the task")
        XCTAssertEqual(card.files.first?.sizeText, ByteCountFormatter.string(fromByteCount: 4096, countStyle: .file))
        XCTAssertTrue(card.unread)
        XCTAssertEqual(card.clock(), "3m 10s")
        let plain = try F.task("p", "done", extra: ["result": "整理好了"])
        XCTAssertEqual(DispatchTaskCard(task: plain, tasks: [plain], threads: [], approvals: []).result, "整理好了")
    }

    func testFailuresOfferRetryAndARestartIsNotAFailure() throws {
        let failed = try F.task("f", "failed", extra: ["error": "gate proxy unreachable", "harness": "claude-code", "model": "sonnet"])
        let card = DispatchTaskCard(task: failed, tasks: [failed], threads: [], approvals: [])
        XCTAssertEqual(card.error, "gate proxy unreachable")
        XCTAssertTrue(card.errorIsFailure)
        XCTAssertEqual(card.actions, [.retry, .handTo])
        XCTAssertEqual(card.actions.map(\.title), ["[ Retry ]", "[ Hand to ▾ ]"])
        XCTAssertEqual(failed.retryTarget, DispatchTarget(harness: "claude-code", model: "sonnet"), "a retry pins the same executor")
        let interrupted = try F.task("i", "blocked", extra: ["blockCause": "interrupted"])
        let leftover = DispatchTaskCard(task: interrupted, tasks: [interrupted], threads: [], approvals: [])
        XCTAssertEqual(leftover.error, DispatchTask.interruptedText)
        XCTAssertFalse(leftover.errorIsFailure, "said plainly, not in red")
        XCTAssertEqual(leftover.actions, [.continueRun, .handTo])
        XCTAssertNil(try F.task("n", "failed").retryTarget, "never ran: the router picks")
        let done = try F.task("ok", "done", extra: ["error": "ignored"])
        XCTAssertNil(DispatchTaskCard(task: done, tasks: [done], threads: [], approvals: []).error)
    }

    func testThePagesFactsActionsAndRating() throws {
        let task = try F.task("1e04b10a", "running", extra: ["cwd": "/Users/me/Projects/AgentSwitch", "approvalPolicy": ["mode": "scoped"]])
        let facts = DispatchTaskPage.facts(task, home: "/Users/me")
        XCTAssertEqual(facts.map(\.label), ["Folder", "Browser", "Approval", "ID"])
        XCTAssertEqual(facts.map(\.value), ["~/Projects/AgentSwitch", "None", "Auto", "1e04b10a"])
        XCTAssertEqual(DispatchTaskPage.facts(try F.task("t", extra: ["ephemeral": true, "cwd": "/tmp/x"]))[0].value, "临时目录")
        XCTAssertEqual(DispatchTaskAction.page(task), [.cancel, .handTo])
        XCTAssertEqual(DispatchTaskAction.page(try F.task("d", "done")), [.retry, .handTo, .delete])
        XCTAssertTrue(DispatchTaskAction.cancel.isDestructive)
        XCTAssertEqual(DispatchTaskPage.nextRating(current: 1, clicked: 1), nil, "the same one again clears it")
        XCTAssertEqual(DispatchTaskPage.nextRating(current: nil, clicked: -1), -1)
        let ended = try F.task("e", "failed", extra: ["error": "boom"])
        XCTAssertEqual(DispatchTaskPage.reason(ended), "boom")
        XCTAssertTrue(DispatchTaskPage.awaitingSummary(ended))
        XCTAssertNil(DispatchTaskPage.summary(ended))
    }

    func testTheCurrentStepInPlainWords() throws {
        let task = try F.task("t", extra: ["spoken": "正在构建"])
        XCTAssertEqual(DispatchLiveStep.current(task, tail: []), "正在构建", "the summarizer's sentence before any event says something")
        XCTAssertEqual(DispatchLiveStep.plainLine(F.event(1, "routed", ["clarify": .string("用哪个账号？")])), "等你回答：用哪个账号？")
        XCTAssertEqual(DispatchLiveStep.plainLine(F.event(1, "step", ["n": .number(2), "action": .string("dispatch"),
                                                                      "target": .object(["model": .string("gpt-5.5")])])), "第 2 步：交由 GPT-5.5 执行")
        XCTAssertNil(DispatchLiveStep.plainLine(F.call(1, "Bash", ["command": "rm -rf ~"], denied: true)), "a refused call is not what it is doing")
        XCTAssertEqual(DispatchLiveStep.plainLine(F.event(1, "text", ["text": .string("第一行\n第二行")])), "第一行")
    }

    func testClockAndText() {
        XCTAssertEqual(DispatchClock.span(milliseconds: 40_000), "40s")
        XCTAssertEqual(DispatchClock.span(milliseconds: 62_000), "1m 02s")
        XCTAssertEqual(DispatchClock.span(milliseconds: 3_900_000), "1h 05m")
        XCTAssertEqual(DispatchClock.short(seconds: 0.05), "0.1s")
        XCTAssertEqual(DispatchClock.short(seconds: 58), "58s")
        XCTAssertEqual(DispatchText.clip("一二三四五", 4), "一二三…")
        XCTAssertEqual(DispatchText.firstLine("\n  \n 第一行 \n第二行"), "第一行")
    }

    func testFilesAndUploads() {
        XCTAssertEqual(DispatchTaskFile.cacheSegments(taskId: "t1", path: "out/sub/报告.pdf"), ["t1", "out", "sub", "报告.pdf"])
        XCTAssertEqual(DispatchTaskFile.cacheSegments(taskId: "t1", path: "../../etc/./passwd"), ["t1", "etc", "passwd"])
        XCTAssertEqual(DispatchTaskFile.cacheSegments(taskId: "../x", path: ""), ["x", "file"])
        XCTAssertEqual(DispatchTaskFile.cacheURL(root: URL(fileURLWithPath: "/c"), taskId: "t1", path: "out/a.pdf").path, "/c/t1/out/a.pdf")
        XCTAssertFalse(DispatchTaskFile(path: "out/page.html", size: 1, isDeliverable: true).opensInPreview, "HTML could load remote resources")
        XCTAssertTrue(DispatchTaskFile(path: "out/a.pdf", size: 1, isDeliverable: true).opensInPreview)
        let order = DispatchTaskFile.pageOrder([DispatchTaskFile(path: "in/a", size: 1, isDeliverable: false), DispatchTaskFile(path: "out/z", size: 1, isDeliverable: true)])
        XCTAssertEqual(order.map(\.path), ["out/z", "in/a"], "deliverables first")
        let big = DispatchUploadFile(name: "big.bin", type: "", data: Data(count: DispatchUploadFile.maxFileBytes + 1))
        XCTAssertEqual(DispatchUploadFile.problem(adding: big, to: []), "big.bin 超过 50 MB")
        let small = DispatchUploadFile(name: "a", type: "", data: Data([1]))
        XCTAssertEqual(DispatchUploadFile.problem(adding: small, to: Array(repeating: small, count: 20)), "每次最多 20 个附件")
        XCTAssertNil(DispatchUploadFile.problem(adding: small, to: []))
    }
}
