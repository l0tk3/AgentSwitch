#if DEBUG
import AgentSwitchKit
import SwiftUI
import UIKit

/// The Browser tab's sample state (`-uiDemo YES`, debug builds only), as the demo page `docs/design/implemented/browser.html`
/// has it: codex working on a pull request in its terminal, a dispatched task waiting at a login for a code, and two
/// tabs of yours — a file of the Mac's and a local dev server. The pictures are mock pages drawn on the phone, standing
/// in for the Mac's frames. `-uiDemoScreen browser|browserpage|browsertook|browserfile|browserlocal|browserdenied|
/// browsernew|browserclose|browserzoom|browserzoomwatch`.
enum DemoBrowser {
    static let codex = BrowserTabOwner(kind: .terminal, id: "e5f6a7b8", label: "codex · AgentSwitch")
    static let task = BrowserTabOwner(kind: .task, id: "t2", label: "登录财务平台，汇总首页的待办")
    /// The merge button where the mock page draws it (CSS pixels of a 640 × 900 page).
    static let mergeBox = BrowserBox(x: 28, y: 584, width: 250, height: 50)

    private static var screen: String? { UserDefaults.standard.string(forKey: "uiDemoScreen") }
    private static let phone = BrowserViewport(width: 402, height: 700, scale: 3, mobile: true, by: PhoneScreen.id)
    private static let agentSize = BrowserViewport(width: 640, height: 900)

    static var list: BrowserTabList {
        let took = screen == "browsertook"
        let pr = BrowserTabInfo(id: "pr", owner: codex, title: "Add native Dispatch page · Pull Request #128", url: "https://github.com/acme/app/pull/128",
                                site: "github.com", status: .busy,
                                action: BrowserAgentAction(tool: "browser_click", description: "click \"Merge pull request\"", box: mergeBox),
                                viewport: agentSize, openedAt: 1)
        let issues = BrowserTabInfo(id: "issues", owner: codex, title: "Issues · acme/app", url: "https://github.com/acme/app/issues",
                                    site: "github.com", viewport: agentSize, openedAt: 2)
        let portal = BrowserTabInfo(id: "portal", owner: task, title: "登录 · 财务平台", url: "https://portal.example.com/login",
                                    site: "portal.example.com", status: .waiting, heldBy: took ? PhoneScreen.id : nil,
                                    action: BrowserAgentAction(tool: "needs_user", description: "等你：短信验证码"),
                                    viewport: took ? phone : agentSize, openedAt: 3)
        var yours = [
            BrowserTabInfo(id: "mesh", title: "Mesh · 网状连接（演示）", url: "file:///Users/me/Projects/AgentSwitch/docs/design/concepts/mesh.html",
                           site: "~/Projects/AgentSwitch/docs/design/concepts/mesh.html", kind: .file, heldBy: PhoneScreen.id, viewport: phone, openedAt: 4),
            BrowserTabInfo(id: "vite", title: "Acme · Dev", url: "http://localhost:5173/", site: "localhost:5173", kind: .local,
                           heldBy: PhoneScreen.id, viewport: phone, openedAt: 5),
        ]
        if screen == "browserdenied" {
            yours.append(BrowserTabInfo(id: "denied", title: "Not Viewable", url: "file:///Users/me/Projects/app/.env", site: "~/Projects/app/.env",
                                        kind: .file, heldBy: PhoneScreen.id, viewport: phone, openedAt: 6))
        }
        return BrowserTabList(running: true, groups: [BrowserTabGroup(owner: codex, tabs: [pr, issues]), BrowserTabGroup(owner: task, tabs: [portal]),
                                                     BrowserTabGroup(owner: .you, tabs: yours)])
    }

    static let servers = [BrowserLocalServer(port: 5173, pid: 4211, name: "vite", cwd: "/Users/me/Projects/site"),
                          BrowserLocalServer(port: 3000, bind: "all", pid: 4388, name: "next dev", cwd: "/Users/me/Projects/web")]
    static let recent = ["github.com/acme/app/pulls", "~/Projects/AgentSwitch/docs/design/implemented/browser.html", "localhost:3000"]
    /// The page zoom the demo phone remembers: none, but the dev server's pages at 50% on `browserzoom` (browser-v0 §1
    /// 页面缩放) — whatever was kept on the simulator is not shown.
    static var zoom: BrowserZoomMemory {
        screen == "browserzoom" ? BrowserZoomMemory().setting(50, for: "localhost:5173") : BrowserZoomMemory()
    }

    /// The tab a demo screen opens.
    static func openRequest(_ screen: String?) -> String? {
        switch screen {
        case "browserpage", "browserclose", "browserzoomwatch": return "pr"
        case "browsertook": return "portal"
        case "browserfile": return "mesh"
        case "browserlocal", "browserzoom": return "vite"
        case "browserdenied": return "denied"
        case "browsernew": return "new"
        default: return nil
        }
    }

