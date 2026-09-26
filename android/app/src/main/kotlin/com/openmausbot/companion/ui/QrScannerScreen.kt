package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull

/**
 * QR scanning for the one action where typing is needless friction — the port of
 * `ios/App/PairingScanner.swift`.
 *
 * The scanner only recognizes QR codes and never pairs by itself. A valid payload
 * goes back to [PairingScreen], which shows the computer name and address for
 * explicit confirmation: an attacker-controlled deep link or QR may prefill a
 * target, but it cannot silently authorize that target.
 *
 * @param validate returns null to accept and close, or a human-readable message
 *   to show while scanning continues. The one-time credential never lives here.
 */
@Composable
fun QrScannerScreen(onCancel: () -> Unit, validate: (String) -> String?) {
    val environment = LocalCompanion.current
    val access by environment.camera.access.collectAsState()
    var validationError by remember { mutableStateOf<String?>(null) }
    var cameraFailure by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { environment.camera.ensure() }

    Column(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
            TextButton(onClick = onCancel, modifier = Modifier.align(Alignment.CenterStart)) {
                Text(stringResource(R.string.mobile_cancel_77dfd213))
            }
            Text(
                text = stringResource(R.string.mobile_scan_qr_code_04e3f103),
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.align(Alignment.Center),
            )
        }

        when {
            cameraFailure != null -> EmptyState(
                title = stringResource(R.string.mobile_scanner_unavailable_cc42e33b),
                description = cameraFailure!!,
            )

            access == CameraAccess.UNKNOWN -> EmptyState(
                title = stringResource(R.string.mobile_requesting_camera_access_30e104c0),
                description = stringResource(R.string.mobile_camera_permission_description),
            )

            access == CameraAccess.DENIED -> EmptyState(
                title = stringResource(R.string.mobile_camera_access_needed_28a22fc4),
                description = stringResource(R.string.mobile_camera_permission_denied),
            ) {
                Button(onClick = environment.openAppSettings) { Text(stringResource(R.string.mobile_open_settings_134635e9)) }
            }

            else -> ScannerSurface(
                validate = validate,
                validationError = validationError,
                onValidationError = { validationError = it },
                onCameraFailure = { cameraFailure = it },
            )
        }
    }
}

@Composable
private fun ScannerSurface(
    validate: (String) -> String?,
    validationError: String?,
    onValidationError: (String?) -> Unit,
    onCameraFailure: (String) -> Unit,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraUnavailable = stringResource(R.string.mobile_camera_unavailable)
    // A camera reports the same QR on many consecutive frames. One payload is
    // latched at a time; a rejected one re-arms after the message has had time
    // to be read.
    val latched = remember { MutableStateFlow<String?>(null) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val currentValidate by rememberUpdatedState(validate)
    val cameraLifecycle = remember { CameraLifecycle() }

    LaunchedEffect(latched) {
        latched.filterNotNull().collect { payload ->
            val problem = currentValidate(payload)
            if (problem == null) return@collect
            onValidationError(problem)
            delay(800)
            latched.value = null
        }
    }

    // Cancel and a successful scan both remove this composable, so one disposal
    // path covers both. Without it the use cases stayed bound to the Activity's
    // lifecycle and ML Kit kept decoding frames behind the pairing form.
    DisposableEffect(Unit) {
        onDispose {
            cameraLifecycle.release()
            analysisExecutor.shutdown()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                val previewView = PreviewView(viewContext)
                val providerFuture = ProcessCameraProvider.getInstance(viewContext)
                providerFuture.addListener(
                    {
                        try {
                            val provider = providerFuture.get()
                            val started = cameraLifecycle.startAnalyzing(
                                createAnalyzer = {
                                    QrCodeAnalyzer { payload ->
                                        latched.compareAndSet(null, payload)
                                    }
                                },
                                releaseAnalyzer = { analyzer ->
                                    runCatching { provider.unbindAll() }
                                    analyzer.close()
                                },
                                bind = { analyzer ->
                                    bindCamera(
                                        provider = provider,
                                        lifecycleOwner = lifecycleOwner,
                                        previewView = previewView,
                                        executor = analysisExecutor,
                                        analyzer = analyzer,
                                    )
                                },
                                onFailure = { error ->
                                    Log.w("PairingScanner", "could not bind the camera", error)
                                },
                            )
                            if (!started) onCameraFailure(cameraUnavailable)
                        } catch (error: Exception) {
                            Log.w("PairingScanner", "camera unavailable", error)
                            onCameraFailure(cameraUnavailable)
                        }
                    },
                    ContextCompat.getMainExecutor(viewContext),
                )
                previewView
            },
        )

        Text(
            text = validationError ?: stringResource(R.string.mobile_point_the_camera_at_the_qr_code_on_77e56351),
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
            color = if (validationError == null) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.error
            },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(16.dp)
                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(18.dp))
                .padding(horizontal = 18.dp, vertical = 14.dp),
        )
    }
}

