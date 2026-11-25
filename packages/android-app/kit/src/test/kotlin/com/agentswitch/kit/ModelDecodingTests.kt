package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.support.KitJson
import kotlin.test.*

class ModelDecodingTests {
    /** The words on screen in Apple's title case (docs/ui-v0.md §7.2.7, 2026-10-01). */
    @Test
    fun statusWordsInTitleCase() {
        assertEquals(listOf("Busy", "Waiting", "Idle", "Exited"), listOf(TerminalStatus.Working, TerminalStatus.Waiting, TerminalStatus.Idle, TerminalStatus.Exited).map { it.label })
    }

    @Test
    fun meAcceptsIdOrDeviceId() {
        assertEquals("d1", KitJson.decodeFromString(Me.serializer(), """{"id":"d1","name":"iPhone"}""").deviceId)
        assertEquals("d2", KitJson.decodeFromString(Me.serializer(), """{"deviceId":"d2"}""").deviceId)
        assertNull(KitJson.decodeFromString(Me.serializer(), "{}").deviceId)
    }

    // Not in the Swift tests: the pieces of this slice the Swift cases only reach through the API.

    @Test
    fun modelNamesAndTheTableOfBrands() {
        assertEquals("Opus 5.5", com.agentswitch.kit.feed.ModelName.display("claude-opus-5-5"))
        assertEquals("Opus 5.5 1M", com.agentswitch.kit.feed.ModelName.display("claude-opus-5-5[1m]"))
        assertEquals("Sonnet 5", com.agentswitch.kit.feed.ModelName.display("claude-sonnet-5-20260101"))
        assertEquals("DeepSeek Flash", com.agentswitch.kit.feed.ModelName.display("deepseek/deepseek-flash"))
        assertEquals("GPT-6 Luna", com.agentswitch.kit.feed.ModelName.display("gpt-6-luna"))
        assertEquals("GPT-5.5", com.agentswitch.kit.feed.ModelName.display("gpt-5.5"))
        assertEquals("Claude Code", com.agentswitch.kit.feed.ModelName.harness("claude-code"))
    }
}
