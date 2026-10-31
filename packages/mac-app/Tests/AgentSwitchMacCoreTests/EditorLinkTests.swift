import XCTest
@testable import AgentSwitchMacCore

/// A terminal's folder opened in a code editor (docs/terminal-v0.md §1 Mac "在编辑器中打开"): 2026-10-15, user: app 端加一个
/// 按钮，直接调用 vscode remote 跳到当前工作目录.
final class EditorLinkTests: XCTestCase {
    func testAFolderOnThisMacOpensAsAFile() {
        XCTAssertEqual(EditorLink.url(editor: .vscode, path: "/Users/me/work/app", remote: false, sshHost: nil)?.absoluteString,
                       "vscode://file/Users/me/work/app")
        XCTAssertEqual(EditorLink.url(editor: .cursor, path: "/Users/me/work/app", remote: false, sshHost: "ignored")?.absoluteString,
                       "cursor://file/Users/me/work/app")
    }

    func testAFolderOnAnotherNodeOpensOverSSHByItsHost() {
        XCTAssertEqual(EditorLink.url(editor: .vscode, path: "/home/me/work/app", remote: true, sshHost: "dellarch")?.absoluteString,
                       "vscode://vscode-remote/ssh-remote+dellarch/home/me/work/app")
        XCTAssertEqual(EditorLink.url(editor: .windsurf, path: "/srv/x", remote: true, sshHost: " me@10.0.0.2 ")?.absoluteString,
                       "windsurf://vscode-remote/ssh-remote+me@10.0.0.2/srv/x")
    }

    func testAnotherNodeWithoutAValidHostHasNoLink() {
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "/home/me", remote: true, sshHost: nil))
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "/home/me", remote: true, sshHost: ""))
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "/home/me", remote: true, sshHost: "my host"))
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "/home/me", remote: true, sshHost: "a/b"))
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "/home/me", remote: true, sshHost: "-oProxyCommand=x"))
    }

    func testOnlyAnAbsolutePathHasALink() {
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "work/app", remote: false, sshHost: nil))
        XCTAssertNil(EditorLink.url(editor: .vscode, path: "", remote: true, sshHost: "dellarch"))
    }

    func testAPathIsEscapedWhereALinkWouldReadItOtherwise() {
        XCTAssertEqual(EditorLink.url(editor: .vscode, path: "/Users/me/My Work/#1?;100%/中文", remote: false, sshHost: nil)?.absoluteString,
                       "vscode://file/Users/me/My%20Work/%231%3F%3B100%25/%E4%B8%AD%E6%96%87")
    }

    func testHosts() {
        for ok in ["dellarch", "dell-arch.lan", "me@dellarch", "10.67.2.1", "a_b"] { XCTAssertTrue(EditorLink.validHost(ok), ok) }
        for bad in ["", "a b", "a+b", "a/b", "a?b", "@host", "me@", "-x", "a%20"] { XCTAssertFalse(EditorLink.validHost(bad), bad) }
    }

    func testTheEditorIsVSCodeUntilAnotherIsChosen() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "EditorLinkTests-\(UUID().uuidString)"))
        XCTAssertEqual(CodeEditor.load(defaults), .vscode)
        defaults.set("cursor", forKey: CodeEditor.key)
        XCTAssertEqual(CodeEditor.load(defaults), .cursor)
        defaults.set("emacs", forKey: CodeEditor.key)
        XCTAssertEqual(CodeEditor.load(defaults), .vscode)
    }
}
