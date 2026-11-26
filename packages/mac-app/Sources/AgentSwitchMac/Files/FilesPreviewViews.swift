import AgentSwitchMacCore
import AppKit
@preconcurrency import QuickLookUI
import SwiftUI

// What is selected, at the column's foot (docs/files-v0.md §3.5): its name and a line about it, Quick Look's picture of
// it — this Mac's files drawn by the system as they are; another node's by the service (the start of a text, a
// picture's small copy) — and two buttons, `Add to Reply` and `Open`. The rest is in the row's menu. Space opens Quick
// Look's panel, as in Finder.

struct FilesPreview: View {
    let files: FilesColumn
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if files.selection.count == 1, let path = files.selection.first, let entry = files.entry(path) {
                head(entry.name, info(path, entry))
                if !entry.isFolder {
                    content(path: path, entry: entry)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Look.panel)
                        .framed(Look.line, radius: 8)
                } else {
                    Spacer(minLength: 0)
                }
            } else {
                head("\(files.selection.count) Items", FilesText.size(files.selectedSize, short: false))
                ScrollView {
                    Text(files.selection.map { DisplayPath.short($0, home: files.home ?? NSHomeDirectory()) }.joined(separator: "\n"))
                        .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.ink2).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            HStack(spacing: look.isClassic ? 8 : 14) {
                FilesReplyButton(files: files)
                Button { files.openSelection() } label: { BracketLabel(word: "Open") }
                    .buttonStyle(BracketButtonStyle(size: 12))
                Spacer(minLength: 0)
            }
            .padding(.top, 2)
            if let notice = files.notice { Text(notice).font(.system(size: 11)).foregroundStyle(Color.failed).lineLimit(2) }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private func head(_ name: String, _ line: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(name).font(.system(size: look.isClassic ? 13 : 12.5, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.ink)
                .lineLimit(1).truncationMode(.middle)
            // One line when the column has room; narrow, the date goes on a line of its own rather than being cut
            // off (`Today…`, 2026-11-26).
            ViewThatFits(in: .horizontal) {
                infoLine(line)
                if let date = line.range(of: " · ", options: .backwards) {
                    VStack(alignment: .leading, spacing: 1) {
                        infoLine(String(line[..<date.lowerBound]))
                        infoLine(String(line[date.upperBound...]))
                    }
                } else {
                    infoLine(line)
                }
            }
        }
    }

    private func infoLine(_ text: String) -> some View {
        Text(text).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
    }

    private func info(_ path: String, _ entry: FileEntry) -> String {
        if let d = files.details[path] { return FilesText.info(d) }
        return entry.isFolder ? "Folder · \(FilesText.date(entry.modified))" : "\(FilesText.kind(of: entry.name, isFolder: false, type: nil)) · \(FilesText.size(entry.size, short: false)) · \(FilesText.date(entry.modified))"
    }

    @ViewBuilder
    private func content(path: String, entry: FileEntry) -> some View {
        if let text = files.remoteText {
            FilesTextView(preview: text, numbered: !look.isClassic)
        } else if files.local, files.details[path]?.type == .image, let image = NSImage(contentsOfFile: path) {
            Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).padding(8)
        } else if files.local, files.details[path]?.type != .text {
            QuickLookView(url: URL(fileURLWithPath: path))
        } else if let image = files.remoteImage {
            Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).padding(8)
        } else {
            VStack(spacing: 6) {
                Text(look.isClassic ? "" : "▤").font(.system(size: 26, design: .monospaced)).foregroundStyle(Look.faint)
                Text("无法在此预览，按空格用 Quick Look 打开。").font(.system(size: 11.5)).foregroundStyle(Look.ink2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The start of a text file, as the service gives it; numbered in the pixel look.
/// Long lines wrap to the column's width, a number beside a line's first row only (a minified file is one line).
private struct FilesTextView: View {
    let preview: FileTextPreview
    let numbered: Bool

    var body: some View {
        ScrollView(.vertical) {
            let lines = preview.text.split(separator: "\n", omittingEmptySubsequences: false).prefix(400)
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                    HStack(alignment: .top, spacing: 8) {
                        if numbered { Text("\(i + 1)").foregroundStyle(Look.faint).frame(minWidth: 22, alignment: .trailing) }
                        Text(String(line)).foregroundStyle(Look.ink).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if preview.truncated {
                    Text("仅显示前 64 KB（共 \(FilesText.size(preview.size, short: false))）。").font(.system(size: 11)).foregroundStyle(Look.ink2).padding(.top, 6)
                }
            }
            .font(.system(size: 11, design: .monospaced))
            .padding(8)
            .textSelection(.enabled)
        }
    }
}

/// Quick Look's picture of a file of this Mac's, in place (`QLPreviewView`).
struct QuickLookView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let view = QLPreviewView(frame: .zero, style: .compact)!
        view.shouldCloseWithWindow = false
        view.autostarts = false
        view.previewItem = url as NSURL
        return view
    }

    func updateNSView(_ view: QLPreviewView, context: Context) {
        if (view.previewItem as? NSURL) as URL? != url { view.previewItem = url as NSURL }
    }

    static func dismantleNSView(_ view: QLPreviewView, coordinator: ()) { view.close() }
}

// MARK: - the keyboard and Quick Look's panel

/// Where the list's keys come (files-v0 §3.4): a view behind the column that takes the keyboard when a row is clicked,
/// and answers for Quick Look's panel, which asks the responder chain who shows it.
struct FilesKeyHost: NSViewRepresentable {
    let files: FilesColumn
    let classic: Bool

    func makeNSView(context: Context) -> FilesKeyView {
        let view = FilesKeyView()
        view.files = files
        files.keys = view
        return view
    }

    func updateNSView(_ view: FilesKeyView, context: Context) {
        view.files = files
        view.classic = classic
        files.keys = view
        files.classic = classic
    }
}

final class FilesKeyView: NSView, @preconcurrency QLPreviewPanelDataSource, @preconcurrency QLPreviewPanelDelegate {
    weak var files: FilesColumn?
    var classic = false
    private var typed = ""
    private var typedAt = Date.distantPast

    override var acceptsFirstResponder: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func keyDown(with event: NSEvent) {
        guard let files, handle(event, files) == true else { return super.keyDown(with: event) }
    }

    @MainActor
    private func handle(_ event: NSEvent, _ files: FilesColumn) -> Bool? {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let command = flags.contains(.command), shift = flags.contains(.shift), option = flags.contains(.option)
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        let tree = files.shown(classic: classic) == .tree && !files.columns(classic: classic)
        switch event.keyCode {
        case 125: if command { files.openSelection() } else { files.move(1, extend: shift, classic: classic) }; return true          // ↓
        case 126: if command { files.goUp() } else { files.move(-1, extend: shift, classic: classic) }; return true                  // ↑
        case 124:                                                                                                                      // →
            guard let path = files.selection.last, let entry = files.entry(path), entry.isFolder else { return true }
            if tree { if files.expanded.contains(path) { files.move(1, extend: false, classic: classic) } else { files.twist(path, all: option) } }
            else { files.open(path) }
            return true
        case 123:                                                                                                                      // ←
            if tree, let path = files.selection.last {
                if files.expanded.contains(path) { files.twist(path) }
                else if let up = FilesPath.parent(of: path), up != files.root { files.select(up, classic: classic) }
                else { files.goUp() }
            } else { files.goUp() }
            return true
        case 115: files.jump(toFirst: true, classic: classic); return true                                                            // Home
        case 119: files.jump(toFirst: false, classic: classic); return true                                                           // End
        case 49: files.toggleQuickLook(); return true                                                                                  // space
        case 36, 76:                                                                                                                   // return
            // ↩ renames, as in Finder and VS Code (files-v0 §12.2); ⌘↓ and ⌘O open.
            if option { files.addToReply() } else if files.selection.count == 1, let path = files.selection.first { files.startRename(path) }
            return true
        case 51 where command:                                                                                                         // ⌘⌫
            files.trash(files.selection)
            return true
        case 53:                                                                                                                       // esc
            if files.question != nil { files.answer(false) } else if files.quickLooking { files.endQuickLook() } else if files.floating { files.close() } else { files.focusPage() }
            return true
        default: break
        }
        if command, shift {
            switch key {
            case "h": files.goHome(); return true
            case "g": files.going = files.root ?? ""; return true
            case ".", ">": files.showHidden.toggle(); return true
            case "n": files.startNew(folder: true); return true
            case "z": files.redo(); return true
            default: return false
            }
        }
        if command, option, key == "c" { files.copyPaths(files.selection); return true }
        if command, option, key == "n" { files.startNew(folder: false); return true }
        if command, !option {
            switch key {
            case "a": files.selectAll(classic: classic); return true
            case "[": files.goBack(); return true
            case "]": files.goForward(); return true
            case "o": files.openSelection(); return true
            case "z": files.undo(); return true
            default: return false
            }
        }
        if !command, let chars = event.characters, chars.count == 1, chars.rangeOfCharacter(from: .alphanumerics.union(.punctuationCharacters)) != nil {
            if Date().timeIntervalSince(typedAt) > 1 { typed = "" }
            typed += chars
            typedAt = Date()
            files.typeahead(typed, classic: classic)
            return true
        }
        return false
    }

    // Quick Look's panel (QLPreviewPanel): this view shows it while it is the column's.
    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }

    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = self
        panel.delegate = self
    }

    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = nil
        panel.delegate = nil
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        QLPanelHost.owner?.lookItems.count ?? 0
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        QLPanelHost.owner?.lookItems[safe: index].map { $0 as NSURL }
    }

    /// The arrows in the panel move the selection, as in Finder; space and esc close it.
    func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        guard event.type == .keyDown else { return false }
        keyDown(with: event)
        return true
    }
}

