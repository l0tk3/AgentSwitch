package com.agentswitch.android.terminals

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.PlanEntry
import com.agentswitch.kit.api.RecordItem
import com.agentswitch.kit.api.RecordUsage
import com.agentswitch.kit.api.SessionRecord
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.sessionRecord
import kotlinx.coroutines.CancellationException

/**
 * A session's record on the phone (docs/simple-view-v0.md §2, §4): the latest page, the earlier ones the user asked
 * for, the agent's own task list, how full its context is and the mode it last named. Read again when the Mac says
 * the record changed, and on a timer as a fallback (OpenCode, an older Mac). Main thread only.
 *
 * `demo`: what a page without a Mac shows (the iPhone's `DemoData.sessionRecord(harness:id:)` in a debug build); null
 * in the app, where a page without a Mac reads nothing.
 */
@Stable
class SessionRecordModel(private val demo: ((harness: String, id: String) -> SessionRecord)? = null) {
    var items: List<RecordItem> by mutableStateOf(emptyList())
        private set
    var plan: List<PlanEntry> by mutableStateOf(emptyList())
        private set
    var usage: RecordUsage? by mutableStateOf(null)
        private set
    var mode: String? by mutableStateOf(null)
        private set
    var session: SessionSummary? by mutableStateOf(null)
        private set

    /** There is more before what is shown. */
    var more: Boolean by mutableStateOf(false)
        private set

    /** Read at least once (an empty record is then really empty). */
    var loaded: Boolean by mutableStateOf(false)
        private set
    var loadingEarlier: Boolean by mutableStateOf(false)
        private set
    var error: String? by mutableStateOf(null)

    private var cursor: Long = 0
    private var harness = ""
    private var sessionId: String? = null
    private var reading = false
    private var again = false

    /**
     * Which session this is the record of. A terminal just started has none until its agent says; one that changes
     * (a `/clear`, a fork) starts the record over.
     */
    fun follow(harness: String, session: String?) {
        if (harness == this.harness && session == sessionId) return
        this.harness = harness
        sessionId = session
        items = emptyList()
        plan = emptyList()
        usage = null
        mode = null
        this.session = null
        more = false
        cursor = 0
        loaded = session == null
        error = null
    }

    val hasSession: Boolean get() = sessionId != null

    /** The latest page. Asked for again while one is on its way, it is read once more after that one. */
    suspend fun refresh(api: AgentSwitchAPI?) {
        val id = sessionId ?: return
        if (reading) { again = true; return }
        reading = true
        try {
            do {
                again = false
                if (api == null) {
                    demo?.let { take(it(harness, id)) }
                    return
                }
                try {
                    val page = api.sessionRecord(harness, id)
                    if (id != sessionId) return
                    take(page)
                    error = null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: APIError.Http) {
                    // Not listed yet (a session seconds old), or gone.
                    if (e.status == 404) loaded = true else if (!loaded) error = e.message
                } catch (e: Exception) {
                    if (!loaded) error = e.message ?: e.toString()
                }
            } while (again)
        } finally {
            reading = false
        }
    }

    /** The page before the earliest shown. */
    suspend fun earlier(api: AgentSwitchAPI?) {
        val id = sessionId
        if (api == null || id == null || !more || loadingEarlier) return
        loadingEarlier = true
        try {
            val page = api.sessionRecord(harness, id, limit = 80, before = cursor)
            if (id != sessionId) return
            val known = items.mapTo(HashSet()) { it.id }
            items = page.items.filter { it.id !in known } + items
            cursor = page.cursor
            more = page.more
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        } finally {
            loadingEarlier = false
        }
    }

    /**
     * The latest page over what is held: earlier pages stay, the page's own stretch is replaced (its last run of work
     * may have grown, a queued message may have been read).
     */
    private fun take(page: SessionRecord) {
        session = page.session
        plan = page.plan
        usage = page.usage
        mode = page.mode
        try {
            val first = page.items.firstOrNull()?.offset
            val earliest = items.firstOrNull()?.offset
            val last = items.lastOrNull { it.offset != null }?.offset
            if (first == null || earliest == null || earliest >= first || last == null || last < first) {
                // Nothing earlier held (or a gap, or a record without places in a file): the page is the record.
                items = page.items
                cursor = page.cursor
                more = page.more
                return
            }
            items = items.filter { (it.offset ?: Long.MAX_VALUE) < first } + page.items
        } finally {
            loaded = true
        }
    }
}
