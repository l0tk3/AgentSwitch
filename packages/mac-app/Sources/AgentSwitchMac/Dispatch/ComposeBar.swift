import AgentSwitchMacCore
import SwiftUI

/// The input at the record's foot (docs/dispatch-v0.md §2, demo `.compose`): the pin (`Pin → Opus 5.5 ×`) and the files
/// waiting to go above it; `+` (the system's menu: `Files…`, `Paste Image`, `New Ciphertext`, `Pin Model ▸`), the
/// field, the square send button — ink when there is something to send, signal under the pointer. ↩ sends, ⇧↩ is a new
/// line. No folder, model, browser or approval row: the dispatch model decides those (control-v0 §2).
struct ComposeBar: View {
    let model: DispatchModel
    @State private var height = ComposeField.minHeight
    @State private var sealing = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 8) {
            if let pin = model.pin { PinChip(name: pinName(pin)) { model.pin = nil } }
            if !model.attachments.isEmpty || model.preparing > 0 { attachments }
            HStack(alignment: .bottom, spacing: 8) {
                MenuButton(entries: { plusMenu }, above: true, help: "Attach, Ciphertext, Pin Model") {
                    PlusSquare(side: fieldHeight)
                }
                .buttonStyle(.plain)
                field
                SendSquare(active: model.canSend, sending: model.sending, side: fieldHeight) { Task { await model.send() } }
            }
            if !model.text.isEmpty {
                HStack(spacing: 14) {
                    if DispatchLimits.messageTooLong(model.text) {
                        // Counted as the Mac counts (UTF-16 units); over it, nothing is sent.
                        Text("消息过长，请缩短后发送。").font(.system(size: 11.5)).foregroundStyle(Color.failed)
                        Text(DispatchLimits.counter(model.text.trimmingCharacters(in: .whitespacesAndNewlines),
                                                    limit: DispatchLimits.message))
                            .foregroundStyle(Color.failed)
                    }
                    Spacer()
                    Text("↩ Send")
                    Text("⇧↩ New Line")
                }
                .mono(11)
                .foregroundStyle(Look.faint)
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 16)
        .dispatchColumn()
        .sheet(isPresented: $sealing) { CiphertextSheet(model: model) }
    }

    /// The field's box: the text's height and its padding, 38 pt at least.
    private var fieldHeight: CGFloat { max(38, height + 20) }

    private var field: some View {
        @Bindable var model = model
        return ZStack(alignment: .topLeading) {
            ComposeField(text: $model.text, height: $height, focusRequests: model.focusRequests, insert: model.insertRequest,
                         active: model.route == nil, placeholder: "输入任务或问题",
                         onSubmit: { Task { await model.send() } },
                         onFiles: { model.attach(urls: $0) },
                         onPasteAttachments: { model.pasteFromClipboard() },
                         onFocus: { model.inputFocused = $0 })
                .frame(height: height)
        }
        .padding(.horizontal, look.isClassic ? 14 : 12)
        .padding(.vertical, 10)
        .frame(minHeight: 38)
        // The classic look's field: its own ground, round as a message's bubble (docs/ui-v0.md §8).
        .grounded(look.isClassic ? Look.panel : Color.clear, radius: 17)
        .framed(model.text.isEmpty && !model.inputFocused ? Look.line : Look.faint, radius: 17)
    }

    private var attachments: some View {
        VStack(alignment: .leading, spacing: 4) {
            FlowLayout(spacing: 8, lineSpacing: 6) {
                ForEach(model.attachments) { item in
                    HStack(spacing: 8) {
                        Text(item.file.name).lineLimit(1).truncationMode(.middle)
                        Button { model.removeAttachment(item.id) } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 11.5) }
                            .buttonStyle(QuietButtonStyle())
                            .help("Remove")
                    }
                    .mono(11.5)
                    .foregroundStyle(Look.ink2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .framed(Look.line, radius: Look.controlRadius)
                }
                if model.preparing > 0 {
                    HStack(spacing: 6) { BrailleSpinner(); Text("Preparing").mono(11.5).foregroundStyle(Look.ink2) }
                }
            }
            if !model.attachments.isEmpty {
                Text("附件不经过自动加密，其中的密码将原样提供给模型。").font(.system(size: 11)).foregroundStyle(Color.waiting)
            }
        }
    }

    private var plusMenu: [MenuEntry] {
        let options = model.targets?.pinOptions ?? []
        let pins = [MenuEntry(title: "Auto", checked: model.pin == nil, action: { model.pin = nil }), .separator]
            + options.map { target in MenuEntry(title: pinName(target), checked: model.pin == target, action: { model.pin = target }) }
        return [
            MenuEntry(title: "Files…", symbol: "folder", action: { model.chooseFiles() }),
            MenuEntry(title: "Paste Image", symbol: "doc.on.clipboard", key: "v", action: { model.pasteFromClipboard() }),
            .separator,
            MenuEntry(title: "New Ciphertext", symbol: "plus", enabled: model.gate != nil, action: { sealing = true }),
            .separator,
            MenuEntry(title: "Pin Model", symbol: "pin", children: pins),
        ]
    }

    /// A model as the menu and the chip say it: its name, with the executor when two executors offer the same name.
    private func pinName(_ target: DispatchTarget) -> String {
        let options = model.targets?.pinOptions ?? []
        return options.filter { $0.modelName == target.modelName }.count > 1 ? target.displayName : target.modelName
    }
}

