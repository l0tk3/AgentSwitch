package com.agentswitch.android.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.agentswitch.android.AgentSwitchApp
import com.agentswitch.android.design.AgentSwitchTheme
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.FormPage
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain
import com.agentswitch.android.settings.ChoiceMark
import com.agentswitch.kit.widget.ChannelsSnapshot.Choice

/**
 * Setting up one Channels widget (the launcher's "reconfigure", or right after it is placed where the launcher asks):
 * which channels it shows — all, the one spoken in last first; only those that want the user; or those picked, in
 * the order picked. The iPhone's widget intent (`ChannelsIntent`).
 */
class ChannelsSetupActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val widget = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // Left without `Done`: the launcher keeps a new widget only on OK (with the default set-up) — and a widget
        // set up before keeps its own.
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widget))
        if (widget == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        enableEdgeToEdge(SystemBarStyle.auto(0, 0), SystemBarStyle.auto(0, 0))
        val settings = (application as AgentSwitchApp).settings
        val channels = ChannelsFeed.read(this)?.channels ?: emptyList()
        setContent {
            AgentSwitchTheme(settings.look) {
                var choice by remember { mutableStateOf(ChannelsFeed.choice(this, widget)) }
                val chosen = remember { mutableStateListOf<String>().apply { addAll(ChannelsFeed.chosen(this@ChannelsSetupActivity, widget)) } }
                FormPage(
                    "Channels",
                    leading = { BarWord("Cancel", onClick = { finish() }) },
                    trailing = {
                        BarWord("Done", onClick = {
                            ChannelsFeed.setUp(this@ChannelsSetupActivity, widget, choice, chosen.toList())
                            ChannelsFeed.redraw(this@ChannelsSetupActivity)
                            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widget))
                            finish()
                        }, color = Theme.signal)
                    },
                ) {
                    FormSection("Show") {
                        for ((i, c) in Choice.entries.withIndex()) {
                            FormRow(first = i == 0, onClick = { choice = c }) {
                                Text(words(c), Modifier.weight(1f), color = Theme.ink, style = plain(16))
                                ChoiceMark(on = choice == c, box = false)
                            }
                        }
                    }
                    if (choice == Choice.Chosen) {
                        FormSection("Channels") {
                            if (channels.isEmpty()) {
                                FormRow(first = true) { Text("Open AgentSwitch", color = Theme.secondaryInk, style = plain(16)) }
                            }
                            for ((i, ch) in channels.withIndex()) {
                                val on = ch.id in chosen
                                FormRow(first = i == 0, onClick = { if (on) chosen.remove(ch.id) else chosen.add(ch.id) }) {
                                    Text(ch.name, Modifier.weight(1f), color = Theme.ink, style = plain(16), maxLines = 1)
                                    if (on) Text("${chosen.indexOf(ch.id) + 1}", color = Theme.secondaryInk, style = plain(13))
                                    ChoiceMark(on = on, box = true)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun words(c: Choice): String = when (c) {
        Choice.Recent -> "All, Most Recent First"
        Choice.Mentions -> "Only Mentions"
        Choice.Chosen -> "Chosen Channels"
    }
}
