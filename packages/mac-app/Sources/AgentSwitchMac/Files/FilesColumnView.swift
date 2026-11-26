import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Files column as drawn (docs/files-v0.md §3; demo docs/design/concepts/files.html): its head, the path every level
// of which is a button, the list — the pixel look's tree in characters, the classic look's folders (Finder's two last
// columns when wide) —, and at its foot the count, or what is selected with its preview and two buttons.

struct FilesColumnView: View {
    let files: FilesColumn
    /// Over the page rather than beside it (files-v0 §2.1).
    let floating: Bool
    /// The window's ground where the column stands (the page's; the terminal's own on Terminals).
    let ground: Color
    @Environment(\.interfaceLook) private var look

    var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                FilesHead(files: files)
                FilesCrumbs(files: files)
                Rectangle().fill(Look.line).frame(height: 1)
                body(height: proxy.size.height)
            }
        }
        .background(FilesKeyHost(files: files, classic: look.isClassic))
        .background(look.isClassic ? (floating ? Look.sidebar : Color.clear) : ground)
        // The one box the Mac asks with before a change (files-v0 §12.2), over the column's list.
        .overlay(alignment: .top) {
            if let question = files.question {
                FilesQuestionCard(files: files, question: question).padding(.horizontal, 10).padding(.top, 72)
            }
        }
        .overlay(alignment: .leading) { FilesResizeEdge(files: files) }
        .modifier(FilesChrome(floating: floating))
        .environment(\.filesClassic, look.isClassic)
    }

    @ViewBuilder
    private func body(height: CGFloat) -> some View {
        let picked = !files.selection.isEmpty
        if picked && files.showPreview {
            let preview = max(120, min(height * files.previewShare, height - 160))
            FilesList(files: files).frame(maxHeight: .infinity)
            if let said = files.said { FilesSaidLine(text: said) }
            FilesSplitEdge(files: files, height: height)
            FilesPreview(files: files).frame(height: preview)
        } else {
            FilesList(files: files).frame(maxHeight: .infinity)
            if let said = files.said { FilesSaidLine(text: said) }
            Rectangle().fill(Look.line).frame(height: 1)
            if picked { FilesSelectionLine(files: files) } else { FilesFoot(files: files) }
        }
    }
}

private struct FilesClassicKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// The column is in the classic look (a shorthand its rows read).
    var filesClassic: Bool {
        get { self[FilesClassicKey.self] }
        set { self[FilesClassicKey.self] = newValue }
    }
}

/// Beside the page: a hairline at its left edge. Over it: the pixel look's 1 pt ink frame and dithered hard shadow, the
/// classic look's round left corners and soft shadow.
private struct FilesChrome: ViewModifier {
    let floating: Bool
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if !floating, look.isClassic {
            // Beside the page it is a card as the page's own list is (§8.1).
            content.sideCard(leading: Look.panelGap, trailing: Look.panelGap)
        } else if !floating {
            content.overlay(alignment: .leading) { Rectangle().fill(Look.line).frame(width: 1) }
        } else if look.isClassic {
            let shape = UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12, style: .continuous)
            content.clipShape(shape)
                .overlay(shape.strokeBorder(Look.line, lineWidth: 0.5))
                .shadow(color: .black.opacity(0.45), radius: 20, x: -8)
        } else {
            content.overlay(Rectangle().strokeBorder(Look.ink, lineWidth: 1))
                .background(Checker().offset(x: -7, y: 6).padding(.trailing, 6))
        }
    }
}

// MARK: - the head

private struct FilesHead: View {
    let files: FilesColumn
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 6) {
            if look.isClassic {
                Text("Files").font(.system(size: 13, weight: .semibold)).foregroundStyle(Look.ink)
            } else {
                PartLabel("Files")
            }
            if files.node != nil {
                Text("@ \(files.nodeName)").font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Color.signal).lineLimit(1)
            }
            Spacer(minLength: 4)
            FilesHeadButton(glyph: "⌂", symbol: "house", help: "Home ⌘⇧H") { files.goHome() }
            FilesNewMenu(files: files)
            FilesMoreMenu(files: files)
            FilesHeadButton(glyph: "×", symbol: "xmark", help: "Close ⌘⇧F") { files.close() }
        }
        .padding(.leading, look.isClassic ? 14 : 12)
        .padding(.trailing, 8)
        .frame(height: look.isClassic ? 34 : 30)
    }
}

struct FilesHeadButton: View {
    let glyph: String
    let symbol: String
    let help: String
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) { label }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .help(help)
            .accessibilityLabel(help)
    }

    private var label: some View {
        Group {
            if look.isClassic {
                Image(systemName: symbol).font(.system(size: 12, weight: .regular))
                    .foregroundStyle(hovering ? Look.ink : Look.ink2)
                    .frame(width: 24, height: 22)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Look.raised.opacity(hovering ? 1 : 0)))
            } else {
                Text(glyph).font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(hovering ? Look.ground : Look.ink2)
                    .frame(width: 22, height: 22)
                    .background(hovering ? Look.ink : Color.clear)
            }
        }
        .contentShape(Rectangle())
    }
}

