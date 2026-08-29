package com.openmausbot.chief.ui.theme

import com.openmausbot.chief.R
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight

val CentipedeAcid = Color(0xFF9FD600)
val CentipedeAction = Color(0xFF6F9600)
val CentipedeInk = Color(0xFF101312)
val CentipedeClinical = Color(0xFFF2F3EE)
val CentipedePaper = Color(0xFFFAFAF6)
val CentipedeSoft = Color(0xFFE5E8DF)
val CentipedeSuccess = Color(0xFF287A54)

// Keep these aliases for older internal callers while the mobile UI uses the
// same vocabulary as the desktop Agent Centipede skin.
@Deprecated("Use CentipedeAcid")
val MausOrange = CentipedeAcid
@Deprecated("Use CentipedeSuccess")
val MausGreen = CentipedeSuccess

private val Inter = FontFamily(
    Font(R.font.inter_variable, FontWeight.Normal),
    Font(R.font.inter_variable, FontWeight.Medium),
    Font(R.font.inter_variable, FontWeight.SemiBold),
    Font(R.font.inter_variable, FontWeight.Bold),
    Font(R.font.inter_variable, FontWeight.ExtraBold),
    Font(R.font.inter_variable, FontWeight.Black),
)

private val BaseTypography = Typography()
private val InterTypography = Typography(
    displayLarge = BaseTypography.displayLarge.copy(fontFamily = Inter),
    displayMedium = BaseTypography.displayMedium.copy(fontFamily = Inter),
    displaySmall = BaseTypography.displaySmall.copy(fontFamily = Inter),
    headlineLarge = BaseTypography.headlineLarge.copy(fontFamily = Inter),
    headlineMedium = BaseTypography.headlineMedium.copy(fontFamily = Inter),
    headlineSmall = BaseTypography.headlineSmall.copy(fontFamily = Inter),
    titleLarge = BaseTypography.titleLarge.copy(fontFamily = Inter),
    titleMedium = BaseTypography.titleMedium.copy(fontFamily = Inter),
    titleSmall = BaseTypography.titleSmall.copy(fontFamily = Inter),
    bodyLarge = BaseTypography.bodyLarge.copy(fontFamily = Inter),
    bodyMedium = BaseTypography.bodyMedium.copy(fontFamily = Inter),
    bodySmall = BaseTypography.bodySmall.copy(fontFamily = Inter),
    labelLarge = BaseTypography.labelLarge.copy(fontFamily = Inter),
    labelMedium = BaseTypography.labelMedium.copy(fontFamily = Inter),
    labelSmall = BaseTypography.labelSmall.copy(fontFamily = Inter),
)

private val Light = lightColorScheme(
    primary = CentipedeAction,
    onPrimary = CentipedeInk,
    primaryContainer = Color(0xFFE1F5A9),
    onPrimaryContainer = CentipedeInk,
    secondary = Color(0xFF506145),
    onSecondary = Color.White,
    background = CentipedeClinical,
    surface = CentipedePaper,
    surfaceVariant = CentipedeSoft,
    onBackground = CentipedeInk,
    onSurface = CentipedeInk,
    onSurfaceVariant = Color(0xFF535A53),
    outline = Color(0xFF747B72),
    outlineVariant = Color(0xFFB7BCB2),
    error = Color(0xFFA8363D),
    onError = Color.White,
)

private val Dark = darkColorScheme(
    primary = CentipedeAcid,
    onPrimary = CentipedeInk,
    primaryContainer = Color(0xFF3E5208),
    onPrimaryContainer = Color(0xFFE8F9B1),
    secondary = Color(0xFFB7D18F),
    onSecondary = Color(0xFF1E2519),
    background = Color(0xFF111411),
    surface = Color(0xFF191D19),
    surfaceVariant = Color(0xFF2A302A),
    onBackground = Color(0xFFE6E9E1),
    onSurface = Color(0xFFE6E9E1),
    onSurfaceVariant = Color(0xFFBBC2B5),
    outline = Color(0xFF8E9888),
    outlineVariant = Color(0xFF424A40),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
)

@Composable
fun AgentCentipedeTheme(content: @Composable () -> Unit) {
    // Keep the acid/ink identity, but respect the device's light/dark choice so
    // the companion feels at home on a phone at any hour.
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, typography = InterTypography, content = content)
}

@Deprecated("Use AgentCentipedeTheme")
@Composable
fun OpenMausTheme(content: @Composable () -> Unit) = AgentCentipedeTheme(content)
