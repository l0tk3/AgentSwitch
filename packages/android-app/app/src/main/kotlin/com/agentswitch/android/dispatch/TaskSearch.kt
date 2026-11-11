package com.agentswitch.android.dispatch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.agentswitch.android.AppModel
import com.agentswitch.android.LocalNav
import com.agentswitch.android.components.StatusMark
import com.agentswitch.android.components.taskColor
import com.agentswitch.android.design.BrailleSpinner
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.android.terminals.relativeTime
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.SearchResult
import com.agentswitch.kit.api.search
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.feed.SearchSnippet
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * Search in 任务记录 (control-v0 §4): the Mac searches the whole history (task text, results, errors, summaries,
 * session titles, what the executors wrote). A Mac without `/search` (404), and the demo screens, search the tasks the
 * phone already has instead.
 */
@Stable
class TaskSearch {
    var results: List<SearchResult> by mutableStateOf(emptyList())
        private set
    var searching: Boolean by mutableStateOf(false)
        private set
    var error: String? by mutableStateOf(null)
        private set

    /** The results came from the phone's own list, not the Mac. */
    var local: Boolean by mutableStateOf(false)
        private set
    private var ran = ""

    fun isActive(query: String) = trimmed(query).isNotEmpty()

    /** Called on every change of the field (a `LaunchedEffect(query)` cancels the previous run, which is the debounce). */
    suspend fun run(query: String, model: AppModel) {
        val q = trimmed(query)
        if (q.isEmpty()) {
            results = emptyList(); error = null; searching = false; ran = ""
            return
        }
        if (q == ran) return
        searching = true
        try {
            delay(DEBOUNCE_MS)
            val api = model.api
            if (api == null) { show(SearchSnippet.local(model.dispatch.tasks, q), q, true); return }
            try {
                show(api.search(q), q, false)
            } catch (e: APIError.Http) {
                if (e.status == 404) show(SearchSnippet.local(model.dispatch.tasks, q), q, true)
                else { model.handle(e); error = e.message }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                model.handle(e)
                error = e.message ?: e.javaClass.simpleName
            }
        } finally {
            searching = false
        }
    }

    private fun show(found: List<SearchResult>, query: String, local: Boolean) {
        results = found; error = null; ran = query; this.local = local
    }

    private fun trimmed(query: String) = query.trim()

    companion object { const val DEBOUNCE_MS = 300L }
}

/** The hits, newest first as the Mac returns them: title, the snippet with the matches in bold, state and time. */
@Composable
fun TaskSearchResults(search: TaskSearch) {
    val nav = LocalNav.current
    val error = search.error
    if (error != null) {
        Text(error, Modifier.padding(top = 14.dp), color = Theme.failed, style = plain(13))
    } else if (search.results.isEmpty()) {
        if (search.searching) Box(Modifier.fillMaxWidth().padding(top = 24.dp), contentAlignment = Alignment.Center) { BrailleSpinner(color = Theme.secondaryInk) }
        else Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { Text("无结果", color = Theme.secondaryInk, style = plain(17)) }
    } else {
        FormSection(footer = if (search.local) "此 Mac 不支持搜索全部记录，仅搜索手机上已加载的任务。" else null) {
            search.results.forEachIndexed { i, result ->
                FormRow(first = i == 0, onClick = { nav.push("task:${result.taskId}") { TaskDetailView(result.taskId) } }) {
                    SearchResultRow(result, Modifier.weight(1f))
                    LookGlyph("›", LookSymbol.ChevronRight, color = Theme.inkDim, size = 13)
                }
            }
        }
    }
}

@Composable
private fun SearchResultRow(result: SearchResult, modifier: Modifier = Modifier) {
    Column(modifier.padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusMark(result.status)
            Text(lookWord(result.status.label), color = taskColor(result.status), style = mono(11, FontWeight.Medium))
            Box(Modifier.weight(1f))
            Text(relativeTime(result.updated), color = Theme.secondaryInk, style = mono(11))
        }
        Text(MessageDisplay.readable(result.title), color = Theme.ink, style = plain(15, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (result.snippet.isNotEmpty()) {
            Text(highlighted(result.snippet, Theme.ink), color = Theme.secondaryInk, style = plain(13), maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The ⟦⟧ marks dropped, what they enclosed in bold and in the primary colour. */
private fun highlighted(snippet: String, ink: androidx.compose.ui.graphics.Color): AnnotatedString = buildAnnotatedString {
    for (part in SearchSnippet.parts(snippet)) {
        if (part.hit) withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = ink)) { append(part.text) } else append(part.text)
    }
}
