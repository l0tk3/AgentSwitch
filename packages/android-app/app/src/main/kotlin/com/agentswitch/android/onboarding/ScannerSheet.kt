package com.agentswitch.android.onboarding

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts.RequestPermission
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GeoSize
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentswitch.android.LocalNav
import com.agentswitch.android.design.BarWord
import com.agentswitch.android.design.LocalLook
import com.agentswitch.android.design.NavBar
import com.agentswitch.android.design.SquareButton
import com.agentswitch.android.design.Theme
import com.agentswitch.android.design.lookShape
import com.agentswitch.android.design.plain
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/** Where the camera stands: the permission being asked, or what is wrong, or running. */
private enum class CameraStatus { Asking, Ready, NoPermission, NoCamera, FailedToOpen }

/**
 * The camera, with a close button and what to do when there is no camera or no permission.
 *
 * CameraX shows the picture and hands the latest frame to ZXing ([decodeQr]) on its own thread; the first text found
 * that is the Mac's pairing link (`agentswitch://…`) goes to [onCode] once, then the analysis stops; any other code
 * in view is passed over.
 */
@Composable
fun ScannerSheet(onCode: (String) -> Unit, bottom: @Composable () -> Unit = {}) {
    val nav = LocalNav.current
    val context = LocalContext.current
    var status by remember {
        mutableStateOf(
            when {
                !context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) -> CameraStatus.NoCamera
                granted(context) -> CameraStatus.Ready
                else -> CameraStatus.Asking
            },
        )
    }
    val request = rememberLauncherForActivityResult(RequestPermission()) { ok ->
        status = if (ok) CameraStatus.Ready else CameraStatus.NoPermission
    }
    LaunchedEffect(Unit) { if (status == CameraStatus.Asking) request.launch(Manifest.permission.CAMERA) }
    // Back from the system settings with the permission given: start the camera.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (status == CameraStatus.NoPermission && granted(context)) status = CameraStatus.Ready
    }

    Column(Modifier.fillMaxSize().background(Theme.base)) {
        NavBar("Scan QR Code", leading = { BarWord("Close", { nav.pop() }) })
        Box(Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
            if (status == CameraStatus.Ready) {
                CameraPreview(onCode = onCode, onFailed = { status = it })
                ScanFrame(Modifier.align(Alignment.Center))
            }
            if (status == CameraStatus.NoPermission || status == CameraStatus.NoCamera || status == CameraStatus.FailedToOpen) {
                Problem(status, context)
            }
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Theme.base.copy(alpha = if (status == CameraStatus.Ready) 0.8f else 0f))) { bottom() }
        }
    }
}

private fun granted(context: Context) =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

/** The live picture, and the frames read from it. */
@Composable
private fun CameraPreview(onCode: (String) -> Unit, onFailed: (CameraStatus) -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val deliver by rememberUpdatedState(onCode)
    val failed by rememberUpdatedState(onFailed)
    val view = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
            setBackgroundColor(android.graphics.Color.BLACK)
        }
    }
    DisposableEffect(owner, view) {
        val main = ContextCompat.getMainExecutor(context)
        val analyzerThread = Executors.newSingleThreadExecutor()
        val delivered = AtomicBoolean(false)
        var gone = false
        var provider: ProcessCameraProvider? = null
        var camera: Camera? = null
        val future = ProcessCameraProvider.getInstance(context)
        val stateObserver = androidx.lifecycle.Observer<CameraState> { state ->
            // A closed camera with an error is one that will not come back (an error that can be retried only opens again).
            if (state.type == CameraState.Type.CLOSED && state.error != null) failed(CameraStatus.FailedToOpen)
        }
        future.addListener({
            if (gone) return@addListener
            try {
                val p = future.get()
                provider = p
                val selector = when {
                    p.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                    p.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                    else -> { failed(CameraStatus.NoCamera); return@addListener }
                }
                val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                // A pairing link makes a dense code: more than the 640 x 480 a use case gets by default.
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analyzerThread) { image ->
                    try {
                        if (delivered.get()) return@setAnalyzer
                        val plane = image.planes[0]
                        val buffer = plane.buffer
                        val stride = plane.rowStride
                        // The last row of a plane may stop at its last pixel: copy what there is into a whole-rows array.
                        val luma = ByteArray(maxOf(buffer.remaining(), stride * image.height))
                        buffer.get(luma, 0, buffer.remaining())
                        val text = decodeQr(luma, image.width, image.height, stride, image.imageInfo.rotationDegrees)
                        // Only the Mac's pairing code counts, as on the iPhone: another QR code in view is passed over and
                        // the camera keeps looking.
                        if (text != null && text.lowercase().startsWith("agentswitch://") && delivered.compareAndSet(false, true)) {
                            analysis.clearAnalyzer()
                            main.execute { if (!gone) deliver(text) }
                        }
                    } finally {
                        image.close()
                    }
                }
                p.unbindAll()
                camera = p.bindToLifecycle(owner, selector, preview, analysis).also { it.cameraInfo.cameraState.observe(owner, stateObserver) }
            } catch (_: Exception) {
                failed(CameraStatus.FailedToOpen)
            }
        }, main)
        onDispose {
            gone = true
            camera?.cameraInfo?.cameraState?.removeObserver(stateObserver)
            provider?.unbindAll()
            analyzerThread.shutdown()
        }
    }
    AndroidView({ view }, Modifier.fillMaxSize())
}

