import AgentSwitchMacCore
import AppKit
import SwiftUI

// The settings window's Dispatch group (docs/dispatch-v0.md §3): Context, Extensions, Log, History — what the web
// console's side column and the phone's settings had, drawn as the other settings pages are (ui-v0 §7.4 Mac: system
// forms and controls, names and values monospaced, `// Label` groups, formal Chinese explanations). The pages depend on
// `DispatchService` only; this Mac's daemon (`AppModel.client`) unless the window was given another (the preview's).

/// What the Dispatch group's pages are given besides the app's model.
struct DispatchSettingsEnvironment {
    /// The Mac the pages read and change; nil: this Mac's daemon.
    var service: (any DispatchService)?
    /// Opens a task's page in the main window's Dispatch page (a search hit, a topic, an experience's source task).
    var openTask: @MainActor (String) -> Void = { _ in }
    /// `-designPreview`: the state a page is drawn in.
    var preset = DispatchSettingsPreset()
}

/// States the design preview draws the pages in; empty in the app.
struct DispatchSettingsPreset {
    /// Log: these rows open.
    var expandedLogRows: Set<Int> = []
    /// History: typed in the search field.
    var historyQuery = ""
}

extension EnvironmentValues {
    @Entry var dispatchSettings = DispatchSettingsEnvironment()
}

/// The service and whether it can be asked, for a page.
@MainActor
struct DispatchSettingsSource {
    let model: AppModel
    let environment: DispatchSettingsEnvironment

    var service: any DispatchService { environment.service ?? model.client }
    var ready: Bool { environment.service != nil || model.daemonReady }
}

/// A page's content once the service runs; `Service Not Ready` before (as the other settings pages).
struct DispatchSettingsGate<Content: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @ViewBuilder var content: Content

    var body: some View {
        if DispatchSettingsSource(model: model, environment: dispatch).ready {
            content
        } else {
            EmptyPage(title: "Service Not Ready", symbol: "hourglass", message: model.daemonLine.text)
        }
    }
}

/// How the pages say what went wrong (docs/ui-v0.md §4.1: the cause, then what to do).
enum DispatchSettingsProblem {
    /// A refusal in the daemon's own words (400, 404, 409), anything else as described.
    static func text(_ error: Error) -> String {
        (error as? DaemonError)?.reason ?? error.localizedDescription
    }

    /// A delete or archive the daemon refused because something in it still runs (409), as the phone says it.
    static func busy(_ error: Error) -> String {
        if case DaemonError.http(status: 409, let message) = error {
            return "有任务正在进行或等你处理，暂无法执行此操作。请取消任务，或等待任务结束后重试。" + (message.isEmpty ? "" : "（\(message)）")
        }
        return text(error)
    }
}

/// A red line with what went wrong, selectable (a section of its own in a form).
struct SettingsProblemLine: View {
    let text: String

    var body: some View {
        Label {
            Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "xmark.circle.fill")
        }
        .foregroundStyle(Color.failed)
    }
}

/// An amber line: done, with something to know (lines removed, an older daemon).
struct SettingsNoteLine: View {
    let text: String

    var body: some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .foregroundStyle(Color.waiting)
    }
}

/// A topic's own colour square (DispatchTopicHue: the web console's): which topic, never a status.
struct SettingsTopicSquare: View {
    let id: String

    var body: some View {
        let hex = DispatchTopicHue.hex(for: id)
        PixelSprite(rows: PixelArt.square, pixel: 2,
                    color: Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                                 blue: Double(hex & 0xFF) / 255))
    }
}

/// An extension's executors as checkboxes, in the daemon's order.
struct SettingsHarnessCheckboxes: View {
    @Binding var selection: [String]

    var body: some View {
        HStack(spacing: 14) {
            ForEach(DispatchExtensionHarnesses.all, id: \.self) { harness in
                Toggle(HarnessName.display(harness), isOn: Binding(
                    get: { selection.contains(harness) },
                    set: { on in selection = DispatchExtensionHarnesses.all.filter { $0 == harness ? on : selection.contains($0) } }))
                    .toggleStyle(.checkbox)
            }
        }
    }
}

// MARK: - AppKit text controls

/// A plain-text editor for the files the group edits: monospaced, no smart quotes, dashes or spelling (the text is
/// read by models and parsed), with undo. Inside a grouped form it draws no box of its own: the form's row is the box.
struct SettingsTextEditor: NSViewRepresentable {
    @Binding var text: String
    var fontSize: CGFloat = 12.5
    var editable = true

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.delegate = context.coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isAutomaticLinkDetectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.isGrammarCheckingEnabled = false
        view.smartInsertDeleteEnabled = false
        view.drawsBackground = false
        view.font = .monospacedSystemFont(ofSize: fontSize, weight: .regular)
        view.textColor = .labelColor
        view.textContainerInset = NSSize(width: 0, height: 4)
        view.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.text = $text
        guard let view = scroll.documentView as? NSTextView else { return }
        // Only a change from outside (a load, the example, a revert) replaces what is in the view.
        if view.string != text { view.string = text }
        if view.isEditable != editable { view.isEditable = editable }
        view.textColor = editable ? .labelColor : .secondaryLabelColor
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var text: Binding<String>

        init(text: Binding<String>) { self.text = text }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            text.wrappedValue = view.string
        }
    }
}

/// The system's search field (a page's own, not the toolbar's): changes as typed, the clear button empties it.
struct SettingsSearchField: NSViewRepresentable {
    @Binding var text: String
    let prompt: String

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> NSSearchField {
        let field = NSSearchField()
        field.placeholderString = prompt
        field.delegate = context.coordinator
        field.sendsSearchStringImmediately = true
        field.target = context.coordinator
        field.action = #selector(Coordinator.searched(_:))
        field.stringValue = text
        return field
    }

    func updateNSView(_ field: NSSearchField, context: Context) {
        context.coordinator.text = $text
        if field.stringValue != text { field.stringValue = text }
    }

    @MainActor
    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var text: Binding<String>

        init(text: Binding<String>) { self.text = text }

        func controlTextDidChange(_ notification: Notification) {
            if let field = notification.object as? NSTextField { text.wrappedValue = field.stringValue }
        }

        @objc func searched(_ sender: NSSearchField) { text.wrappedValue = sender.stringValue }
    }
}

/// A button that deletes: the system's button with its word in red (the demo's red buttons).
struct SettingsDeleteButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(role: .destructive, action: action) { Text(title).foregroundStyle(Color.failed) }
    }
}
