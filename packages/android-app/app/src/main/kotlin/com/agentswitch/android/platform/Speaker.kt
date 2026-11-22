package com.agentswitch.android.platform

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AppSettings
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.feed.Markdown
import com.agentswitch.kit.feed.Speech
import java.util.Locale

/**
 * 朗读 (app-v0 §5): a task's spoken script read by the phone's text-to-speech engine, in Mandarin. One at a time; the
 * same button stops it. While it speaks, audio focus is held (other apps' audio ducks) and given back after.
 * The voice: the user's pick (kept in [AppSettings]) while it is still installed, else the best installed Mandarin one
 * (the iPhone's `SpeechVoices`, here in the same class: [installedVoices], [chosenVoice], [chooseVoice], [sample]).
 *
 * With no `context` (a sample screen, a test) nothing is spoken. Touched on the main thread; the engine's callbacks are
 * moved there.
 */
@Stable
class Speaker(context: Context? = null, private val settings: AppSettings? = null) {
    private val context = context?.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audio: AudioManager? = this.context?.getSystemService(AudioManager::class.java)

    /** What is being read: a task's id, or the key a voice-mode line was said under; null when silent. */
    var speakingKey: String? by mutableStateOf(null)
        private set
    val isSpeaking: Boolean get() = speakingKey != null

    /** Installed Mandarin voices, best first; empty until the engine has started. */
    var installedVoices: List<Voice> by mutableStateOf(emptyList())
        private set

    /** The name of the voice picked in settings, if any. */
    var chosenName: String? by mutableStateOf(settings?.string(CHOSEN_KEY))
        private set

    private var engine: TextToSpeech? = null
    private var ready = false
    private var failed = false
    private var waiting: (() -> Unit)? = null

    /** The utterance now playing; a callback for an earlier one (stopped to start this) changes nothing. */
    private var current: String? = null
    private var counter = 0
    private var focus: AudioFocusRequest? = null

