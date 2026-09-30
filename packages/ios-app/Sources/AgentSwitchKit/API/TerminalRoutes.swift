import Foundation

// The terminal routes a paired phone may use (docs/terminal-v0.md §4; the daemon's remote allowlist): not the hook and
// not raw keystrokes (`/write`) — a reply goes through the sealer, keys go by name.

private struct TerminalEnvelope: Decodable { let terminal: TerminalInfo; let existing: Bool? }
private struct ElsewhereReply: Decodable {
    struct Place: Decodable { let app: String?; let pid: Int? }
    let elsewhere: Place?
}
private struct InputBody: Encodable { let text: String; let submit: Bool; let seal: Bool }
private struct CommandList: Decodable { let commands: [SlashCommand] }
private struct KeysBody: Encodable { let keys: [TerminalKey] }
private struct SizeBody: Encodable { let cols: Int; let rows: Int; let screen: String? }
private struct ClickBody: Encodable { let keys: [String] }
private struct DecisionBody: Encodable { let decision: String }
private struct RenameBody: Encodable { let name: String? }
private struct AttachBody: Encodable { let uploads: [String] }
private struct AttachReply: Decodable { let files: [AttachedFile] }

/// A file put in a terminal (`POST /terminals/:id/attach`): where it went on the Mac.
public struct AttachedFile: Decodable, Sendable, Equatable {
    public let name: String
    public let path: String

    public init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

extension AgentSwitchAPI {
    public func terminals() async throws -> TerminalList { try await get(["terminals"]) }
    public func terminalStyle() async throws -> TerminalStyle { try await get(["terminals", "style"]) }

    public func createTerminal(_ body: NewTerminalRequest) async throws -> TerminalInfo {
        (try await send("POST", ["terminals"], body: body) as TerminalEnvelope).terminal
    }

    /// Resuming a session: started, or the terminal that already has it; a 409 names the program that has it open.
    public func resumeTerminal(_ body: ResumeTerminalRequest) async throws -> ResumeOutcome {
        let data: Data
        do { data = try JSONEncoder().encode(body) } catch { throw APIError.decoding("request body: \(error)") }
        let endpoint = try await endpoints.endpoint()
        let (reply, response): (Data, HTTPURLResponse)
        do {
            (reply, response) = try await transport.send(request("POST", endpoint, ["terminals", "resume"], query: [], body: data))
        } catch let error as APIError {
            if error.isNetworkFailure { await endpoints.reportFailure(endpoint) }
            throw error
        }
        if response.statusCode == 409, let place = (try? JSONDecoder().decode(ElsewhereReply.self, from: reply))?.elsewhere {
            return .elsewhere(app: place.app, pid: place.pid)
        }
        let envelope: TerminalEnvelope = try Self.decode(reply, response)
        return envelope.existing == true ? .existing(envelope.terminal) : .started(envelope.terminal)
    }

    /// A reply, sealed on the Mac first (credentials reach the agent as ciphertext); `submit` presses return after it.
    /// A reply: sealed on the Mac first (the sealer may take a while), or `sealed: false` typed as it is.
    public func sendTerminalInput(_ id: String, text: String, submit: Bool = true, sealed: Bool = true) async throws -> TerminalInputResult {
        try await send("POST", ["terminals", id, "input"], body: InputBody(text: text, submit: submit, seal: sealed),
                       timeout: sealed ? Self.createTaskTimeout : requestTimeout)
    }

    /// Files staged with `upload` into the terminal: their paths are pasted into the agent's prompt, nothing is sent
    /// (Claude Code shows an image's as [Image #n]; the user writes on and sends).
    public func attachToTerminal(_ id: String, uploads: [String]) async throws -> [AttachedFile] {
        let reply: AttachReply = try await send("POST", ["terminals", id, "attach"], body: AttachBody(uploads: uploads), timeout: requestTimeout)
        return reply.files
    }

    /// The slash commands this terminal's agent takes in its folder; nil from a Mac too old to say (404).
    public func terminalCommands(_ id: String) async throws -> [SlashCommand]? {
        do {
            return (try await get(["terminals", id, "commands"]) as CommandList).commands
        } catch APIError.http(status: 404, message: _) {
            return nil
        }
    }

    public func sendTerminalKeys(_ id: String, _ keys: [TerminalKey]) async throws {
        let _: OKReply = try await post(["terminals", id, "keys"], body: KeysBody(keys: keys))
    }

    /// A left click on a cell (from 0), for a program that tracks the mouse: the Mac sends it the way the program asked
    /// (docs/terminal-v0.md §4 `click:<col>:<row>`). A Mac that predates it answers 400.
    public func clickTerminal(_ id: String, col: Int, row: Int) async throws {
        let _: OKReply = try await post(["terminals", id, "keys"], body: ClickBody(keys: ["click:\(col):\(row)"]))
    }

