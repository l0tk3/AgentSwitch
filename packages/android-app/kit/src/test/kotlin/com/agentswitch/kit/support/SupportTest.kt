package com.agentswitch.kit.support

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SupportTest {
    @Test
    fun base64URLRoundTripsWithoutPaddingAndRefusesOtherAlphabets() {
        val bytes = byteArrayOf(0xfb.toByte(), 0xff.toByte(), 0x00, 0x10)
        assertEquals("-_8AEA", Base64URL.encode(bytes))
        assertContentEquals(bytes, Base64URL.decode("-_8AEA"))
        assertContentEquals(bytes, Base64URL.decode("-_8AEA=="))
        assertNull(Base64URL.decode("+/8AEA"))
        assertNull(Base64URL.decode("-_8AEA="))
        assertNull(Base64URL.decode("-_8AEA==="))
        assertNull(Base64URL.decode("abcde"))
        assertContentEquals(ByteArray(0), Base64URL.decode(""))
        assertEquals("00ff10", byteArrayOf(0, 0xff.toByte(), 0x10).hexString)
    }

    @Test
    fun jsonValueReadsAnyJSONAndWritesItCompactWithSortedKeys() {
        val value = KitJson.decodeFromString(JSONValue.serializer(), """{"b":[1,2.5,"x",null,true],"a":{"n":3,"path":"a/b"}}""")
        assertEquals(3, value["a"]?.get("n")?.int)
        assertEquals(2.5, value["b"]?.array?.get(1)?.number)
        assertNull(value["b"]?.array?.get(1)?.int)
        assertTrue(value["b"]?.array?.get(3)?.isNull == true)
        assertEquals(true, value["b"]?.array?.get(4)?.bool)
        assertEquals("""{"a":{"n":3,"path":"a/b"},"b":[1,2.5,"x",null,true]}""", value.compactText)
        assertEquals(value, KitJson.decodeFromString(JSONValue.serializer(), KitJson.encodeToString(JSONValue.serializer(), value)))
        assertEquals(1794333454772L, JSONValue.Number(1794333454772.0).long)
        assertNull(JSONValue.Number(1794333454772.0).int)
    }

    @Test
    fun pathsReadWithTheHomeFolderAsATilde() {
        assertEquals("~/Projects/AgentSwitch", PathDisplay.short("/Users/me/Projects/AgentSwitch"))
        assertEquals("~", PathDisplay.short("/Users/me"))
        assertEquals("/Users/Shared/x", PathDisplay.short("/Users/Shared/x"))
        assertEquals("/opt/x", PathDisplay.short("/opt/x"))
        assertEquals("AgentSwitch", PathDisplay.name("/Users/me/Projects/AgentSwitch"))
        assertEquals("~", PathDisplay.name("/Users/me"))
    }
}