    private fun start() {
        if (engine != null || failed || context == null) return
        engine = TextToSpeech(context) { status ->
            main.post {
                if (status != TextToSpeech.SUCCESS) {
                    failed = true
                    engine = null
                    waiting = null
                    speakingKey = null
                    return@post
                }
                ready = true
                engine?.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                engine?.setOnUtteranceProgressListener(listener)
                refreshVoices()
                waiting?.invoke()
                waiting = null
            }
        }
    }

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {}
        override fun onDone(utteranceId: String) { main.post { finished(utteranceId) } }
        @Deprecated("Deprecated in Java") override fun onError(utteranceId: String) { main.post { finished(utteranceId) } }
        override fun onStop(utteranceId: String, interrupted: Boolean) { main.post { finished(utteranceId) } }
    }

    /** A voice downloaded meanwhile shows up (call it when the voice page opens). */
    fun refreshVoices() {
        val tts = engine?.takeIf { ready } ?: return
        installedVoices = try { installed(tts) } catch (_: Exception) { emptyList() }
    }

    /** The user's pick while it is still installed, else the best installed one, else the engine's own for Mandarin. */
    fun chosenVoice(): Voice? = installedVoices.firstOrNull { it.name == chosenName } ?: installedVoices.firstOrNull()

    /** A pick from the voice page; the page then calls [sample]. */
    fun chooseVoice(voice: Voice) {
        chosenName = voice.name
        settings?.putString(CHOSEN_KEY, voice.name)
    }

    /** True when only the basic voices are installed (nothing above the engine's normal quality). */
    val onlyCompact: Boolean get() = installedVoices.none { it.quality > Voice.QUALITY_NORMAL }

    /**
     * What to read for a task: its spoken script, else the one-line summary, else its state and the start of the
     * result. Always cleaned (Speech.speakable) so no ciphertext, link or Markdown is read.
     */
    fun toggle(task: AgentTask) {
        if (speakingKey == task.id) {
            stop()
            return
        }
        speak(script(task), task.id, sample = false)
    }

    /**
     * Voice mode (assistant-v0 §3): a short line — a question that needs you, "收到" — under `key`; it replaces what
     * is being read. Cleaned like everything read aloud.
     */
    fun say(text: String, key: String) {
        val line = Speech.speakable(text)
        if (line.isEmpty()) return
        speak(line, key, sample = false)
    }

    /** 试听 in Settings: a short sample in `voice`, no task. */
    fun sample(voice: Voice) = speak(SAMPLE_TEXT, null, sample = true, voice = voice)

    fun stop() {
        current = null
        speakingKey = null
        waiting = null
        // Focus is given back at once: the engine's stop callback finds nothing current and does nothing more.
        try { engine?.stop() } catch (_: Exception) {}
        giveBackFocus()
    }

    /** Ends the engine (the process is going). */
    fun shutdown() {
        stop()
        engine?.shutdown()
        engine = null
        ready = false
    }

    private fun speak(text: String, key: String?, sample: Boolean, voice: Voice? = null) {
        if (context == null) return
        stop()
        start()
        if (failed) return
        val id = "u${++counter}"
        current = id
        speakingKey = key
        val go = {
            val tts = engine
            if (tts != null && current == id) {
                takeFocus()
                tts.language = LANGUAGE
                (voice ?: chosenVoice())?.let { tts.voice = it }
                val result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
                if (result != TextToSpeech.SUCCESS) finished(id)
            }
        }
        if (ready) go() else waiting = go
    }

    private fun finished(id: String) {
        if (id == current) {
            current = null
            speakingKey = null
        }
        if (current == null) giveBackFocus()
    }

    /** Other apps' audio ducks while reading. */
    private fun takeFocus() {
        val audio = audio ?: return
        if (focus != null) return
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener { change ->
                // Someone took focus for good (a call, a player): the reading stops.
                if (change == AudioManager.AUDIOFOCUS_LOSS) main.post { stop() }
            }.build()
        if (audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focus = request
    }

    /** Other apps' audio comes back to full volume (it was ducked while reading). */
    private fun giveBackFocus() {
        val request = focus ?: return
        focus = null
        audio?.abandonAudioFocusRequest(request)
    }

    companion object {
        val LANGUAGE: Locale = Locale.SIMPLIFIED_CHINESE
        const val SAMPLE_TEXT = "这是 AgentSwitch 的朗读声音。任务结束时，将使用此声音朗读结果。"
        private const val CHOSEN_KEY = "speechVoiceName"

        /** Installed Mandarin voices, best first (quality, then name); voices still to be downloaded left out. */
        fun installed(tts: TextToSpeech): List<Voice> =
            (tts.voices ?: emptySet<Voice>())
                .filter { it.locale.language == LANGUAGE.language && (it.locale.country.isEmpty() || it.locale.country == LANGUAGE.country) }
                .filter { !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
                .sortedWith(compareByDescending<Voice> { it.quality }.thenByDescending { it.name })

        /** 高音质 · 增强 · 基础. */
        fun qualityLabel(voice: Voice): String = when {
            voice.quality >= Voice.QUALITY_VERY_HIGH -> "高音质"
            voice.quality >= Voice.QUALITY_HIGH -> "增强"
            else -> "基础"
        }

        /**
         * What to read for a task: its spoken script, else the one-line summary, else its state and the start of the
         * result. Always cleaned (Speech.speakable).
         */
        fun script(task: AgentTask): String {
            val written = listOfNotNull(task.speech, task.spoken).map(Speech::speakable).firstOrNull { it.isNotEmpty() }
            if (written != null) return written
            val result = Markdown.flattened(task.result ?: task.error ?: "").text
            val body = Speech.speakable(result.take(200))
            return if (body.isEmpty()) task.spokenStatus else "${task.spokenStatus}。$body"
        }
    }
}
