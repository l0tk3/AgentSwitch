package com.agentswitch.android.widget

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals

/** How many channels a Channels widget shows at its size (ChannelsWidget.kt). */
class ChannelsRowsTest {
    @Test
    fun aNarrowWidgetShowsOneBigAWiderOneTheRowsThatFit() {
        assertEquals(0, channelsRows(DpSize(150.dp, 150.dp)))
        assertEquals(1, channelsRows(DpSize(300.dp, 60.dp)))
        assertEquals(2, channelsRows(DpSize(320.dp, 170.dp)))
        assertEquals(3, channelsRows(DpSize(320.dp, 200.dp)))
        assertEquals(5, channelsRows(DpSize(320.dp, 340.dp)))
        assertEquals(7, channelsRows(DpSize(320.dp, 420.dp)))
        assertEquals(8, channelsRows(DpSize(400.dp, 700.dp)))
    }
}
