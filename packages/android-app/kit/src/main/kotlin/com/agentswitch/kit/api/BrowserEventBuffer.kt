package com.agentswitch.kit.api

import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Between a tab's connection and its page (docs/browser-v0.md §1 画面流): every change in order, but only the newest
 * frame — a frame still waiting to be read when a newer one comes is dropped, so a page that draws slowly shows the
 * Mac's latest picture instead of working through old ones and nothing piles up — and at most `limit` events waiting
 * in all (the oldest go). One reader.
 *
 * A reader that is cancelled gets Kotlin's `CancellationException` from [next] (Swift's returns nil); [whenCancelled]
 * and [cancel] work as there.
 */
internal class BrowserEventBuffer(limit: Int = defaultLimit) {
    private val lock = Any()
    private val limit: Int = maxOf(limit, 2)
    private val waiting = ArrayDeque<BrowserEvent>()
    private var reader: CancellableContinuation<BrowserEvent?>? = null

    /** How it ended (null while open); an error is thrown once, after what was still waiting. */
    private var end: Result<Unit>? = null
    private var onCancel: (() -> Unit)? = null
    private var cancelled = false

    companion object {
        const val defaultLimit = 64
    }

    /** What the connection brought. */
    fun push(event: BrowserEvent) {
        val waiter: CancellableContinuation<BrowserEvent?>
        synchronized(lock) {
            if (end != null) return
            val r = reader
            if (r == null) {
                if (event is BrowserEvent.Frame) waiting.removeAll { it is BrowserEvent.Frame }
                waiting.addLast(event)
                while (waiting.size > limit) waiting.removeFirst()
                return
            }
            reader = null
            waiter = r
        }
        waiter.resume(event)
    }

    /** No more events: the reader gets what is waiting, then the end (or `error`). */
    fun finish(error: Throwable? = null) {
        val waiter: CancellableContinuation<BrowserEvent?>?
        synchronized(lock) {
            if (end != null) return
            end = if (error != null) Result.failure(error) else Result.success(Unit)
            waiter = reader
            reader = null
            if (waiter != null) end = Result.success(Unit)
        }
        // A reader waits only when nothing is waiting.
        if (waiter != null) {
            if (error != null) waiter.resumeWithException(error) else waiter.resume(null)
        }
    }

    /** The next event; null at the end (Kotlin: cancelling the reader throws `CancellationException`, `onCancel` runs). */
    suspend fun next(): BrowserEvent? = suspendCancellableCoroutine { c ->
        c.invokeOnCancellation { cancel() }
        var event: BrowserEvent? = null
        var finished: Result<Unit>? = null
        synchronized(lock) {
            if (waiting.isNotEmpty()) {
                event = waiting.removeFirst()
            } else if (end != null) {
                finished = end
                end = Result.success(Unit)
            } else {
                reader = c
                return@suspendCancellableCoroutine
            }
        }
        val e = event
        val f = finished
        when {
            e != null -> c.resume(e)
            f != null -> f.fold({ c.resume(null) }, { c.resumeWithException(it) })
        }
    }

    /** Runs once the reader goes away (cancelled); at once if it already has. */
    fun whenCancelled(action: () -> Unit) {
        synchronized(lock) {
            if (!cancelled) {
                onCancel = action
                return
            }
        }
        action()
    }

    /** The reader went away: nothing more is kept; the producer is told. */
    fun cancel() {
        val waiter: CancellableContinuation<BrowserEvent?>?
        val action: (() -> Unit)?
        synchronized(lock) {
            cancelled = true
            waiter = reader
            reader = null
            action = onCancel
            onCancel = null
            if (end == null) end = Result.success(Unit)
            waiting.clear()
        }
        waiter?.resume(null)
        action?.invoke()
    }

    /** Tests: how many events wait. */
    val count: Int get() = synchronized(lock) { waiting.size }
}
