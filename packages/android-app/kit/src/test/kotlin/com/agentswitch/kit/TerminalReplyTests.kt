package com.agentswitch.kit

import com.agentswitch.kit.feed.SecretHint
import com.agentswitch.kit.feed.SlashCommand
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** terminal-v0 §1 second round: a reply typed directly is checked for secret-looking text first; `/` lists the agent's slash commands. */
class TerminalReplyTests {
    @Test
    fun testSecretShapesAreCaught() {
        for (text in listOf(
            "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "ghp_0123456789abcdefghijABCDEFGHIJ0123",
            "AKIAIOSFODNN7EXAMPLE", "密码是 hunter22", "password: s3cret!!", "api key = 12345678",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "-----BEGIN OPENSSH PRIVATE KEY-----", "用这个 Xq7vR2mK9pL4wN8tY3zB6cJ5hG1fD0sA 登录",
        )) {
            assertTrue(SecretHint.looksSecret(text), text)
        }
    }

    @Test
    fun testOrdinaryRepliesAreNot() {
        for (text in listOf(
            "ls -la ~/Downloads", "git log --oneline -5", "看一下 src/api/terminals.ts 里的 input 路由",
            "https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md", "3a122d62f58ea4e8199c2d0f799c0005dc30757f",
            "0e3e5e94-d0e2-4f5b-b869-85d7a3bb725b", "密码框在右上角", "the password field is empty", "y",
            "请用 enc:v1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo 登录",
        )) {
            assertFalse(SecretHint.looksSecret(text), text)
        }
    }

    @Test
    fun testSlashListsCommandsByPrefixThenByWord() {
        val commands = listOf(
            SlashCommand(name = "compact", description = ""), SlashCommand(name = "config", description = ""),
            SlashCommand(name = "frontend:lint", description = "", source = "project"), SlashCommand(name = "clear", description = ""),
        )
        assertEquals(listOf("compact", "config", "frontend:lint", "clear"), SlashCommand.matching("/", commands).map { it.name })
        assertEquals(listOf("compact", "config"), SlashCommand.matching("/co", commands).map { it.name })
        assertEquals(listOf("frontend:lint"), SlashCommand.matching("/lint", commands).map { it.name })
        assertEquals(emptyList(), SlashCommand.matching("/compact", commands), "a whole name needs no list")
        assertEquals(emptyList(), SlashCommand.matching("/compact now", commands), "arguments started")
        assertEquals(emptyList(), SlashCommand.matching("hello /co", commands))
    }
}
