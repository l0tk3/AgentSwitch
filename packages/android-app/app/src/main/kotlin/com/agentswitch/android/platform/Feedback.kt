package com.agentswitch.android.platform

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentswitch.android.AppSettings
import com.agentswitch.kit.feed.Cue
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * Sound and haptic feedback (assistant-v0 §3): the input box must feel received, handed on, finished — without
 * looking. Short synthesized tones, no audio files (the Swift's sine tones, written into an `AudioTrack`); they follow
 * the phone's silent mode unless the user chose otherwise (or voice mode is on, which is for listening). Haptics are
 * the system's predefined effects.
 *
 * The four settings are Compose state read by the settings screen and kept in [AppSettings] (the iPhone's
 * `FeedbackSettings` in `UserDefaults`). With no `context` (a sample screen, a test) nothing sounds or vibrates; the
 * settings still work, in memory. Touched on the main thread.
 */
@Stable
class Feedback(context: Context? = null, private val settings: AppSettings? = null) {
    private val context = context?.applicationContext

    var sound: Boolean by mutableStateOf(settings?.bool(KEY_SOUND, true) ?: true)
        private set
    var haptics: Boolean by mutableStateOf(settings?.bool(KEY_HAPTICS, true) ?: true)
        private set

    /** Sounds play also with the phone on silent (they then go out as media, not as a notification sound). */
    var audibleInSilent: Boolean by mutableStateOf(settings?.bool(KEY_AUDIBLE_IN_SILENT, false) ?: false)
        private set

    /** Reads aloud: the task's result when it ends, a question when one needs you, a short line when a task is taken. */
    var voiceMode: Boolean by mutableStateOf(settings?.bool(KEY_VOICE_MODE, false) ?: false)
        private set

    fun chooseSound(on: Boolean) { sound = on; settings?.putBool(KEY_SOUND, on) }
    fun chooseHaptics(on: Boolean) { haptics = on; settings?.putBool(KEY_HAPTICS, on) }
    fun chooseAudibleInSilent(on: Boolean) { audibleInSilent = on; settings?.putBool(KEY_AUDIBLE_IN_SILENT, on) }
    fun chooseVoiceMode(on: Boolean) { voiceMode = on; settings?.putBool(KEY_VOICE_MODE, on) }

    private var track: AudioTrack? = null

    /**
     * The cue's tap and tone. `speaking`: a voice is reading; the tone then takes no audio focus and is mixed under
     * the voice, which goes on unducked and uninterrupted (as the Swift leaves the audio session as the speaker set it).
     */
    fun play(cue: Cue, speaking: Boolean = false) {
        if (haptics) haptic(cue)
        if (!sound) return
        val tones = tones[cue] ?: return
        val loud = audibleInSilent || voiceMode || speaking
        try {
            val samples = synthesize(tones)
            if (context == null || samples.isEmpty()) return
            // A newer cue interrupts the one still sounding.
            release()
            val attributes = AudioAttributes.Builder()
                .setUsage(if (loud) AudioAttributes.USAGE_MEDIA else AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val format = AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
            val next = AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(format)
                .setBufferSizeInBytes(samples.size * 2).setTransferMode(AudioTrack.MODE_STATIC).build()
            next.write(samples, 0, samples.size)
            next.setNotificationMarkerPosition(samples.size)
            next.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(t: AudioTrack) { if (track === t) release() else t.release() }
                override fun onPeriodicNotification(t: AudioTrack) {}
            })
            track = next
            next.play()
        } catch (_: Exception) {
            // No sound is not worth a banner (an audio device busy or gone).
            release()
        }
    }

    private fun release() {
        val old = track ?: return
        track = null
        try { old.stop() } catch (_: Exception) {}
        old.release()
    }

    private val vibrator: Vibrator? by lazy {
        val c = context ?: return@lazy null
        if (Build.VERSION.SDK_INT >= 31) c.getSystemService(VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") c.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    /** sent: light tap · accepted, done: click · needsYou: double click · failed: heavy click. */
    private fun haptic(cue: Cue) {
        val vibrator = vibrator ?: return
        val effect = when (cue) {
            Cue.Sent -> VibrationEffect.EFFECT_TICK
            Cue.Accepted, Cue.Done -> VibrationEffect.EFFECT_CLICK
            Cue.NeedsYou -> VibrationEffect.EFFECT_DOUBLE_CLICK
            Cue.Failed -> VibrationEffect.EFFECT_HEAVY_CLICK
        }
        try { vibrator.vibrate(VibrationEffect.createPredefined(effect)) } catch (_: Exception) {}
    }

    companion object {
        private const val KEY_SOUND = "feedbackSound"
        private const val KEY_HAPTICS = "feedbackHaptics"
        private const val KEY_AUDIBLE_IN_SILENT = "feedbackAudibleInSilent"
        private const val KEY_VOICE_MODE = "feedbackVoiceMode"
        private const val SAMPLE_RATE = 44_100

        /** (frequency in Hz — 0 is a pause, milliseconds) per cue. */
        val tones: Map<Cue, List<Pair<Double, Double>>> = mapOf(
            Cue.Sent to listOf(880.0 to 55.0),
            Cue.Accepted to listOf(660.0 to 70.0, 990.0 to 95.0),
            Cue.NeedsYou to listOf(880.0 to 110.0, 0.0 to 60.0, 880.0 to 110.0, 0.0 to 60.0, 1175.0 to 170.0),
            Cue.Done to listOf(523.0 to 90.0, 659.0 to 90.0, 784.0 to 170.0),
            Cue.Failed to listOf(440.0 to 150.0, 330.0 to 230.0),
        )

        /** Sine tones with a 6 ms fade at each edge (no clicks), quiet enough to sit under other audio. */
        fun synthesize(tones: List<Pair<Double, Double>>): ShortArray {
            val rate = SAMPLE_RATE.toDouble()
            val frames = tones.sumOf { (rate * it.second / 1000).toInt() }
            val out = ShortArray(frames)
            val fade = rate * 0.006
            var offset = 0
            for ((frequency, ms) in tones) {
                val count = (rate * ms / 1000).toInt()
                for (i in 0 until count) {
                    val envelope = min(1.0, min(i.toDouble(), (count - i).toDouble()) / fade)
                    val value = if (frequency == 0.0) 0.0 else 0.22 * envelope * sin(2 * PI * frequency * i / rate)
                    out[offset + i] = (value * Short.MAX_VALUE).toInt().toShort()
                }
                offset += count
            }
            return out
        }
    }
}