/**
 * Everything the scanner holds open, released exactly once.
 *
 * The camera provider arrives on a future, and the user can leave before it
 * lands — a disposal that happens first must still tear down whatever binds
 * afterwards, or the camera stays live with nothing on screen. Main-thread only:
 * both [bound] and [release] run on the Activity's main executor.
 */
internal class CameraLifecycle {
    private var pendingRelease: (() -> Unit)? = null
    private var released = false

    fun bound(release: () -> Unit) {
        if (released) {
            release()
            return
        }
        pendingRelease?.invoke()
        pendingRelease = release
    }

    /** Idempotent: a second call releases nothing a second time. */
    fun release() {
        released = true
        val pending = pendingRelease
        pendingRelease = null
        pending?.invoke()
    }
}

/**
 * Build the analyzer, hand it to the lifecycle, *then* bind.
 *
 * The order is the point. Binding can throw — a camera another app holds, a
 * device with no back lens — and an analyzer created but never registered owns
 * an open ML Kit detector that nothing will ever close. Registering first means
 * every exit, including the throwing one, runs the same release.
 *
 * @return false when binding failed; the analyzer has already been released.
 */
internal fun <A> CameraLifecycle.startAnalyzing(
    createAnalyzer: () -> A,
    releaseAnalyzer: (A) -> Unit,
    bind: (A) -> Unit,
    onFailure: (Exception) -> Unit = {},
): Boolean {
    val analyzer = createAnalyzer()
    bound { releaseAnalyzer(analyzer) }
    return try {
        bind(analyzer)
        true
    } catch (error: Exception) {
        release()
        onFailure(error)
        false
    }
}

private fun bindCamera(
    provider: ProcessCameraProvider,
    lifecycleOwner: LifecycleOwner,
    previewView: PreviewView,
    executor: java.util.concurrent.Executor,
    analyzer: ImageAnalysis.Analyzer,
) {
    val preview = Preview.Builder().build().apply {
        surfaceProvider = previewView.surfaceProvider
    }
    val analysis = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
    analysis.setAnalyzer(executor, analyzer)
    provider.unbindAll()
    provider.bindToLifecycle(
        lifecycleOwner,
        CameraSelector.DEFAULT_BACK_CAMERA,
        preview,
        analysis,
    )
}

/** QR only — the pairing payload is the sole thing this app reads from a camera. */
private class QrCodeAnalyzer(private val onPayload: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build(),
    )

    /** Releases ML Kit's detector; safe to call more than once. */
    fun close() {
        runCatching { scanner.close() }
    }

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
        val frame = image.image
        if (frame == null) {
            image.close()
            return
        }
        scanner.process(InputImage.fromMediaImage(frame, image.imageInfo.rotationDegrees))
            .addOnSuccessListener { codes ->
                codes.firstNotNullOfOrNull { it.rawValue }?.let(onPayload)
            }
            .addOnCompleteListener { image.close() }
    }
}