/// Quick Look's one panel, shown for one column at a time.
@MainActor
enum QLPanelHost {
    static weak var owner: FilesColumn?

    static func isOpen(for column: FilesColumn) -> Bool {
        owner === column && QLPreviewPanel.sharedPreviewPanelExists() && QLPreviewPanel.shared().isVisible
    }

    static func open(for column: FilesColumn) {
        owner = column
        column.focusKeys()
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible { panel.reloadData() } else { panel.makeKeyAndOrderFront(nil) }
    }

    static func reload() {
        guard QLPreviewPanel.sharedPreviewPanelExists() else { return }
        QLPreviewPanel.shared().reloadData()
    }

    static func close(for column: FilesColumn) {
        guard owner === column, QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible else { return }
        QLPreviewPanel.shared().orderOut(nil)
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

// MARK: - the question before a file that may hold a password goes in

/// `Add to Reply?` (docs/files-v0.md §4): over the reply box, or over the terminal's screen — the amber box of a thing
/// that waits for you, the classic look's card. `Cancel` keeps only the others.
struct FilesAskCard: View {
    let ask: FilesAsk
    let answer: (Bool) -> Void

    var body: some View {
        FloatingBox(title: "Add to Reply?", waiting: true) {
            VStack(alignment: .leading, spacing: 10) {
                Text(.init(FilesSensitive.question(names: ask.sensitive.map(\.name))))
                    .font(.system(size: 12.5)).foregroundStyle(Look.ink).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Spacer(minLength: 0)
                    Button { answer(false) } label: { BracketLabel(word: "Cancel") }.buttonStyle(BracketButtonStyle(size: 12))
                    Button { answer(true) } label: { BracketLabel(word: "Add") }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
    }
}

/// The question asked where there is no reply box to ask over (Dispatch's input, a terminal's own window): the system's
/// alert on the key window. Gives back what is to go in.
@MainActor
enum FilesAsking {
    static func kept(_ urls: [URL]) async -> [URL] {
        let sensitive = urls.filter { FilesSensitive.reason($0.path) != nil }
        guard !sensitive.isEmpty else { return urls }
        let alert = NSAlert()
        alert.messageText = "Add to Reply?"
        alert.informativeText = FilesSensitive.question(names: sensitive.map(\.lastPathComponent)).replacingOccurrences(of: "`", with: "")
        alert.addButton(withTitle: "Add")
        alert.addButton(withTitle: "Cancel")
        let answer: NSApplication.ModalResponse
        if let window = NSApp.keyWindow ?? NSApp.mainWindow {
            answer = await withCheckedContinuation { done in alert.beginSheetModal(for: window) { done.resume(returning: $0) } }
        } else {
            answer = alert.runModal()
        }
        return answer == .alertFirstButtonReturn ? urls : urls.filter { !sensitive.contains($0) }
    }
}