    /// A tab's picture at its size, as the Mac would send it.
    @MainActor
    static func frame(for tab: BrowserTabInfo, size phone: CGSize? = nil) -> BrowserFrame? {
        let size = phone.map { CGSize(width: $0.width.rounded(), height: $0.height.rounded()) } ?? CGSize(width: tab.viewport.width, height: tab.viewport.height)
        let page: AnyView
        switch tab.id {
        case "pr": page = AnyView(PullRequestPage())
        case "issues": page = AnyView(IssuesPage())
        case "portal": page = AnyView(LoginPage(phone: tab.viewport.mobile))
        case "mesh": page = AnyView(FilePage())
        case "vite": page = AnyView(DevPage())
        case "denied": page = AnyView(DeniedPage())
        default: return nil
        }
        // A page longer than its window (zoomed in) shows its top, as a page does.
        let renderer = ImageRenderer(content: page.frame(width: size.width, height: size.height, alignment: .topLeading).environment(\.colorScheme, .light))
        renderer.scale = 1
        guard let jpeg = renderer.uiImage?.jpegData(compressionQuality: 0.8) else { return nil }
        return BrowserFrame(seq: 1, jpeg: jpeg, width: size.width, height: size.height)
    }
}

// MARK: mock pages (other people's sites, in their own colours)

private enum Site {
    static let ink = Color(red: 0.12, green: 0.14, blue: 0.16)
    static let ink2 = Color(red: 0.35, green: 0.39, blue: 0.43)
    static let line = Color(red: 0.82, green: 0.85, blue: 0.88)
    static let green = Color(red: 0.12, green: 0.53, blue: 0.24)
    static let blue = Color(red: 0.04, green: 0.41, blue: 0.85)
}

private struct PullRequestPage: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            HStack(spacing: 10) {
                Circle().fill(.white).frame(width: 18, height: 18)
                Text("acme / app").font(.system(size: 18, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 28)
            .frame(width: 640, height: 64, alignment: .leading)
            .background(Site.ink)
            VStack(alignment: .leading, spacing: 14) {
                (Text("Add native Dispatch page ").foregroundStyle(Site.ink) + Text("#128").foregroundStyle(Site.ink2).fontWeight(.regular))
                    .font(.system(size: 30, weight: .semibold))
                Text("◉ Open").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 16).padding(.vertical, 6).background(Capsule().fill(Site.green))
                Text("codex-bot wants to merge 14 commits into main").font(.system(size: 18)).foregroundStyle(Site.ink2)
                HStack(spacing: 26) {
                    Text("Conversation").foregroundStyle(Site.ink).padding(.bottom, 8).overlay(alignment: .bottom) { Color(red: 0.99, green: 0.55, blue: 0.45).frame(height: 3) }
                    Text("Commits 14"); Text("Checks 3"); Text("Files 38")
                }
                .font(.system(size: 18)).foregroundStyle(Site.ink2)
                Site.line.frame(height: 1)
            }
            .padding(.horizontal, 28)
            .offset(y: 92)
            VStack(alignment: .leading, spacing: 14) {
                check("All checks have passed")
                check("No conflicts with base branch")
                check("Merging can be performed automatically")
            }
            .padding(24)
            .frame(width: 584, height: 280, alignment: .topLeading)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Site.line, lineWidth: 2))
            .offset(x: 28, y: 380)
            Text("Merge pull request").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                .frame(width: DemoBrowser.mergeBox.width, height: DemoBrowser.mergeBox.height)
                .background(RoundedRectangle(cornerRadius: 10).fill(Site.green))
                .offset(x: DemoBrowser.mergeBox.x, y: DemoBrowser.mergeBox.y)
            VStack(alignment: .leading, spacing: 10) {
                Text("codex-bot commented").font(.system(size: 17, weight: .semibold)).foregroundStyle(Site.ink)
                Text("The Dispatch page is native now. Checks pass on macOS 27 and iOS 27.").font(.system(size: 17)).foregroundStyle(Site.ink2)
            }
            .padding(20)
            .frame(width: 584, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Site.line, lineWidth: 2))
            .offset(x: 28, y: 700)
        }
        .frame(width: 640, height: 900, alignment: .topLeading)
    }

    private func check(_ text: String) -> some View {
        HStack(spacing: 12) {
            Circle().fill(Site.green).frame(width: 18, height: 18)
            Text(text).font(.system(size: 18)).foregroundStyle(Site.ink)
        }
    }
}

private struct IssuesPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("●  acme / app").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 28).frame(maxWidth: .infinity, minHeight: 64, alignment: .leading).background(Site.ink)
            VStack(alignment: .leading, spacing: 16) {
                Text("Issues").font(.system(size: 30, weight: .semibold)).foregroundStyle(Site.ink)
                Text("12 Open · 48 Closed").font(.system(size: 18)).foregroundStyle(Site.ink2)
                ForEach(["Dispatch page loses the scroll position", "Sealed reply box covers the key bar", "Tailscale relay: frames stall", "Dark mode for the onboarding"], id: \.self) { title in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title).font(.system(size: 19, weight: .semibold)).foregroundStyle(Site.ink)
                        Text("opened 2 days ago by l0tk3").font(.system(size: 15)).foregroundStyle(Site.ink2)
                    }
                    Site.line.frame(height: 1)
                }
            }
            .padding(28)
            Spacer(minLength: 0)
        }
        .background(Color.white)
    }
}