/// `⋯` (files-v0 §3.1): the view, what is shown, how it is placed, the order, where to go.
private struct FilesMoreMenu: View {
    @Bindable var files: FilesColumn
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Menu {
            Picker("View", selection: Binding(get: { files.shown(classic: look.isClassic) }, set: { files.arrangement = $0 })) {
                Text("As Tree").tag(FilesColumn.Arrangement.tree)
                Text("As Folders").tag(FilesColumn.Arrangement.folders)
            }
            .pickerStyle(.inline)
            .labelsHidden()
            Divider()
            Toggle("Show Hidden Files  ⌘⇧.", isOn: $files.showHidden)
            Toggle("Show Preview", isOn: $files.showPreview)
            Toggle("Float Over Page", isOn: $files.floating)
            Divider()
            Picker("Sort By", selection: $files.sort) {
                ForEach(FilesSort.allCases, id: \.self) { Text($0.word).tag($0) }
            }
            Divider()
            Button("Home  ⌘⇧H") { files.goHome() }
            Button("Go to Folder…  ⌘⇧G") { files.going = files.root ?? "" }
            if !files.recent.isEmpty {
                Menu("Places") {
                    ForEach(files.recent, id: \.self) { path in Button(DisplayPath.short(path, home: NSHomeDirectory())) { files.go(to: path) } }
                }
            }
        } label: {
            Group {
                if look.isClassic {
                    Image(systemName: "ellipsis").font(.system(size: 12)).foregroundStyle(Look.ink2).frame(width: 24, height: 22)
                } else {
                    Text("⋯").font(.system(size: 13, design: .monospaced)).foregroundStyle(Look.ink2).frame(width: 22, height: 22)
                }
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("More")
    }
}

// MARK: - the path

/// The shown folder's whole path from `/`, every level a button (files-v0 §3.2); the middle folded into `…` when it does
/// not fit. The classic look: Apple's path control (an icon and a name, `›`), `‹ ›` before it.
private struct FilesCrumbs: View {
    let files: FilesColumn
    @Environment(\.interfaceLook) private var look
    @FocusState private var typing: Bool

    var body: some View {
        HStack(spacing: 0) {
            if look.isClassic {
                nav("chevron.left", enabled: !files.back.isEmpty, help: "Back ⌘[") { files.goBack() }
                nav("chevron.right", enabled: !files.forward.isEmpty, help: "Forward ⌘]") { files.goForward() }
                    .padding(.trailing, 4)
            }
            if let going = files.going {
                TextField("", text: Binding(get: { going }, set: { files.going = $0 }), prompt: Text("Go to Folder"))
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, design: look.isClassic ? .default : .monospaced))
                    .focused($typing)
                    .onSubmit { files.goTyped(files.going ?? "") }
                    .onExitCommand { files.going = nil }
                    .onAppear { typing = true }
                    .padding(.horizontal, 4)
                    .frame(height: 20)
                    .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 5 : 0).strokeBorder(Color.signal, lineWidth: 1))
            } else if let root = files.root {
                crumbs(root)
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, look.isClassic ? 10 : 12)
        .padding(.bottom, 7)
    }

    private func crumbs(_ root: String) -> some View {
        let all = FilesPath.levels(of: root)
        let budget = Double(files.width) - (look.isClassic ? 80 : 30)
        let classic = look.isClassic
        let width: (FilesPath.Level) -> Double = { level in
            let chars = Double(level.path == "/" ? 1 : level.name.count)
            if classic { return level.path == "/" ? 24 : chars * 6.8 + 32 }
            return (chars + 3) * 7.25
        }
        let (shown, folded) = FilesPath.fitted(all, budget: budget, width: width, fold: look.isClassic ? 30 : 29)
        return HStack(spacing: look.isClassic ? 1 : 0) {
            ForEach(Array(shown.enumerated()), id: \.element.path) { i, level in
                if look.isClassic, i > 0 {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Look.faint).padding(.horizontal, 2)
                }
                FilesCrumb(files: files, level: level, current: level.path == root)
                    .padding(.trailing, !look.isClassic && level.path == "/" ? 4 : 0)
                if !look.isClassic, level.path != "/" { Text("/").mono(12).foregroundStyle(Look.faint).padding(.horizontal, 3) }
                if i == 0, !folded.isEmpty {
                    if look.isClassic { Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Look.faint).padding(.horizontal, 2) }
                    Menu {
                        ForEach(folded, id: \.path) { l in Button(l.name) { files.go(to: l.path) } }
                    } label: { Text("…").font(.system(size: 12, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.ink2) }
                        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                        .help(folded.map(\.name).joined(separator: " / "))
                    if !look.isClassic { Text("/").mono(12).foregroundStyle(Look.faint).padding(.horizontal, 3) }
                }
            }
        }
    }

    private func nav(_ symbol: String, enabled: Bool, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(Look.ink2).frame(width: 20, height: 20).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.35).help(help)
    }
}

