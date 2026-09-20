import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        NavigationSplitView {
            KeypairsView()
                .navigationSplitViewColumnWidth(min: 260, ideal: 300)
        } detail: {
            TokenGeneratorView()
        }
        .alert("出错了", isPresented: Binding(get: { state.errorMessage != nil },
                                             set: { if !$0 { state.errorMessage = nil } })) {
            Button("好") { state.errorMessage = nil }
        } message: {
            Text(state.errorMessage ?? "")
        }
        .toolbar {
            if state.busy { ProgressView().controlSize(.small) }
        }
    }
}
