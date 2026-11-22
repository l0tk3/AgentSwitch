package com.agentswitch.android.dispatch

import com.agentswitch.android.settings.CiphertextPicker
import com.agentswitch.android.LocalNav
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.agentswitch.android.LocalAppModel
import com.agentswitch.android.components.inlineAnnotated
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.PixelBox
import com.agentswitch.android.design.PixelBoxEffect
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.code
import com.agentswitch.android.design.framed
import com.agentswitch.android.design.grounded
import com.agentswitch.android.design.labelWord
import com.agentswitch.android.design.lookWord
import com.agentswitch.android.design.mono
import com.agentswitch.android.design.plain
import com.agentswitch.android.terminals.LookGlyph
import com.agentswitch.android.terminals.LookSymbol
import com.agentswitch.kit.api.AnswerCheck
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ApprovalDecision
import com.agentswitch.kit.api.ApprovalKind
import com.agentswitch.kit.api.QuestionEvidence
import com.agentswitch.kit.api.UserQuestion
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.kit.feed.Markdown
import kotlinx.coroutines.launch

/**
 * One pending approval (allow / deny) or question (answer form). `onDecide` for an approval, `onAnswer` for a
 * question's answers by question id.
 */
@Composable
fun ApprovalCard(approval: Approval, modifier: Modifier = Modifier, onDecide: suspend (ApprovalDecision) -> Unit, onAnswer: suspend (Map<String, List<String>>) -> Unit) {
    var busy by remember(approval.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun run(body: suspend () -> Unit) {
        scope.launch { busy = true; try { body() } finally { busy = false } }
    }
    val classic = LocalLook.current.isClassic
    val evidence = approval.questionEvidence
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
        if (evidence != null) {
            QuestionForm(evidence, busy) { answers -> run { onAnswer(answers) } }
        } else if (approval.kind == ApprovalKind.Question) {
            CardHeading("Answer")
            Text(approval.action, color = Theme.ink, style = plain(17))
            Text("此问题的格式暂不支持在手机上回答，请在 Mac 上回答。", color = Theme.secondaryInk, style = plain(13))
        } else {
            CardHeading("Approve")
            // The command, as code; in the classic look in a field of its own.
            SelectionContainer {
                Text(
                    approval.action,
                    Modifier.then(if (classic) Modifier.fillMaxWidth().grounded(Theme.code, Theme.Radius.control).padding(10.dp) else Modifier),
                    color = Theme.ink, style = code(16),
                )
            }
            if (approval.evidence.isNotEmpty()) {
                var open by remember(approval.id) { mutableStateOf(false) }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        Modifier.clickable(role = Role.Button) { open = !open }.padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Details", color = Theme.ink, style = plain(13))
                        LookGlyph(if (open) "▾" else "›", if (open) LookSymbol.ChevronDown else LookSymbol.ChevronRight, size = 12)
                    }
                    if (open) SelectionContainer { Text(approval.evidence, color = Theme.secondaryInk, style = code(12)) }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
                SquareButton("Deny", { run { onDecide(ApprovalDecision.Deny) } }, Modifier.weight(1f), destructive = true, enabled = !busy)
                SquareButton("Allow", { run { onDecide(ApprovalDecision.Allow) } }, Modifier.weight(1f), prominent = true, enabled = !busy)
            }
        }
    }
}

/**
 * The questions of one card: pick options (one, or several when `multi`) and/or type an answer. A `secret` question is
 * answered with what is typed (the Mac seals it before anything stores it, router-v0 §9) or a saved ciphertext.
 */
