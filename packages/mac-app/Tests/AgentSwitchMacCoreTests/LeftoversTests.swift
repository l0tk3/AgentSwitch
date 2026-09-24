import Darwin
import XCTest
@testable import AgentSwitchMacCore

final class LeftoversTests: XCTestCase {
    func testPidFileRecordsPidAndStartTime() {
        let record = Leftovers.Record(pid: 123, started: ProcessStart(seconds: 1_790_000_000, microseconds: 42))
        XCTAssertEqual(record.text, "123 1790000000.000042\n")
        XCTAssertEqual(Leftovers.Record.parse(record.text), record)
        XCTAssertEqual(Leftovers.Record.parse("123\n"), Leftovers.Record(pid: 123, started: nil), "an older build's pid file")
        XCTAssertEqual(Leftovers.Record.parse("123 1.5"), Leftovers.Record(pid: 123, started: nil))
        XCTAssertNil(Leftovers.Record.parse("garbage"))
        XCTAssertNil(Leftovers.Record.parse("-5 1.000000"))
        XCTAssertNil(ProcessStart(text: "1.00000x"))
        XCTAssertNil(ProcessStart(text: "+1.000000"))
    }

    func testStartTimeNamesOneProcess() throws {
        let mine = try XCTUnwrap(Leftovers.startTime(of: getpid()))
        XCTAssertEqual(Leftovers.startTime(of: getpid()), mine)
        XCTAssertLessThanOrEqual(Double(mine.seconds), Date().timeIntervalSince1970)
        XCTAssertNil(Leftovers.startTime(of: 0))
        XCTAssertNil(Leftovers.startTime(of: Int32.max - 1))
        XCTAssertTrue(Leftovers.isSameProcess(Leftovers.Record(pid: getpid(), started: mine)))
        XCTAssertFalse(Leftovers.isSameProcess(Leftovers.Record(pid: getpid(), started: nil)))
        XCTAssertFalse(Leftovers.isSameProcess(Leftovers.Record(pid: getpid(), started: ProcessStart(seconds: mine.seconds + 1, microseconds: 0))))
    }

    func testOwnershipIsThisRuntimeOnly() throws {
        // tempDir is under /var/folders; proc_pidpath and realpath report /private/var/folders.
        let root = TestSupport.tempDir("runtime")
        let node = root.appendingPathComponent("node/bin/node")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: node)
        let resolved = try XCTUnwrap(Leftovers.realPath(node.path))
        XCTAssertTrue(Leftovers.isOurs(executablePath: resolved, runtimeRoot: root))
        XCTAssertTrue(Leftovers.isOurs(executablePath: node.path, runtimeRoot: root))
        let link = TestSupport.tempDir("link").appendingPathComponent("runtime")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
        XCTAssertTrue(Leftovers.isOurs(executablePath: resolved, runtimeRoot: link))
        // Another copy of the app looks after its own children.
        let otherCopy = TestSupport.tempDir("copy").appendingPathComponent("AgentSwitch.app/Contents/Resources/runtime")
        try FileManager.default.createDirectory(at: otherCopy.appendingPathComponent("node/bin"), withIntermediateDirectories: true)
        XCTAssertFalse(Leftovers.isOurs(executablePath: otherCopy.path + "/node/bin/node", runtimeRoot: root))
        XCTAssertFalse(Leftovers.isOurs(executablePath: "/Users/u/Downloads/AgentSwitch.app/Contents/Resources/runtime/python/bin/python3.12", runtimeRoot: root))
        XCTAssertFalse(Leftovers.isOurs(executablePath: "/opt/homebrew/bin/node", runtimeRoot: root))
        XCTAssertFalse(Leftovers.isOurs(executablePath: resolved.replacingOccurrences(of: "/node/bin/node", with: "x/node"), runtimeRoot: root))
        XCTAssertFalse(Leftovers.isOurs(executablePath: resolved, runtimeRoot: root.appendingPathComponent("gone")))
    }

    func testReapStopsOnlyTheRecordedProcessOfThisRuntime() async throws {
        let runtime = TestSupport.tempDir("runtime")
        let sleeper = runtime.appendingPathComponent("sleep")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/bin/sleep"), to: sleeper)
        let proc = Process()
        proc.executableURL = sleeper
        proc.arguments = ["30"]
        try proc.run()
        let pid = proc.processIdentifier
        let pidFile = runtime.appendingPathComponent("run/x.pid")
        Leftovers.writePid(pid, to: pidFile)
        let record = try XCTUnwrap(Leftovers.readRecord(pidFile))
        XCTAssertEqual(record.pid, pid)
        XCTAssertNotNil(record.started)
        XCTAssertEqual(Leftovers.executablePath(of: pid), Leftovers.realPath(sleeper.path))

        // Someone else's runtime root: untouched.
        let other = await Leftovers.reap(pidFile: pidFile, runtimeRoot: URL(fileURLWithPath: "/elsewhere"), signal: SIGTERM, timeout: 1)
        XCTAssertNil(other)
        XCTAssertNil(Leftovers.readRecord(pidFile), "the pid file goes either way")
        // A pid file without a start time (older build): the pid may have been reused, so never.
        Leftovers.write(Leftovers.Record(pid: pid, started: nil), to: pidFile)
        let legacy = await Leftovers.reap(pidFile: pidFile, runtimeRoot: runtime, signal: SIGTERM, timeout: 1)
        XCTAssertNil(legacy)
        // Same pid, different start time: a reused pid, never killed.
        let started = try XCTUnwrap(record.started)
        Leftovers.write(Leftovers.Record(pid: pid, started: ProcessStart(seconds: started.seconds - 1, microseconds: started.microseconds)), to: pidFile)
        let reused = await Leftovers.reap(pidFile: pidFile, runtimeRoot: runtime, signal: SIGTERM, timeout: 1)
        XCTAssertNil(reused)
        XCTAssertTrue(proc.isRunning)

        Leftovers.write(record, to: pidFile)
        let reaped = await Leftovers.reap(pidFile: pidFile, runtimeRoot: runtime, signal: SIGTERM, timeout: 2)
        XCTAssertEqual(reaped, pid)
        let gone = await TestSupport.waitUntil(timeout: 3) { !proc.isRunning }
        XCTAssertTrue(gone)
        XCTAssertNil(Leftovers.readPid(pidFile))
    }
}