    /// `screen`: this phone's screen, which owns the size from now on (docs/terminal-v0.md §1 "尺寸有主").
    public func resizeTerminal(_ id: String, cols: Int, rows: Int, screen: String? = nil) async throws {
        let _: OKReply = try await post(["terminals", id, "resize"], body: SizeBody(cols: cols, rows: rows, screen: screen))
    }

    /// Has the agent draw its screen again (its links and status line are not in a snapshot).
    public func redrawTerminal(_ id: String) async throws {
        let _: OKReply = try await post(["terminals", id, "redraw"], body: EmptyBody())
    }

    /// False: it was answered already, on the Mac or in the terminal itself (404) — the card just goes, no error.
    @discardableResult
    public func decideTerminalPermission(_ id: String, permissionId: String, allow: Bool) async throws -> Bool {
        do {
            let _: OKReply = try await post(["terminals", id, "permissions", permissionId], body: DecisionBody(decision: allow ? "allow" : "deny"))
            return true
        } catch APIError.http(status: 404, message: _) {
            return false
        }
    }

    /// The user's own name; nil or "" goes back to the derived one.
    public func renameTerminal(_ id: String, name: String?) async throws -> TerminalInfo {
        (try await send("PATCH", ["terminals", id], body: RenameBody(name: name)) as TerminalEnvelope).terminal
    }

    /// Ends it and forgets it; the agent's own record of the session stays (it can be resumed).
    /// Ends the terminal and takes it off the list; `deleteRecord` deletes the session it wrote too (not a session it
    /// continued in place: 409).
    public func closeTerminal(_ id: String, deleteRecord: Bool = false) async throws {
        let _: OKReply = try await perform("DELETE", ["terminals", id], query: deleteRecord ? [URLQueryItem(name: "transcript", value: "1")] : [], body: nil)
    }

    /// A terminal's screen and what happens to it: the snapshot, then output, status, name, permission requests. On a
    /// dropped connection it reconnects after the last seq it delivered (the daemon replays what was missed, or sends a
    /// new snapshot when that is gone). Ends when the terminal is removed or no longer exists.
    /// `screen`: the drawing screen's id; the size it owns goes back when this stream ends (the page closed, the app
    /// went to the background).
    public func terminalEvents(_ id: String, screen: String? = nil, policy: ReconnectPolicy = .standard) -> AsyncThrowingStream<TerminalEvent, Error> {
        let (stream, sink) = AsyncThrowingStream<TerminalEvent, Error>.makeStream()
        let worker = Task {
            var last: Int64?
            var failures = 0
            while !Task.isCancelled {
                do {
                    let (ended, seq, delivered) = try await followTerminalOnce(id, after: last, screen: screen, policy: policy) { sink.yield($0) }
                    if ended { break }
                    last = seq ?? last
                    failures = delivered ? 0 : failures + 1
                } catch is CancellationError {
                    break
                } catch let error as APIError where error.isNetworkFailure {
                    failures += 1
                } catch APIError.http(let status, _) where status == 404 {
                    sink.yield(.removed)
                    break
                } catch {
                    sink.finish(throwing: error)
                    return
                }
                try? await Task.sleep(for: policy.delay(afterFailures: max(failures, 1)))
            }
            sink.finish()
        }
        sink.onTermination = { _ in worker.cancel() }
        return stream
    }

    /// One connection: (removed, last seq delivered, anything delivered).
    private func followTerminalOnce(_ id: String, after: Int64?, screen: String?, policy: ReconnectPolicy,
                                    deliver: (TerminalEvent) -> Void) async throws -> (Bool, Int64?, Bool) {
        let endpoint = try await endpoints.endpoint()
        let query = [after.map { URLQueryItem(name: "after", value: String($0)) }, screen.map { URLQueryItem(name: "screen", value: $0) }].compactMap { $0 }
        let req = request("GET", endpoint, ["terminals", id, "stream"], query: query, body: nil, accept: "text/event-stream",
                          timeout: policy.idleTimeout)
        var last = after
        var delivered = false
        do {
            let (response, body) = try await transport.stream(req)
            if !(200..<300).contains(response.statusCode) {
                var data = Data()
                for try await chunk in body where data.count < 64 * 1024 { data.append(chunk) }
                try AgentSwitchAPI.check(data, response)
            }
            var parser = SSEParser()
            for try await chunk in Self.idleGuarded(body, limit: .milliseconds(Int64(policy.idleTimeout * 1000))) {
                for message in parser.feed(chunk) {
                    guard let event = TerminalEvent.parse(event: message.event, data: message.data) else { continue }
                    // Output already shown (a replay after a reconnect) is skipped; a snapshot always draws.
                    if case .output(let seq, _) = event, let last, seq <= last { continue }
                    if let seq = event.seq { last = seq }
                    delivered = true
                    deliver(event)
                    if event == .removed { return (true, last, true) }
                }
            }
        } catch let error as APIError where error.isNetworkFailure {
            await endpoints.reportFailure(endpoint)
            if delivered { return (false, last, true) }
            throw error
        }
        return (false, last, delivered)
    }
}
