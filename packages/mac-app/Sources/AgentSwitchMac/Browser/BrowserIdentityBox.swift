import AgentSwitchMacCore
import SwiftUI

/// The status bar's right end on the Browser page (design page `docs/design/implemented/browser-window.html`): a word
/// about the engine while it is being updated or is not there, and the browser's identity in a few words — the item
/// that opens the box below.
struct BrowserIdentityItems: View {
    @Bindable var model: BrowserIdentityModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 12) {
            if let word = model.engineWord {
                Text(word).foregroundStyle(Color.waiting)
            }
            Button { model.open.toggle() } label: {
                Text(model.statusWord)
                    .foregroundStyle(model.open ? (look.isClassic ? Color.white : Look.ground) : Look.ink)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: look.isClassic ? 4 : 0).fill(model.open ? (look.isClassic ? Color.signal : Look.ink) : Color.clear))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("浏览器的指纹、代理与引擎")
            .accessibilityLabel("Browser Identity")
        }
    }
}

/// The box over the page's lower right corner: `Fingerprint`, `Proxy` and `Engine` while Camoufox runs; the engine
/// alone while it is being updated or is not installed yet.
struct BrowserIdentityBox: View {
    @Bindable var model: BrowserIdentityModel
    @Environment(\.interfaceLook) private var look
    static let width: CGFloat = 372

