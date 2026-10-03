import AgentSwitchMacCore
import SwiftUI

/// Fill Ciphertext (a system sheet, as the Dispatch page's New Ciphertext; docs/browser-v0.md §1 Mac): a whole `enc:v1:`
/// ciphertext pasted, or `New…` — a value sealed by this Mac's gate for the page's site — typed into the page's focused
/// input field through the gate, which checks it against that field's frame and every frame above it. References
/// (`enc:ref:`) belong to one task's run and are not accepted here.
///
/// The value lives only in the secure field and goes to the gate on stdin (`GateSealRequest`); it is cleared once sent,
/// on Cancel and whenever the sheet closes, and never logged. After a failed fill the ciphertext stays in the field (it
/// is not a secret), so Fill can be pressed again once the reason is dealt with.
struct BrowserFillSheet: View {
    let model: BrowserPageModel
    let target: BrowserFillTarget
    @Environment(\.dismiss) private var dismiss
    /// The `New…` form rather than the ciphertext field.
    @State private var sealing: Bool
    @State private var token = ""
    @State private var label = ""
    @State private var sites: String
    @State private var value = ""
    @State private var failure: String?

    init(model: BrowserPageModel, target: BrowserFillTarget, startsNew: Bool = false) {
        self.model = model
        self.target = target
        _sealing = State(initialValue: startsNew)
        _sites = State(initialValue: target.site)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(sealing ? "New Ciphertext" : "Fill Ciphertext").font(.headline)
            if sealing { sealForm } else { tokenForm }
            Text(failure ?? problem ?? caption)
                .font(.callout)
                .foregroundStyle(failure != nil || problem != nil ? Color.attention : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            buttons
        }
        .padding(20)
        .frame(width: 420)
        .tint(.brand)
        .onDisappear {
            value = ""
            model.cancelFill()
        }
    }

    private var request: GateSealRequest { GateSealRequest(label: label, sites: sites, value: value) }

    /// What stands in the way, once something has been typed.
    private var problem: String? {
        if sealing { return label.isEmpty && value.isEmpty ? nil : request.problem }
        return token.isEmpty ? nil : BrowserFillText.problem(token)
    }

    private var caption: String {
        sealing
            ? "由此 Mac 的凭据网关加密，仅可用于所填站点，随即填入页面中当前的输入框。明文不保存。"
            : "由凭据网关按站点核对后，填入页面中当前的输入框。仅接受完整的 enc:v1: 密文；引用（enc:ref:）属于某次任务，不可在此使用。"
    }

    private var tokenForm: some View {
        Form {
            TextField("Ciphertext", text: $token, prompt: Text("enc:v1:…"))
        }
        .formStyle(.columns)
        .autocorrectionDisabled()
    }

    private var sealForm: some View {
        Form {
            TextField("Name", text: $label, prompt: Text("例如 portal/pass"))
            TextField("Sites", text: $sites, prompt: Text("portal.example.com，多个用逗号分隔"))
            SecureField("Value", text: $value, prompt: Text("密码或 token"))
        }
        .formStyle(.columns)
        .autocorrectionDisabled()
    }

    private var buttons: some View {
        HStack {
            if !sealing && model.canSeal {
                Button("New…") {
                    failure = nil
                    sealing = true
                }
                .disabled(model.filling)
            }
            Spacer()
            if model.filling { ProgressView().controlSize(.small) }
            Button("Cancel") {
                value = ""
                model.cancelFill()
                dismiss()
            }
            .keyboardShortcut(.cancelAction)
            Button("Fill") { if sealing { sealAndFill() } else { fillToken() } }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(model.filling || !ready)
        }
    }

    /// Fill may be pressed: a whole ciphertext, or a complete New… form.
    private var ready: Bool {
        sealing ? request.problem == nil : BrowserFillText.problem(token) == nil
    }

    private func fillToken() {
        failure = nil
        let token = token
        Task {
            if let reason = await model.fill(token, into: target.tabId) { failure = reason } else { dismiss() }
        }
    }

    private func sealAndFill() {
        let request = request
        value = ""
        failure = nil
        Task {
            let outcome = await model.sealAndFill(request, into: target.tabId)
            if let token = outcome.token {
                // Sealed: the ciphertext takes the form's place, ready for another Fill if this one failed.
                self.token = token
                label = ""
                sealing = false
            }
            if let reason = outcome.failure { failure = reason } else { dismiss() }
        }
    }
}
