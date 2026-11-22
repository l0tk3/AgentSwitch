package com.agentswitch.kit

import com.agentswitch.kit.api.QuotaReading
import com.agentswitch.kit.feed.Usage
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 设置 › 用量 (docs/ui-v0.md §4.2): `GET /quota` as rows. */
class UsageTests {
    /** A real `GET /quota` answer (2026-09-27), in the daemon's order. */
    private val real = """
        [{"harness":"codex","fetchedAt":1790482051141,"remaining":0.92,"detail":{"planType":"pro","windows":[{"label":"7d","usedPercent":8,"resetsAt":1791053972}],"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},"rateLimitReachedType":null},"source":"codex app-server account/rateLimits/read","error":null},
         {"harness":"opencode","fetchedAt":1790482049570,"remaining":1,"detail":{"is_available":true,"balances":[{"currency":"CNY","total":"96.23","granted":"0.00","topped_up":"96.23"}]},"source":"deepseek /user/balance","error":null},
         {"harness":"claude-code","fetchedAt":1790482049405,"remaining":0.18,"detail":{"windows":[{"label":"5h","usedPercent":20,"resetsAt":1790496600},{"label":"7d","usedPercent":82,"resetsAt":1790485200},{"label":"7d opus","usedPercent":40,"resetsAt":1790485200}],"windowsAgeMs":155743},"source":"claude rate_limit_event (subscription windows)","error":null}]
    """.trimIndent()

    private val fetched = 1790482051_000L   // Date(timeIntervalSince1970: 1790482051)

    private fun readings(text: String = real): List<QuotaReading> = KitJson.decodeFromString(ListSerializer(QuotaReading.serializer()), text)

    @Test
    fun testRealReadingBecomesThreeRowsInOrder() {
        val rows = Usage.rows(readings(), now = fetched)
        assertEquals(listOf("claude-code", "codex", "opencode"), rows.map { it.harness })
        assertEquals(listOf("Claude Code", "Codex · Pro", "OpenCode"), rows.map { it.title })

        val claude = rows[0]
        assertEquals(listOf("5h", "7d"), claude.slots.map { it.label }, "extra windows such as 7d opus are left out")
        assertEquals(listOf<Int?>(20, 82), claude.slots.map { it.percent })
        assertEquals(listOf("20%", "82%"), claude.slots.map { it.percentText })
        assertEquals(1790496600_000L, claude.slots[0].resetsAt)
        assertNull(claude.balance)
        assertFalse(claude.showsBalance)

        val codex = rows[1]
        assertEquals(listOf("5h", "7d"), codex.slots.map { it.label }, "both slots even without a 5h window")
        assertEquals(listOf<Int?>(null, 8), codex.slots.map { it.percent })
        assertEquals(listOf("—", "8%"), codex.slots.map { it.percentText })
        assertNull(codex.slots[0].resetsAt)

        val opencode = rows[2]
        assertTrue(opencode.slots.isEmpty())
        assertTrue(opencode.showsBalance)
        assertEquals("¥96.23", opencode.balance)
        assertEquals("Balance ¥96.23", opencode.balanceText)
    }

    @Test
    fun testWindowWhoseResetHasPassedHasNoReading() {
        val later = (1790485200L + 1) * 1000   // Claude's 7d window reset one second ago
        val claude = Usage.rows(readings(), now = later).first()
        assertEquals(listOf<Int?>(20, null), claude.slots.map { it.percent })
        assertNull(claude.slots[1].resetsAt)
        assertEquals("—", claude.slots[1].percentText)
    }

    @Test
    fun testFailedReadingShowsDashes() {
        val failed = readings("""
            [{"harness":"claude-code","remaining":null,"detail":{},"source":"local count","fetchedAt":1790000000000,"error":"quota timed out after 10000 ms"},
             {"harness":"codex","remaining":null,"detail":null,"source":"codex app-server","fetchedAt":1790000000000,"error":"spawn codex ENOENT"},
             {"harness":"opencode","remaining":null,"detail":{},"source":"deepseek","fetchedAt":1790000000000,"error":"no key"}]
        """.trimIndent())
        val rows = Usage.rows(failed, now = fetched)
        assertEquals(listOf("Claude Code", "Codex", "OpenCode"), rows.map { it.title }, "no plan without a reading")
        assertEquals(listOf("—", "—"), rows[0].slots.map { it.percentText })
        assertEquals(listOf("—", "—"), rows[1].slots.map { it.percentText })
        assertNull(rows[2].balance)
        assertEquals("Balance —", rows[2].balanceText)
    }

    @Test
    fun testOnlyKnownExecutorsThatAnswered() {
        val some = readings("""
            [{"harness":"echo","remaining":1,"detail":{},"source":"none","fetchedAt":1790000000000,"error":null},
             {"harness":"codex","remaining":1,"detail":{"planType":"plus","windows":[{"label":"5h","usedPercent":3,"resetsAt":null}]},"source":"x","fetchedAt":1790000000000,"error":null}]
        """.trimIndent())
        val rows = Usage.rows(some, now = fetched)
        assertEquals(listOf("Codex · Plus"), rows.map { it.title })
        assertEquals(listOf<Int?>(3, null), rows[0].slots.map { it.percent }, "a window without a reset time keeps its reading")
        assertTrue(Usage.rows(emptyList(), now = fetched).isEmpty())
    }

    @Test
    fun testPercentIsRoundedAndClampedAndHighFromNinety() {
        val values = readings("""
            [{"harness":"claude-code","remaining":0,"detail":{"windows":[{"label":"5h","usedPercent":89.6,"resetsAt":null},{"label":"7d","usedPercent":130,"resetsAt":null}]},"source":"x","fetchedAt":1790000000000,"error":null},
             {"harness":"codex","remaining":1,"detail":{"windows":[{"label":"5h","usedPercent":-4,"resetsAt":null},{"label":"7d","usedPercent":89.4,"resetsAt":null}]},"source":"x","fetchedAt":1790000000000,"error":null}]
        """.trimIndent())
        val rows = Usage.rows(values, now = fetched)
        assertEquals(listOf<Int?>(90, 100), rows[0].slots.map { it.percent })
        assertEquals(listOf(true, true), rows[0].slots.map { it.isHigh })
        assertEquals(listOf<Int?>(0, 89), rows[1].slots.map { it.percent })
        assertEquals(listOf(false, false), rows[1].slots.map { it.isHigh })
    }

    @Test
    fun testBalancesByCurrency() {
        val money = readings("""
            [{"harness":"opencode","remaining":1,"detail":{"balances":[{"currency":"USD","total":"5"},{"currency":"CNY","total":"0.5"},{"currency":"EUR","total":"2.10"}]},"source":"x","fetchedAt":1790000000000,"error":null}]
        """.trimIndent())
        assertEquals("$5.00 · ¥0.50 · 2.10 EUR", Usage.rows(money, now = fetched).firstOrNull()?.balance)
    }

    @Test
    fun testReadAtIsTheOldestReadingShown() {
        assertEquals(1790482049405L, Usage.readAt(readings()))
        assertNull(Usage.readAt(emptyList()))
    }

    @Test
    fun testSpokenLabels() {
        val claude = Usage.rows(readings(), now = fetched).first()
        assertEquals(listOf("5 小时", "7 天"), claude.slots.map { it.spokenLabel })
    }
}
