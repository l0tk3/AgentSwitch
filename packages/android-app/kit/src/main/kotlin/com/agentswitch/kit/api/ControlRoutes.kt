package com.agentswitch.kit.api

import com.agentswitch.kit.feed.SessionHit
import com.agentswitch.kit.feed.SessionHits
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.Serializable

/**
 * control-v0's routes: the permission mode and default folder (read-only on the phone), the Mac's coding sessions,
 * marking a task read, and search.
 */
suspend fun AgentSwitchAPI.approvalPolicy(): ApprovalPolicyInfo = get(listOf("approvals", "policy"), ApprovalPolicyInfo.serializer())

suspend fun AgentSwitchAPI.workdir(): WorkdirSetting = get(listOf("settings", "workdir"), WorkdirSetting.serializer())

/** Claude Code, Codex and OpenCode sessions on the Mac, newest first. */
suspend fun AgentSwitchAPI.sessions(limit: Int = 60): List<SessionSummary> =
    get(listOf("sessions"), SessionList.serializer(), query = listOf(URLQueryItem("limit", limit.toString()))).sessions

/**
 * Sessions whose words (prompts and replies) contain `query` (docs/terminal-v0.md §1 搜索); none from a Mac that
 * cannot search them.
 */
suspend fun AgentSwitchAPI.searchSessions(query: String): List<SessionHit> =
    try {
        get(listOf("sessions", "search"), SessionHits.serializer(), query = listOf(URLQueryItem("q", query))).hits
    } catch (e: APIError.Http) {
        if (e.status == 404) emptyList() else throw e
    }

/** One session and its latest `limit` messages. */
suspend fun AgentSwitchAPI.session(harness: String, id: String, limit: Int = 80): SessionDetail =
    get(listOf("sessions", harness, id), SessionDetail.serializer(), query = listOf(URLQueryItem("limit", limit.toString())))

/**
 * A session's record for the simple view (docs/simple-view-v0.md §4): the last `limit` items, or the ones before
 * a page's `cursor`. A Mac from before this route gives the session's messages instead: the same record, coarser
 * (one line per tool, no changes, no plan).
 */
suspend fun AgentSwitchAPI.sessionRecord(harness: String, id: String, limit: Int = 60, before: Long? = null): SessionRecord {
    val query = mutableListOf(URLQueryItem("limit", limit.toString()))
    if (before != null) query.add(URLQueryItem("before", before.toString()))
    return try {
        get(listOf("sessions", harness, id, "record"), SessionRecord.serializer(), query = query)
    } catch (e: APIError.Http) {
        if (e.status == 404 && before == null) SessionRecord.coarse(session(harness, id, limit = 200)) else throw e
    }
}

/**
 * What a session changed, file by file: in one run of work (`work`, the item's id), else in its last turn. None
 * when the Mac has no changes for it (an agent read coarsely, an older Mac).
 */
suspend fun AgentSwitchAPI.sessionChanges(harness: String, id: String, work: String? = null): List<FileDiff> =
    try {
        get(listOf("sessions", harness, id, "changes"), FileDiffList.serializer(),
            query = work?.let { listOf(URLQueryItem("work", it)) } ?: emptyList()).files
    } catch (e: APIError.Http) {
        if (e.status == 404) emptyList() else throw e
    }

/**
 * Deletes a session's record on the Mac (terminal-v0 §5): refused while it is open anywhere (409); OpenCode's
 * cannot be deleted there yet (400).
 */
suspend fun AgentSwitchAPI.deleteSession(harness: String, id: String) {
    perform("DELETE", listOf("sessions", harness, id), emptyList(), null, OKReply.serializer())
}

@Serializable
internal class DeleteSessionOne(val harness: String, val id: String)

@Serializable
internal class DeleteSessionsBody(val sessions: List<DeleteSessionOne>)

/**
 * Deletes several sessions' records at once, each by the same rules; one in use is left and said so. A Mac whose
 * service has no such route yet (404) is asked for each in turn.
 */
suspend fun AgentSwitchAPI.deleteSessions(sessions: List<SessionSummary>): SessionsRemoval =
    try {
        post(listOf("sessions", "delete"), DeleteSessionsBody(sessions.map { DeleteSessionOne(it.harness, it.sessionId) }),
            DeleteSessionsBody.serializer(), SessionsRemoval.serializer())
    } catch (e: APIError.Http) {
        if (e.status != 404) throw e
        val results = mutableListOf<SessionsRemoval.One>()
        for (session in sessions) {
            var failure: Throwable? = null
            try {
                deleteSession(session.harness, session.sessionId)
            } catch (c: CancellationException) {
                throw c
            } catch (f: Exception) {
                failure = f
            }
            results.add(SessionsRemoval.One(session.harness, session.sessionId, SessionsRemoval.outcome(failure), failure?.let { it.message ?: it.toString() }))
        }
        SessionsRemoval(results)
    }

/** Records the task as read now; returns the time the Mac recorded, when it says. */
suspend fun AgentSwitchAPI.acknowledge(taskId: String): Long? =
    post(listOf("tasks", taskId, "ack"), EmptyBody(), EmptyBody.serializer(), AckReply.serializer()).acknowledgedAt

suspend fun AgentSwitchAPI.search(query: String, limit: Int = 30): List<SearchResult> =
    get(listOf("search"), SearchResults.serializer(),
        query = listOf(URLQueryItem("q", query), URLQueryItem("limit", limit.toString()))).results
