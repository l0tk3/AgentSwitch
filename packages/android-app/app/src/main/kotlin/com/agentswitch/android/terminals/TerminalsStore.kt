package com.agentswitch.android.terminals

import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.GitSummary
import com.agentswitch.kit.api.ProfileChoices
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TerminalInfo
import com.agentswitch.kit.api.TerminalList
import com.agentswitch.kit.api.TerminalStyle
import com.agentswitch.kit.api.folderGit
import com.agentswitch.kit.api.profiles
import com.agentswitch.kit.api.sessions
import com.agentswitch.kit.api.terminalStyle
import com.agentswitch.kit.api.terminals
import com.agentswitch.kit.feed.TerminalTree
import com.agentswitch.kit.feed.waitsForYou
import kotlinx.coroutines.CancellationException

/**
 * The terminals tab's data (docs/terminal-v0.md §1): the Mac's terminals, the agents it can start and their models,
 * the Mac's other coding sessions, and the Mac's terminal colours. The list is read again from every tab
 * (AppModel.refreshTerminals: the badge, the cue, the notifications), the sessions while the tab is on screen; the
 * page of one terminal follows its own stream.
 */
@Stable
class TerminalsStore {
    var list: TerminalList? by mutableStateOf(null)
        private set
    var profiles: Map<String, ProfileChoices> by mutableStateOf(emptyMap())
        private set
    var sessions: List<SessionSummary> by mutableStateOf(emptyList())
        private set

    /** The folders' git, after their names in the tree. */
    var git: Map<String, GitSummary> by mutableStateOf(emptyMap())
        private set
    var style: TerminalStyle? by mutableStateOf(null)
        private set

    /** The last read failed (kept list shown); cleared by the next good one. */
    var error: String? by mutableStateOf(null)

    /** Bumped by `reset` (another Mac): a read that started before it is dropped. */
    private var generation = 0

    val terminals: List<TerminalInfo> get() = list?.terminals ?: emptyList()
    val folders: List<TerminalTree.Folder> by derivedStateOf { TerminalTree.build(terminals, sessions, git) }

    /** Terminals waiting for an answer: the tab's badge. */
    val waiting: Int get() = terminals.count { it.waitsForYou }

    /** Folders used before, newest first, for the new-terminal sheet. */
    val recentFolders: List<String>
        get() {
            val seen = HashSet<String>()
            val byTime = terminals.map { it.cwd to it.lastOutputAt } + sessions.map { it.cwd to it.updatedAt }
            return byTime.sortedByDescending { it.second }.map { it.first }.filter { it.isNotEmpty() && seen.add(it) }.take(8)
        }

    suspend fun refreshList(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        try {
            val fresh = api.terminals()
            if (asked != generation) return
            list = fresh
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (asked == generation) error = e.message ?: e.javaClass.simpleName
        }
        if (style == null) quiet { api.terminalStyle() }?.let { if (asked == generation) style = it }
    }

    /** The Mac's other sessions; a failed read keeps the last ones. */
    suspend fun refreshSessions(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        quiet { api.sessions(limit = everySession) }?.let { if (asked == generation) sessions = it }
        refreshProfiles(api)
    }

    /**
     * Each agent's profiles (docs/profiles-v0.md §3.3): what the new-terminal sheet and `Resume As` choose between.
     * A failed read keeps the last.
     */
    suspend fun refreshProfiles(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        quiet { api.profiles() }?.let { if (asked == generation && it != profiles) profiles = it }
    }

    /** The folders' git; a failed read keeps the last. */
    suspend fun refreshGit(api: AgentSwitchAPI?) {
        if (api == null) return
        val asked = generation
        quiet { api.folderGit() }?.let { if (asked == generation && it != git) git = it }
    }

    /** Another Mac (or none): nothing of this one's stays. */
    fun reset() {
        generation += 1
        list = null
        sessions = emptyList()
        git = emptyMap()
        style = null
        error = null
    }

    /** A terminal just started or resumed: listed at once, before the next read. */
    fun add(terminal: TerminalInfo) {
        val list = list ?: return
        if (list.terminals.any { it.id == terminal.id }) return
        this.list = list.copy(terminals = listOf(terminal) + list.terminals)
    }

    fun remove(id: String) {
        val list = list ?: return
        this.list = list.copy(terminals = list.terminals.filter { it.id != id })
    }

    /** The sample screens' data (a debug build's `uiDemo`). */
    fun setDemo(list: TerminalList, sessions: List<SessionSummary>, git: Map<String, GitSummary> = emptyMap(), profiles: Map<String, ProfileChoices> = emptyMap()) {
        this.list = list
        this.sessions = sessions
        this.git = git
        this.profiles = profiles
    }

    private suspend fun <T> quiet(body: suspend () -> T): T? =
        try { body() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }

    companion object {
        /**
         * More sessions than any Mac lists (each agent's newest 400 records): every one, so each folder shows whole
         * (2026-10-03, user: 有的目录下面的session显示不完全); an older Mac stops at its own maximum, 500.
         */
        const val everySession = 100_000

        /** How often the list is read again, from every tab. */
        const val pollIntervalMs = 4_000L
    }
}