final class InstanceLockTests: XCTestCase {
    private func lockFile() -> URL {
        TestSupport.tempDir("lock").appendingPathComponent("run/app.lock")
    }

    func testSecondCopyIsTurnedAwayUntilTheFirstLetsGo() throws {
        let url = lockFile()
        guard case .acquired(let first) = InstanceLock.acquire(at: url) else { return XCTFail("first copy gets the lock") }
        XCTAssertEqual(InstanceLock.holder(of: url), getpid())
        let mode = (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int) ?? 0
        XCTAssertEqual(mode & 0o077, 0)
        // flock(2) locks belong to the open file, so a second open in the same process conflicts like another copy.
        guard case .held(let holder) = InstanceLock.acquire(at: url) else { return XCTFail("second copy is turned away") }
        XCTAssertEqual(holder, getpid())
        first.release()
        guard case .acquired(let again) = InstanceLock.acquire(at: url) else { return XCTFail("free again after release") }
        again.release()
    }

    func testChildrenNeverInheritTheLock() async throws {
        let url = lockFile()
        guard case .acquired(let lock) = InstanceLock.acquire(at: url) else { return XCTFail("lock") }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        lock.release()
        // Were the descriptor inherited, the sleeping child would still hold the lock.
        guard case .acquired(let next) = InstanceLock.acquire(at: url) else { return XCTFail("a child kept the lock") }
        next.release()
        await TestSupport.stop(child)
    }

    func testLockEndsWithTheProcessHoldingIt() async throws {
        let perl = URL(fileURLWithPath: "/usr/bin/perl")
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: perl.path), "needs /usr/bin/perl to hold a flock from another process")
        let url = lockFile()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let holder = Process()
        holder.executableURL = perl
        holder.arguments = ["-e", "use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; sleep 30", url.path]
        try holder.run()
        let taken = await TestSupport.waitUntil(timeout: 5) {
            if case .held = InstanceLock.acquire(at: url) { return true }
            return false
        }
        XCTAssertTrue(taken, "another process holds the lock")
        kill(holder.processIdentifier, SIGKILL)
        let freed = await TestSupport.waitUntil(timeout: 5) {
            guard case .acquired(let lock) = InstanceLock.acquire(at: url) else { return false }
            lock.release()
            return true
        }
        XCTAssertTrue(freed, "the kernel drops the lock when its holder dies, crash included")
    }
}
