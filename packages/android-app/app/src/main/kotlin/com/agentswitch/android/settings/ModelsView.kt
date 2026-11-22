package com.agentswitch.android.settings

import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.components.ErrorText
import com.agentswitch.android.design.BarBack
import com.agentswitch.android.design.FormRow
import com.agentswitch.android.design.FormSection
import com.agentswitch.android.design.LabeledRow
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.rememberBack
import com.agentswitch.kit.api.HarnessSpec
import com.agentswitch.kit.api.Targets
import com.agentswitch.kit.feed.ModelName
import com.agentswitch.kit.feed.displayName
import kotlinx.coroutines.CancellationException

/**
 * Settings › Models: `GET /targets`, read-only — the scheduling model and its default, then each executor's models. Usage
 * is on the settings root (docs/ui-v0.md §4.2), not here.
 */
@Composable
fun ModelsView() {
    val model = LocalAppModel.current
    var targets by remember { mutableStateOf<Targets?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        val api = model.api ?: return
        try {
            targets = api.targets()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            model.handle(e)
            error = e.message ?: e.javaClass.simpleName
        }
    }
    LaunchedEffect(model.api) { load() }
    SettingsPage("Models", onRefresh = { load() }, leading = { BarBack(rememberBack(), "Settings") }) {
        error?.let { FormSection { FormRow(first = true) { ErrorText(it, { error = null }) } } }
        val t = targets ?: model.dispatch.targets
        if (t != null) {
            t.router?.let { router ->
                FormSection("Router", footer = "调度模型根据消息内容选择执行的模型；无法判断时交由默认模型执行。") {
                    LabeledRow("Model", ModelName.display(router.model), first = true)
                    router.defaultTarget?.let { LabeledRow("Default Model", it.displayName) }
                }
            }
            for (name in t.harnesses.keys.sorted()) t.harnesses[name]?.let { HarnessSection(name, it) }
        }
    }
}

@Composable
private fun HarnessSection(name: String, spec: HarnessSpec) {
    FormSection(ModelName.harness(name)) {
        for ((i, id) in spec.models.keys.sorted().withIndex()) {
            val m = spec.models[id]
            FormRow(first = i == 0) {
                Text(ModelName.display(id), color = Theme.ink, style = plain(16))
                if (id == spec.defaultModel) Text("默认", color = Theme.secondaryInk, style = plain(12))
                Spacer(Modifier.weight(1f))
                Text(if (m?.unavailable == true) "不可用" else (m?.cost ?: ""), color = Theme.secondaryInk, style = plain(12))
            }
        }
        FormRow { Text("Max at Once", Modifier.weight(1f), color = Theme.ink, style = plain(16)); Text("${spec.maxConcurrent}", color = Theme.secondaryInk, style = mono(13)) }
        FormRow { Text("Browser", Modifier.weight(1f), color = Theme.ink, style = plain(16)); Text(if (spec.browser) "Yes" else "No", color = Theme.secondaryInk, style = mono(13)) }
    }
}
