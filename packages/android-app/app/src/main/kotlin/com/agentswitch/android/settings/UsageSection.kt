package com.agentswitch.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.design.CharMeter
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.kit.api.QuotaReading
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.Usage
import java.util.Calendar

/**
 * Settings › Usage (docs/ui-v0.md §4.2, §7.3), right under the Mac: one row per executor — its 5 × 5 pixel mark, the
 * name, then the 5h and 7d windows as character meters (OpenCode: its balance). Hidden until the Mac has answered once;
 * a failed re-read keeps the last numbers, and the footer says when they were read.
 */
@Composable
fun UsageSection(readings: List<QuotaReading>) {
    val rows = Usage.rows(readings)
    if (rows.isEmpty()) return
    val at = Usage.readAt(readings)
    FormSection("Usage", footer = at?.let { "读数更新于 ${time(it)}" }) {
        for ((i, row) in rows.withIndex()) UsageRowView(row, first = i == 0)
    }
}

/** "12:04" today, else "9月26日 12:04". */
fun time(ms: Long, now: Long = System.currentTimeMillis()): String {
    val d = Calendar.getInstance().apply { timeInMillis = ms }
    val n = Calendar.getInstance().apply { timeInMillis = now }
    val clock = "%02d:%02d".format(d.get(Calendar.HOUR_OF_DAY), d.get(Calendar.MINUTE))
    val today = d.get(Calendar.YEAR) == n.get(Calendar.YEAR) && d.get(Calendar.DAY_OF_YEAR) == n.get(Calendar.DAY_OF_YEAR)
    return if (today) clock else "${d.get(Calendar.MONTH) + 1}月${d.get(Calendar.DAY_OF_MONTH)}日 $clock"
}

@Composable
private fun UsageRowView(row: Usage.Row, first: Boolean) {
    FormRow(first = first, modifier = Modifier.semantics(mergeDescendants = true) { }) {
        // The executor's 5 × 5 pixel mark, flat, in the text colour; a plain square for anything else.
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            PixelSprite(PixelArt.agents[row.harness] ?: PixelArt.square, pixel = 3.dp, color = Theme.ink, strength = 1f, shadow = false, cell = 5.0 / 3)
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(row.title, color = Theme.ink, style = plain(15, FontWeight.Medium))
            if (row.showsBalance) {
                Text(row.balanceText, color = Theme.secondaryInk, style = mono(12))
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) { for (slot in row.slots) UsageSlotView(slot) }
            }
        }
    }
}

/** `5h ██░░░░░░ 20%`: the label and the percent keep fixed widths, so the meters of every row start and end in the same place. */
@Composable
private fun UsageSlotView(slot: Usage.Slot) {
    val spoken = slot.percent?.let { "${slot.spokenLabel}，已用 $it%" } ?: "${slot.spokenLabel}，无读数"
    Row(Modifier.clearAndSetSemantics { contentDescription = spoken }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(slot.label, Modifier.width(16.dp), color = Theme.secondaryInk, style = mono(11), maxLines = 1)
        CharMeter((slot.percent ?: 0) / 100.0, high = (slot.percent ?: 0) >= Usage.alertPercent, cells = 8)
        Text(slot.percentText, Modifier.width(30.dp), color = if (slot.percent == null) Theme.inkDim else Theme.ink, style = mono(11), textAlign = TextAlign.End, maxLines = 1)
    }
}
