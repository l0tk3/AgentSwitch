package com.agentswitch.android.browser

import com.agentswitch.android.AppModel
import com.agentswitch.android.MainTab
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.openBrowserTab
import com.agentswitch.kit.feed.LinkAction
import com.agentswitch.kit.feed.LinkOpening
import com.agentswitch.kit.feed.TappedLink
import kotlinx.coroutines.CancellationException

// A link on the phone opens in the Mac's shared browser (docs/browser-v0.md §1 入口, terminal-v0 §1 链接;
// 2026-10-03, user: 手机上现在点击和复制链接还是费劲，修复一下交互；修复好之后想办法让手机可以方便的点击链接，点击之后直接在
// agent switch浏览器中打开): a tap opens it there, a long press offers that, copying it, and the phone's own browser.
// What a link is, its menu and what happens without the Mac's browser are the kit's (`TappedLink`, `LinkAction`,
// `LinkOpening`); here they are carried out.
//
// The page comes up over where the link was, and `Done` goes back there (2026-10-05, user, of a tap that took the
// phone to the Browser tab: 我得返回到浏览器主页面再回来🤔 有没有更方便的符合规范的跳转方法): a page to look at and come
// back from is a modal one, as a link's page is in every app that shows it in the system browser's view with `Done`.
// The tab bar is the user's: nothing here changes tabs by itself.
//
// Cut: `LinkMenuItems` (the menu a long press opens, built from `Markdown.links`), `LinkedPage` (the page over where
// the link was) and the view extensions are the screens'. The Swift's `UIApplication.open` (Safari) and `UIPasteboard`
// are parameters here: `openExternal` gets the address to open in the phone's own browser, `copy` gets the text.

/**
 * Opens `link` in the Mac's browser — a new tab of yours — and shows it over where you are (`linkedPage`); on the
 * Browser tab itself, as that tab's page (`openBrowserRequest`). `alternates`: other readings of a path that may run
 * over a line's end, tried in turn while the Mac says the one before is not there. Returns what to say when it did not
 * open there (null: it did): without the Mac's browser a web address the phone can reach opens in the phone's own
 * browser through `openExternal`.
 */
suspend fun AppModel.open(link: TappedLink, alternates: List<TappedLink> = emptyList(), openExternal: ((String) -> Unit)? = null): String? {
    var failure: LinkOpening.Failure = LinkOpening.Failure.NotConnected
    val api = browserAPI
    if (api != null && !browser.unsupported) {
        var first: LinkOpening.Failure? = null
        for (candidate in listOf(link) + alternates) {
            try {
                val tab = api.openBrowserTab(candidate.target)
                browser.add(tab)
                if (this.tab == MainTab.Browser) openBrowserRequest = tab.id else linkedPage = tab
                return null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (first == null) first = LinkOpening.failure(e, candidate)
                // Another reading only of a path that is not there; any other answer is the answer.
                if (!(candidate is TappedLink.File && e is APIError.Http && e.status == 404)) break
            }
        }
        failure = first ?: LinkOpening.Failure.NoBrowser
    } else if (api != null) {
        failure = LinkOpening.Failure.NoBrowser
    }
    val fallback = LinkOpening.fallback(link, failure)
    fallback.safari?.let { openExternal?.invoke(it) }
    return fallback.said
}

/**
 * One of a link's actions (its menu): what to say afterwards, if anything — a failure's reason, or that it was
 * copied. `copy` puts text on the clipboard (the Swift's `UIPasteboard`), `openExternal` opens an address in the phone's
 * own browser (the Swift's Safari).
 */
suspend fun AppModel.perform(
    action: LinkAction,
    link: TappedLink,
    alternates: List<TappedLink> = emptyList(),
    copy: (String) -> Unit,
    openExternal: (String) -> Unit,
): String? = when (action) {
    LinkAction.OpenInBrowser -> open(link, alternates, openExternal)
    LinkAction.Copy -> {
        copy(link.text)
        LinkAction.copied(link)
    }
    LinkAction.OpenInSafari -> {
        link.safari?.let(openExternal)
        null
    }
    // Where the tab bar shows (Dispatch, a task, a transcript's text): the Files tab, at the path's folder.
    LinkAction.ShowInFiles -> {
        if (link is TappedLink.File) showInFiles(link.path)
        null
    }
}