/** A quiet square in the middle: four corner marks, 1 dp, the ink at 70 %, and one line under it. */
@Composable
private fun ScanFrame(modifier: Modifier = Modifier) {
    val ink = Theme.ink.copy(alpha = 0.7f)
    val classic = LocalLook.current.isClassic
    BoxWithConstraints(modifier.fillMaxSize()) {
        val side = minOf(maxWidth * 0.7f, maxHeight * 0.6f, 280.dp)
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Canvas(Modifier.size(side)) {
                // Whole pixels for the lines and the corners (§7.2.1): the stroke is at least one pixel, the box sits on pixels.
                val stroke = 1.dp.toPx().roundToInt().coerceAtLeast(1).toFloat()
                val half = stroke / 2f
                val extent = size.width.roundToInt().toFloat()
                val leg = 24.dp.toPx().roundToInt().toFloat()
                val radius = if (classic) 12.dp.toPx() else 0f
                corners(ink, stroke, half, extent, leg, radius)
            }
            Text(
                "将二维码置于框内",
                Modifier.background(Color.Black.copy(alpha = 0.5f), lookShape(6.dp)).padding(horizontal = 12.dp, vertical = 6.dp),
                color = Theme.secondaryInk, style = plain(13), textAlign = TextAlign.Center,
            )
        }
    }
}

private fun DrawScope.corners(color: Color, stroke: Float, half: Float, extent: Float, leg: Float, radius: Float) {
    val lo = half
    val hi = extent - half
    val path = Path()
    // One L per corner, from the end of one leg into the corner and out along the other; rounded in the classic look.
    fun corner(cx: Float, cy: Float, dx: Float, dy: Float) {
        // (cx, cy) the corner point, (dx, dy) the direction into the frame: +1 or -1 on each axis.
        path.moveTo(cx, cy + dy * leg)
        if (radius > 0f) {
            path.lineTo(cx, cy + dy * radius)
            path.quadraticTo(cx, cy, cx + dx * radius, cy)
        } else {
            path.lineTo(cx, cy)
        }
        path.lineTo(cx + dx * leg, cy)
    }
    corner(lo, lo, 1f, 1f)
    corner(hi, lo, -1f, 1f)
    corner(lo, hi, 1f, -1f)
    corner(hi, hi, -1f, -1f)
    drawPath(path, color, style = Stroke(width = stroke, cap = StrokeCap.Butt))
}

/** What is wrong, as the iPhone says it: a camera, the sentence, and the other way in. */
@Composable
private fun Problem(status: CameraStatus, context: Context) {
    val sentence = when (status) {
        CameraStatus.NoPermission -> "未获得相机权限。请在系统设置中允许 AgentSwitch 使用相机。"
        CameraStatus.NoCamera -> "此设备无可用的相机。"
        else -> "无法打开相机。"
    }
    Column(
        Modifier.fillMaxSize().background(Theme.base).padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) {
        CameraGlyph(Theme.secondaryInk, Theme.base)
        Text(sentence, color = Theme.ink, style = plain(17), textAlign = TextAlign.Center)
        Text("可改用「Paste Pairing Link」。", color = Theme.secondaryInk, style = plain(13), textAlign = TextAlign.Center)
        if (status == CameraStatus.NoPermission) {
            SquareButton("Open Settings", {
                try {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: Exception) {
                }
            }, expand = false)
        }
    }
}

/** `camera.fill`: a body with the viewfinder's hump and a lens, 34 dp wide as the large title is. */
@Composable
private fun CameraGlyph(color: Color, ground: Color) {
    val classic = LocalLook.current.isClassic
    Canvas(Modifier.size(width = 44.dp, height = 34.dp)) {
        val w = size.width
        val h = size.height
        val r = if (classic) 5.dp.toPx() else 0f
        val bodyTop = h * 0.18f
        // The hump over the body's left of centre.
        drawRect(color, Offset(w * 0.30f, 0f), GeoSize(w * 0.30f, bodyTop + 1f))
        drawRoundRect(color, Offset(0f, bodyTop), GeoSize(w, h - bodyTop), androidx.compose.ui.geometry.CornerRadius(r, r))
        val lens = (h - bodyTop) * 0.30f
        drawCircle(ground, lens, Offset(w / 2f, bodyTop + (h - bodyTop) / 2f))
        drawCircle(color, lens * 0.55f, Offset(w / 2f, bodyTop + (h - bodyTop) / 2f))
    }
}