private struct FilesCrumb: View {
    let files: FilesColumn
    let level: FilesPath.Level
    let current: Bool
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button { files.go(to: level.path) } label: {
            Group {
                if look.isClassic {
                    HStack(spacing: 3) {
                        Image(systemName: level.path == "/" ? "internaldrive" : "folder").font(.system(size: 10.5)).foregroundStyle(Color.signal)
                        if level.path != "/" { Text(level.name).font(.system(size: 12, weight: current ? .semibold : .regular)).foregroundStyle(current ? Look.ink : Look.ink2) }
                    }
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Look.raised.opacity(hovering ? 1 : 0)))
                } else {
                    Text(level.name).font(.system(size: 12, weight: current ? .bold : .regular, design: .monospaced))
                        .foregroundStyle(hovering ? Look.ground : current ? Look.ink : Look.ink2)
                        .padding(.horizontal, 1)
                        .background(hovering ? Look.ink : Color.clear)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(level.path == "/" ? "Macintosh HD" : level.path)
        .contextMenu {
            Button("Copy Path") { files.copyPaths([level.path]) }
            if files.local { Button("Show in Finder") { files.showInFinder([level.path]) } }
            Button("New Terminal Here") { files.newTerminal(level.path) }
        }
    }
}

// MARK: - the foot

private struct FilesFoot: View {
    let files: FilesColumn
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let level = files.root.flatMap { files.levels[$0] }
        HStack(spacing: 10) {
            if let level {
                let shown = files.entries(of: level.path).count
                Text(shown == 1 ? "1 Item" : "\(shown) Items")
                // The levels are read with their hidden entries (they are shown or not here, without asking again).
                let hidden = level.entries.filter(\.hidden).count
                if !files.showHidden, hidden > 0 { Text("\(hidden) Hidden") }
                if level.scoped { Text("仅显示授权范围内的项目。").lineLimit(1) }
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: look.isClassic ? 11.5 : 11, design: look.isClassic ? .default : .monospaced))
        .foregroundStyle(Look.faint)
        .padding(.horizontal, 12)
        .frame(height: 26)
    }
}

/// `⋯` › `Show Preview` off: one line for what is selected, and `Add to Reply`.
private struct FilesSelectionLine: View {
    let files: FilesColumn
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if files.selection.count == 1, let path = files.selection.first, let entry = files.entry(path) {
                    Text(entry.name).fontWeight(.semibold).foregroundStyle(Look.ink) + Text(" · " + (entry.isFolder ? "Folder" : FilesText.size(entry.size, short: false)))
                } else {
                    Text("\(files.selection.count) Items").fontWeight(.semibold).foregroundStyle(Look.ink) + Text(" · " + FilesText.size(files.selectedSize, short: false))
                }
            }
            .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            FilesReplyButton(files: files)
        }
        .font(.system(size: look.isClassic ? 12 : 11.5, design: look.isClassic ? .default : .monospaced))
        .foregroundStyle(Look.ink2)
        .padding(.horizontal, 12)
        .frame(height: 34)
    }
}

/// `Add to Reply`: the primary button; dim where the page has no reply box.
struct FilesReplyButton: View {
    let files: FilesColumn

    var body: some View {
        let target = files.target()
        Button { files.addToReply() } label: { BracketLabel(word: "Add to Reply") }
            .buttonStyle(BracketButtonStyle(role: .primary, size: 12))
            .disabled(target == nil || files.picks(files.selection).isEmpty)
            .help(target.map { "Add to Reply ⌥↩ · \($0.name)" } ?? "此页没有回复框。")
    }
}

// MARK: - edges

/// The column's left edge: dragged, its width (240–560 points).
private struct FilesResizeEdge: View {
    let files: FilesColumn
    @State private var start: CGFloat?

    var body: some View {
        Color.clear.frame(width: 6).contentShape(Rectangle())
            .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { drag in
                    let from = start ?? files.width
                    start = from
                    files.width = min(max(from - drag.translation.width, FilesColumn.widths.lowerBound), FilesColumn.widths.upperBound)
                }
                .onEnded { _ in start = nil })
            .offset(x: -3)
    }
}

/// The line between the list and the preview: dragged, how much of the column the preview takes.
private struct FilesSplitEdge: View {
    let files: FilesColumn
    let height: CGFloat
    @State private var start: CGFloat?

    var body: some View {
        Rectangle().fill(Look.line).frame(height: 1)
            .overlay(Color.clear.frame(height: 7).contentShape(Rectangle())
                .onHover { inside in if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() } }
                .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { drag in
                        let from = start ?? files.previewShare
                        start = from
                        files.previewShare = min(max(from - drag.translation.height / max(height, 1), 0.15), 0.85)
                    }
                    .onEnded { _ in start = nil }))
    }
}