private struct LoginPage: View {
    let phone: Bool

    var body: some View {
        let k: CGFloat = phone ? 1 : 1.5
        VStack(alignment: .leading, spacing: 12 * k) {
            Text("财务平台").font(.system(size: 22 * k, weight: .semibold)).frame(maxWidth: .infinity).padding(.bottom, 8 * k)
            Text("邮箱").font(.system(size: 13 * k, weight: .semibold))
            field("finance@me.com", focus: false, k: k)
            Text("密码").font(.system(size: 13 * k, weight: .semibold))
            field("", focus: true, k: k)
            Text("登录").font(.system(size: 15 * k, weight: .semibold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 40 * k).background(RoundedRectangle(cornerRadius: 6 * k).fill(Site.green))
                .padding(.top, 6 * k)
            Text("忘记密码？").font(.system(size: 13 * k)).foregroundStyle(Site.blue).frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Site.ink)
        .padding(.horizontal, 26 * k)
        .padding(.top, 40 * k)
        .background(Color.white)
    }

    private func field(_ text: String, focus: Bool, k: CGFloat) -> some View {
        HStack(spacing: 1) {
            Text(text).font(.system(size: 15 * k))
            if focus { Site.ink.frame(width: 1.5, height: 18 * k) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10 * k)
        .frame(height: 40 * k)
        .background(RoundedRectangle(cornerRadius: 6 * k).fill(.white))
        .overlay(RoundedRectangle(cornerRadius: 6 * k).strokeBorder(focus ? Site.blue : Site.line, lineWidth: focus ? 2 : 1))
        .shadow(color: focus ? Site.blue.opacity(0.25) : .clear, radius: 0, x: 0, y: 0)
        .padding(focus ? 0 : 0)
    }
}

private struct FilePage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Mesh · 网状连接（演示）").font(.system(size: 17, weight: .bold, design: .monospaced))
            Text("每台 Mac 本来就是服务端：手机与 iPad 连到其中任一台，任务在 Mac 之间转交。").font(.system(size: 13, design: .monospaced)).foregroundStyle(Color(white: 0.55))
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) { node("MacBook Pro"); Text("──"); node("Mac mini") }
                HStack(spacing: 6) { node("iPad"); Text("┈┈"); node("iPhone 17 Pro") }
            }
            .font(.system(size: 13, design: .monospaced))
            .padding(.top, 8)
            Text("（mesh.html 在 Mac 上渲染，这里是它的画面）").font(.system(size: 12, design: .monospaced)).foregroundStyle(Color(white: 0.32)).padding(.top, 12)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color(white: 0.91))
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black)
    }

    private func node(_ name: String) -> some View {
        Text(name).padding(.horizontal, 8).padding(.vertical, 6).overlay(Rectangle().strokeBorder(Color(white: 0.3), lineWidth: 1))
    }
}

private struct DevPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Acme · Dev").font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                .background(LinearGradient(colors: [Color(red: 0.43, green: 0.16, blue: 0.85), Color(red: 0.86, green: 0.15, blue: 0.47)], startPoint: .leading, endPoint: .trailing))
            VStack(alignment: .leading, spacing: 12) {
                Text("vite v6 · HMR connected").font(.system(size: 14)).foregroundStyle(Color(red: 0.62, green: 0.65, blue: 0.7))
                card { Text("Dashboard").foregroundStyle(Color(red: 0.62, green: 0.65, blue: 0.7)); Text("$12,480").font(.system(size: 28, weight: .bold)) }
                card { Text("改了 src/App.tsx，热更新后这里立即变。").foregroundStyle(Color(red: 0.62, green: 0.65, blue: 0.7)) }
                card { Text("Orders").foregroundStyle(Color(red: 0.62, green: 0.65, blue: 0.7)); Text("318").font(.system(size: 28, weight: .bold)) }
            }
            .padding(18)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Color(red: 0.9, green: 0.93, blue: 0.95))
        .background(Color(red: 0.05, green: 0.07, blue: 0.09))
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) { content() }
            .font(.system(size: 15))
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(red: 0.09, green: 0.11, blue: 0.13)))
    }
}

/// The Mac's own refusal page (playwrightDriver.ts refusalPage), as it shows in a tab.
private struct DeniedPage: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("[!] Not Viewable").font(.system(size: 13, weight: .semibold, design: .monospaced)).foregroundStyle(Color(red: 1, green: 0.69, blue: 0))
            Text("~/Projects/app/.env 属于凭据文件（.env、私钥、证书、令牌配置等），不在浏览器中打开。").font(.system(size: 14)).foregroundStyle(Color(red: 0.55, green: 0.54, blue: 0.52))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .overlay(Rectangle().strokeBorder(Color(red: 0.91, green: 0.9, blue: 0.87), lineWidth: 1))
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.black)
    }
}
#endif