/// `Pin → Opus 5.5 ×`: the next message goes to this model; `×` gives the choice back to the dispatch model.
private struct PinChip: View {
    let name: String
    let clear: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("Pin → \(name)")
            Button(action: clear) { LookGlyph(glyph: "×", symbol: "xmark") }.buttonStyle(QuietButtonStyle()).help("Auto")
        }
        .mono(12)
        .foregroundStyle(Look.ink)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .framed(Look.faint, radius: Look.controlRadius)
    }
}

/// `+`: a framed square, brighter under the pointer; a plus in a circle in the classic look.
private struct PlusSquare: View {
    let side: CGFloat
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group {
            if look.isClassic {
                Image(systemName: "plus.circle").font(.system(size: 21, weight: .light))
                    .foregroundStyle(hovering ? Look.ink : Look.ink2)
                    .frame(width: 30, height: side)
            } else {
                Text("+")
                    .font(.system(size: 18, design: .monospaced))
                    .foregroundStyle(hovering ? Look.ink : Look.ink2)
                    .frame(width: 38, height: side)
                    .overlay(Rectangle().strokeBorder(hovering ? Look.ink2 : Look.line, lineWidth: 1))
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// `↑`: ink when there is something to send (the primary button, §7.2.3), signal under the pointer; a frame otherwise.
/// In the classic look a disc in the accent's colour with an arrow, grey while there is nothing to send.
private struct SendSquare: View {
    let active: Bool
    let sending: Bool
    let side: CGFloat
    let send: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: send) {
            if look.isClassic { classic } else { pixel }
        }
        .buttonStyle(.plain)
        .disabled(!active)
        .onHover { hovering = $0 }
        .help(ClassicWords.help("Send ↩", in: look))
        .accessibilityLabel("Send")
    }

    private var pixel: some View {
        Group {
            if sending { BrailleSpinner() } else { Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced)) }
        }
        .foregroundStyle(active ? (hovering ? Color.black : Look.ground) : Look.faint)
        .frame(width: 38, height: side)
        .background(active ? (hovering ? Color.signal : Look.ink) : Color.clear)
        .overlay(Rectangle().strokeBorder(active ? Color.clear : Look.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    private var classic: some View {
        Group {
            if sending { BrailleSpinner() } else { Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)) }
        }
        .foregroundStyle(active ? Color.white : Look.ink2)
        .frame(width: 28, height: 28)
        .background(Circle().fill(active ? Color.signal.opacity(hovering ? 0.85 : 1) : Look.raised))
        .frame(width: 32, height: side)
        .contentShape(Rectangle())
    }
}

/// `New Ciphertext` (a system sheet): a value sealed by this Mac's gate (`secret-gate enc`), bound to the sites typed;
/// the token goes into the input at the cursor and the value is dropped.
struct CiphertextSheet: View {
    let model: DispatchModel
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var sites = ""
    @State private var value = ""
    @State private var failure: String?

    var body: some View {
        let request = GateSealRequest(label: label, sites: sites, value: value)
        let problem = label.isEmpty && sites.isEmpty && value.isEmpty ? nil : request.problem
        VStack(alignment: .leading, spacing: 16) {
            Text("New Ciphertext").font(.headline)
            Form {
                TextField("Name", text: $label, prompt: Text("例如 fin/pass"))
                TextField("Sites", text: $sites, prompt: Text("fin.example.com，多个用逗号分隔"))
                SecureField("Value", text: $value, prompt: Text("密码或 token"))
            }
            .formStyle(.columns)
            .autocorrectionDisabled()
            Text(failure ?? problem ?? "由此 Mac 的凭据网关加密，仅可用于所填站点。明文不保存。")
                .font(.callout)
                .foregroundStyle(failure != nil || problem != nil ? Color.attention : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") {
                    value = ""
                    model.cancelSeal()
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Insert") {
                    Task {
                        let error = await model.seal(request)
                        value = ""
                        if let error { failure = error } else { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(request.problem != nil || model.sealing)
            }
        }
        .padding(20)
        .frame(width: 420)
        .tint(.brand)
        .onDisappear {
            value = ""
            model.cancelSeal()
        }
    }
}
