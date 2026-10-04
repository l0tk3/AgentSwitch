import AgentSwitchMacCore
import SwiftUI

/// The main window's Dispatch page (docs/dispatch-v0.md §2): the phone's home on a desk — the record (the conversation,
/// the tasks it made, the active topics) and one input, in one column; a task's or topic's page pushed in the same
/// column, the record kept where it was underneath. The window hosts it with the app's model and its own state in the
/// environment (MainWindowState.swift): the page writes the bar's title, `‹` and the open task; it answers back
/// (`‹`, Esc, ⌘[), ⌘N (the input) and a task the Live Activity asks for. Lists are polled every 6 s while the page is
/// seen — the page on screen in a visible window —, and nothing is polled or followed while it is not (under Terminals,
/// in a covered or minimised window).
struct DispatchPage: View {
    @Environment(AppModel.self) private var app
    @Environment(MainWindowState.self) private var window
    /// The demo's made-up Mac (`-designPreview`); nil: this Mac's service.
    @Environment(\.dispatchService) private var demo
    /// The preview's page to open on.
    @Environment(\.dispatchPreviewRoute) private var previewRoute
    @State private var model = DispatchModel()
    @State private var routes: [DispatchRoute] = []

    var body: some View {
        @Bindable var model = model
        ZStack {
            RecordPage(model: model, open: push)
                .opacity(routes.isEmpty ? 1 : 0)
                .allowsHitTesting(routes.isEmpty)
                .accessibilityHidden(!routes.isEmpty)
            if let route = routes.last {
                page(route).id(route).background(Look.ground)
            }
        }
        .background(Look.ground)
        .sheet(item: $model.sourceFile) { SourceFileSheet(file: $0) }
        .onAppear {
            attach()
            openRequested()
            if let previewRoute, routes.isEmpty { routes = [previewRoute] }
        }
        .task(id: PollKey(seen: seen, ready: ready)) { await poll() }
        // The window closed: nothing is followed or read any more.
        .onDisappear {
            model.stopStreams()
            model.speaker.stop()
        }
        .onChange(of: window.backRequests) { back() }
        .onChange(of: window.focusRequests) {
            routes = []
            model.focusInput()
        }
        .onChange(of: window.requestedTask) { openRequested() }
        // Read marks only for the page in use: shown, in the key window (not under Terminals).
        .onChange(of: window.windowKey && window.windowVisible && window.dispatchShown, initial: true) { _, key in model.windowKey = key }
        .onChange(of: window.editingText, initial: true) { _, editing in model.editingText = editing }
        .onChange(of: routes, initial: true) { routesChanged() }
        // The status bar's right on Dispatch: the router's model and the open topics.
        .onChange(of: StatusFacts(router: model.targets?.routerModel?.model, topics: model.threads.filter { $0.status == "open" }.count),
                  initial: true) { _, facts in window.dispatchChanged(router: facts.router, topics: facts.topics) }
    }

    private struct StatusFacts: Equatable {
        let router: String?
        let topics: Int
    }

    @ViewBuilder
    private func page(_ route: DispatchRoute) -> some View {
        switch route {
        case .task(let id): TaskPageView(taskId: id, model: model, open: push, close: back, visible: seen)
        case .topic(let id): TopicPageView(threadId: id, model: model, open: push, close: back, visible: seen)
        }
    }

    // MARK: the service

    /// The page is seen: the one on screen in a visible window (or drawn for the demo).
    private var seen: Bool { (window.windowVisible && window.dispatchShown) || demo != nil }
    /// The service answers (the bar says `■ Service Down` while it does not).
    private var ready: Bool { demo != nil || app.daemonReady }

    private struct PollKey: Equatable {
        let seen: Bool
        let ready: Bool
    }

    private func attach() {
        guard let demo else { return model.attach(app.client, gate: app.gateCLI, demo: false) }
        model.attach(demo, gate: nil, demo: true)
        #if DEBUG
        if demo is DispatchDemoService { model.markLocal(DispatchDemoData.downloaded.file, taskId: DispatchDemoData.downloaded.task) }
        #endif
    }

    /// The first load whenever the service is there; then every 6 s, with the live streams, while the page is seen. A
    /// poll given up for the next one (the page hidden, the service gone) starts no stream on its way out.
    private func poll() async {
        guard ready else { return model.stopStreams() }
        if !seen {
            model.stopStreams()
            if model.loaded { return }
        }
        await model.refreshAll()
        guard !Task.isCancelled else { return }
        model.syncStreams(live: seen)
        while seen && !Task.isCancelled {
            try? await Task.sleep(for: DispatchDefaults.pollInterval)
            guard !Task.isCancelled else { break }
            await model.refreshAll()
            guard !Task.isCancelled else { break }
            model.syncStreams(live: true)
        }
    }

    // MARK: pages

    private func push(_ route: DispatchRoute) {
        if routes.last != route { routes.append(route) }
    }

    private func back() {
        if !routes.isEmpty { routes.removeLast() }
    }

    /// A task the Live Activity asked for (also read as the page appears: the window may have opened for it).
    private func openRequested() {
        guard window.requestedTask != nil, let id = window.takeRequestedTask() else { return }
        routes = [.task(id)]
    }

    /// What the bar shows: `‹` on a pushed page, the open task (the Live Activity keeps quiet about it); the pages set
    /// their own titles.
    private func routesChanged() {
        model.route = routes.last
        window.showsBack = !routes.isEmpty
        if case .task(let id)? = routes.last { window.openTask = id } else { window.openTask = nil }
        if routes.isEmpty { window.dispatchTitle = nil }
    }
}

private struct DispatchServiceKey: EnvironmentKey {
    static let defaultValue: (any DispatchService)? = nil
}

extension EnvironmentValues {
    /// A Mac to show instead of this one's service: the design preview's demo (DispatchDemo.swift).
    var dispatchService: (any DispatchService)? {
        get { self[DispatchServiceKey.self] }
        set { self[DispatchServiceKey.self] = newValue }
    }

    /// The design preview: the page opens on this task's or topic's page.
    @Entry var dispatchPreviewRoute: DispatchRoute?
}

/// A web page, SVG or XML a task handed back, as text (a local preview could fetch its remote resources).
private struct SourceFileSheet: View {
    let file: SourceFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(file.url.lastPathComponent).font(.headline)
                Spacer()
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([file.url]) }
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            ScrollView([.vertical, .horizontal]) {
                Text(file.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Look.raised)
        }
        .padding(16)
        .frame(width: 720, height: 520)
    }
}
