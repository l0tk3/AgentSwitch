package com.agentswitch.android.platform

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.agentswitch.android.AppSettings
import com.agentswitch.kit.design.PixelArt
import com.agentswitch.android.design.PixelSprite
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.plain
import java.util.concurrent.Executor

/**
 * The gate in front of the whole app (the iPhone's Face ID lock; app-v0 §6: a lost phone must not send tasks), with the
 * phone's own fingerprint, face or screen lock. Off by default; when on, the app locks at launch and whenever it goes
 * behind. The setting is kept in [AppSettings]. One per process: the activity may be made again while the app is locked.
 */
class AppLock private constructor(private val settings: AppSettings) {
    var enabled: Boolean by mutableStateOf(settings.bool(KEY, false))
        private set
    var locked: Boolean by mutableStateOf(enabled)
        private set
    var lastError: String? by mutableStateOf(null)
        private set

    /** For labels: the phone's own lock, whichever way it is opened. */
    val biometryName: String get() = "Screen Lock"

    fun lockIfEnabled() { if (enabled) locked = true }

    fun unlock(activity: Activity?) {
        authenticate(activity, "解锁 AgentSwitch") { if (it) locked = false }
    }

    /** Turning the lock on or off both need the owner, so a borrowed unlocked phone cannot switch it off. */
    fun setEnabled(on: Boolean, activity: Activity?) {
        if (on == enabled) return
        authenticate(activity, if (on) "开启解锁保护" else "关闭解锁保护") { ok ->
            if (ok) { enabled = on; settings.putBool(KEY, on) }
        }
    }

    private fun authenticate(activity: Activity?, reason: String, done: (Boolean) -> Unit) {
        if (activity == null || Build.VERSION.SDK_INT < 30) {
            lastError = "此设备不支持系统解锁。"; done(false); return
        }
        val manager = activity.getSystemService(BiometricManager::class.java)
        val allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        if (manager?.canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
            lastError = "此设备未设置密码或生物识别。"; done(false); return
        }
        val executor = Executor { r -> activity.runOnUiThread(r) }
        val prompt = BiometricPrompt.Builder(activity)
            .setTitle(reason)
            .setAllowedAuthenticators(allowed)
            .build()
        prompt.authenticate(CancellationSignal(), executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { lastError = null; done(true) }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                val cancelled = errorCode == 10 || errorCode == 13 // user cancelled, negative button
                lastError = if (cancelled) null else errString?.toString()
                done(false)
            }
        })
    }

    companion object {
        const val KEY = "faceIDLockEnabled"
        private var shared: AppLock? = null
        fun of(settings: AppSettings): AppLock = shared ?: AppLock(settings).also { shared = it }
    }
}

/** The activity a composition lives in. */
@Composable
fun rememberActivity(): Activity? {
    var c: Context = LocalContext.current
    while (c is ContextWrapper) { if (c is Activity) return c; c = c.baseContext }
    return null
}

/** Full-screen cover while the app is locked (the Swift's `LockView`). */
@Composable
fun LockView(lock: AppLock) {
    val activity = rememberActivity()
    Column(
        Modifier.fillMaxSize().background(Theme.base).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        PixelSprite(PixelArt.lock, pixel = 6.dp, color = Theme.secondaryInk, strength = 0.9f, cell = 7.0 / 3)
        Text("AgentSwitch 已锁定", color = Theme.ink, style = plain(20, FontWeight.Bold))
        SquareButton("Unlock with ${lock.biometryName}", { lock.unlock(activity) }, expand = false, prominent = true)
        lock.lastError?.let { Text(it, color = Theme.failed, style = plain(13), textAlign = TextAlign.Center) }
    }
    LaunchedEffect(Unit) { lock.unlock(activity) }
}