@Composable
fun QuestionForm(evidence: QuestionEvidence, busy: Boolean, onSubmit: (Map<String, List<String>>) -> Unit) {
    val model = LocalAppModel.current
    val chosen = remember(evidence) { mutableStateMapOf<String, Set<String>>() }
    val typed = remember(evidence) { mutableStateMapOf<String, String>() }
    var problem by remember(evidence) { mutableStateOf<String?>(null) }
    val classic = LocalLook.current.isClassic

    fun isChosen(q: UserQuestion, label: String) = chosen[q.id]?.contains(label) == true
    fun toggle(q: UserQuestion, label: String) {
        val set = chosen[q.id] ?: emptySet()
        chosen[q.id] = if (label in set) set - label else if (q.multi) set + label else setOf(label)
    }
    fun submit() {
        val answers = evidence.questions.associate { q ->
            val picked = q.options.map { it.label }.filter { isChosen(q, it) }
            val text = typed[q.id] ?: ""
            q.id to picked + (if (text.isEmpty()) emptyList() else listOf(text))
        }
        val cleaned = AnswerCheck.cleaned(answers)
        val issue = AnswerCheck.problem(evidence.questions, cleaned)
        problem = issue
        if (issue == null) onSubmit(cleaned)
    }

    val nav = LocalNav.current

    Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.m)) {
        CardHeading("Answer")
        for (q in evidence.questions) {
            Column(verticalArrangement = Arrangement.spacedBy(Theme.Space.s)) {
                val wash = Theme.code
                Text(remember(q.text, wash) { inlineAnnotated(Markdown.inline(q.text), {}, Color.Unspecified, wash) }, color = Theme.ink, style = plain(17))
                for (option in q.options) {
                    val on = isChosen(q, option.label)
                    Row(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { toggle(q, option.label) },
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        // one of several: < > / <x>; several: [ ] / [x] (§7.2.6); a ring or a box in the classic look
                        val mark = if (classic) (if (q.multi) (if (on) "☑" else "☐") else (if (on) "◉" else "○")) else (if (q.multi) (if (on) "[x]" else "[ ]") else (if (on) "<x>" else "< >"))
                        Text(mark, color = if (on) Theme.signal else Theme.secondaryInk, style = if (classic) plain(17) else mono(14))
                        Column {
                            Text(option.label, color = Theme.ink, style = plain(17))
                            if (option.description.isNotEmpty()) Text(option.description, color = Theme.secondaryInk, style = plain(12))
                        }
                    }
                }
                if (q.secret) {
                    AnswerField(typed[q.id] ?: "", { typed[q.id] = it }, "直接输入，由 Mac 加密", secret = true)
                    if (model.dispatch.ciphertexts.isNotEmpty()) {
                        Text("Use Saved Ciphertext", Modifier.clickable(role = Role.Button) { val id = q.id; nav.present("answerCiphertext") { CiphertextPicker { token -> typed[id] = token } } }.padding(vertical = 2.dp), color = Theme.ink, style = mono(12))
                    }
                } else {
                    AnswerField(typed[q.id] ?: "", { typed[q.id] = it }, if (q.options.isEmpty()) "回答" else "其他回答（可选）", secret = false)
                }
            }
        }
        problem?.let { Text(it, color = Theme.failed, style = plain(13)) }
        SquareButton(if (busy) "Submitting" else "Submit", { submit() }, prominent = true, enabled = !busy)
    }
}

/** An answer box: a square 1 dp frame, not the system's bordered look. */
@Composable
private fun AnswerField(value: String, onChange: (String) -> Unit, prompt: String, secret: Boolean) {
    val style = plain(17).copy(color = Theme.ink)
    Box(Modifier.fillMaxWidth().framed(Theme.line, Theme.Radius.control).padding(horizontal = 12.dp, vertical = 10.dp)) {
        if (value.isEmpty()) Text(prompt, color = Theme.inkDim, style = style, maxLines = 1)
        BasicTextField(
            value, onChange, Modifier.fillMaxWidth(), textStyle = style, cursorBrush = SolidColor(Theme.signal),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        )
    }
}

/**
 * `Approve` / `Answer`: the one line in the waiting colour, with its square. In the classic look the card's name
 * (`Approval Needed`, `Question`) after a warning or a question mark.
 */
@Composable
private fun CardHeading(text: String) {
    val classic = LocalLook.current.isClassic
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (classic) {
            val tint = if (text == "Answer") Theme.signal else Theme.waiting
            Box(Modifier.size(15.dp).background(tint, CircleShape), contentAlignment = Alignment.Center) {
                Text(if (text == "Answer") "?" else "!", color = Color.White, style = plain(10, FontWeight.Bold))
            }
            Text(lookWord(text), color = Theme.ink, style = plain(14, FontWeight.SemiBold))
        } else {
            PixelSprite(PixelArt.square, pixel = 2.dp, color = Theme.waiting)
            Text(text, color = Theme.waiting, style = mono(12, FontWeight.SemiBold))
        }
    }
}