    var body: some View {
        // In a short window the box scrolls rather than leaving the page.
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }
        }
        .frame(width: Self.width)
        .background(shape.fill(Look.panel))
        .overlay(shape.strokeBorder(look.isClassic ? Look.line : Look.ink, lineWidth: look.isClassic ? 0.5 : 1))
        .shadow(color: .black.opacity(look.isClassic ? 0.35 : 0), radius: 18, y: 8)
        .onExitCommand { model.open = false }
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: look.isClassic ? Look.cardRadius : 0, style: .continuous) }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.hasIdentity, !model.updating, let identity = model.identity {
                fingerprint(identity)
                rule
                proxy(identity)
                rule
            }
            engine
            if let problem = model.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var rule: some View {
        Rectangle().fill(Look.line).frame(height: 1).padding(.top, 12).padding(.bottom, 12)
    }

    // MARK: fingerprint

    private func fingerprint(_ identity: BrowserIdentity) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            PartLabel("Fingerprint")
            rows(BrowserIdentityText.rows(identity.fingerprint))
            HStack(spacing: 8) {
                Button { model.newFingerprint() } label: { BracketLabel(word: "New Fingerprint") }
                    .buttonStyle(BracketButtonStyle())
                Button { model.importFingerprint() } label: { BracketLabel(word: "Import…") }
                    .buttonStyle(BracketButtonStyle())
                if model.working == .fingerprint { BrailleSpinner() }
            }
            .disabled(model.working != nil)
            hint(BrowserIdentityText.fingerprintHint)
        }
    }

    // MARK: proxy

    private func proxy(_ identity: BrowserIdentity) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            PartLabel("Proxy")
            field { TextField("", text: $model.draft.server, prompt: Text("socks5://host:port").foregroundColor(Look.faint)).onSubmit { model.applyProxy() } }
            HStack(spacing: 6) {
                field {
                    Text("user").foregroundStyle(Look.faint)
                    TextField("", text: $model.draft.username)
                }
                field {
                    // The word under an empty field: a secure field's own prompt takes no colour.
                    let sealed = model.draft.keepsPassword(of: identity.proxy)
                    ZStack(alignment: .leading) {
                        if model.draft.password.isEmpty {
                            Text(sealed ? "■ \(BrowserIdentityText.sealedWord)" : "password").foregroundStyle(sealed ? Color.ok : Look.faint).allowsHitTesting(false)
                        }
                        SecureField("", text: $model.draft.password).onSubmit { model.applyProxy() }
                    }
                }
            }
            if identity.proxy != nil {
                rows([("exit", BrowserIdentityText.exit(identity.exit))])
            }
            if let problem = model.draft.problem {
                Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Button { model.applyProxy() } label: { BracketLabel(word: "Apply") }
                    .buttonStyle(BracketButtonStyle(role: .primary))
                    .disabled(!model.draft.canApply)
                Button { model.direct() } label: { BracketLabel(word: "Direct") }
                    .buttonStyle(BracketButtonStyle())
                    .disabled(identity.proxy == nil)
                if model.working == .proxy { BrailleSpinner() }
            }
            .disabled(model.working != nil)
            if identity.restartNeeded {
                VStack(alignment: .leading, spacing: 6) {
                    Text(BrowserIdentityText.restartHint).font(.system(size: 12)).foregroundStyle(Color.waiting).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button { model.restartBrowser() } label: { BracketLabel(word: "Restart Browser") }
                            .buttonStyle(BracketButtonStyle(size: 12))
                            .disabled(model.working != nil)
                        if model.working == .restart { BrailleSpinner() }
                    }
                }
            }
            hint(BrowserIdentityText.proxyHint)
        }
    }

    // MARK: engine

    @ViewBuilder
    private var engine: some View {
        VStack(alignment: .leading, spacing: 8) {
            PartLabel("Engine")
            if let engine = model.engine {
                rows([("camoufox", BrowserEngineText.camoufox(engine))] + (BrowserEngineText.target(engine).map { [("to", $0)] } ?? [])
                     + [("playwright", BrowserEngineText.playwright(engine))]
                     + (engine.update.running ? [] : (BrowserEngineText.offer(engine).map { [(engine.camoufox == nil ? "download" : "available", $0)] } ?? [])))
                if engine.update.running {
                    progress(engine.update)
                } else {
                    if engine.update.ok == false, let error = engine.update.error {
                        Text(error).font(.system(size: 12)).foregroundStyle(Color.waiting).fixedSize(horizontal: false, vertical: true)
                    } else if let problem = engine.problem {
                        Text(problem).font(.system(size: 12)).foregroundStyle(Color.waiting).fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 8) {
                        if engine.camoufox == nil {
                            Button { model.updateEngine() } label: { BracketLabel(word: "Download") }
                                .buttonStyle(BracketButtonStyle(role: .primary))
                        } else if engine.available != nil {
                            Button { model.updateEngine() } label: { BracketLabel(word: "Update") }
                                .buttonStyle(BracketButtonStyle(role: .primary))
                        }
                        if engine.camoufox != nil || engine.available == nil {
                            Button { Task { await model.check() } } label: { BracketLabel(word: "Check for Update") }
                                .buttonStyle(BracketButtonStyle())
                        }
                        if model.checking || model.working == .engine { BrailleSpinner() }
                    }
                    .disabled(model.working != nil || model.checking)
                }
                if engine.update.running || engine.camoufox == nil {
                    hint(engine.camoufox == nil && !engine.update.running ? BrowserEngineText.missingHint : BrowserEngineText.hint)
                }
            } else {
                Text("当前服务未提供浏览器引擎的信息。").font(.system(size: 12)).foregroundStyle(Look.ink2)
            }
        }
    }

    private func progress(_ update: BrowserEngineUpdate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Look.line)
                    Rectangle().fill(Color.signal).frame(width: geometry.size.width * (BrowserEngineText.fraction(update) ?? (update.phase == "download" ? 0 : 1)))
                }
            }
            .frame(height: 6)
            .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 3 : 0))
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(BrowserEngineText.steps(update).enumerated()), id: \.offset) { _, step in
                    let word = step.state == .now && update.phase == "download" ? (BrowserEngineText.progress(update) ?? step.word) : step.word
                    Text("\(step.state == .done ? "■" : step.state == .now ? "▸" : "□") \(word)")
                        .foregroundStyle(step.state == .done ? Color.ok : step.state == .now ? Look.ink : Look.faint)
                }
            }
            .code(12)
            Button { model.cancelUpdate() } label: { BracketLabel(word: "Cancel") }
                .buttonStyle(BracketButtonStyle())
                .disabled(model.working != nil)
                .padding(.top, 4)
        }
    }

    // MARK: parts

    /// A word and its value, the words in a column.
    private func rows(_ rows: [(String, String)]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.0).foregroundStyle(Look.ink2).frame(width: 82, alignment: .leading)
                    Text(row.1).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.middle).help(row.1)
                }
            }
        }
        .mono(12.5)
    }

    private func field<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8) { content() }
            .textFieldStyle(.plain)
            .code(12)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .framed(Look.faint, radius: Look.controlRadius)
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).lineSpacing(3).foregroundStyle(Look.ink2).fixedSize(horizontal: false, vertical: true)
    }
}
