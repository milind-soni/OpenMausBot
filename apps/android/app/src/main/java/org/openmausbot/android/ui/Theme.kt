package org.openmausbot.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import org.openmausbot.android.data.Repo

private val Dark = darkColorScheme(
    primary = Color(0xFF7EE787),
    onPrimary = Color(0xFF06210C),
    primaryContainer = Color(0xFF1D3A24),
    onPrimaryContainer = Color(0xFFB7F5C4),
    secondary = Color(0xFF8FB8FF),
    onSecondary = Color(0xFF0A1B33),
    background = Color(0xFF0B0D10),
    onBackground = Color(0xFFE6EAF0),
    surface = Color(0xFF11151A),
    onSurface = Color(0xFFE6EAF0),
    surfaceVariant = Color(0xFF1A2129),
    onSurfaceVariant = Color(0xFFA9B4C1),
    outline = Color(0xFF2C3742),
    error = Color(0xFFFF8A80),
    onError = Color(0xFF3A0A08),
)

private val Light = lightColorScheme(
    primary = Color(0xFF1F883D),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD5F5DE),
    onPrimaryContainer = Color(0xFF07301A),
    secondary = Color(0xFF2F5DA8),
    background = Color(0xFFF7F8FA),
    onBackground = Color(0xFF14181D),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF14181D),
    surfaceVariant = Color(0xFFEDF0F4),
    onSurfaceVariant = Color(0xFF4A5563),
    outline = Color(0xFFD3DAE3),
    error = Color(0xFFB3261E),
)

/** The harness names twelve mascot colours; each bot keeps its own so a room
 *  of bots is readable at a glance. */
fun botColor(name: String, dark: Boolean): Color = when (name) {
    "blue" -> if (dark) Color(0xFF8FB8FF) else Color(0xFF2F5DA8)
    "red" -> if (dark) Color(0xFFFF9B94) else Color(0xFFB3261E)
    "orange" -> if (dark) Color(0xFFFFB877) else Color(0xFFB25E00)
    "purple" -> if (dark) Color(0xFFC8A6FF) else Color(0xFF6A3FB5)
    "cyan" -> if (dark) Color(0xFF7FE3EA) else Color(0xFF00707A)
    "pink" -> if (dark) Color(0xFFFFA6D2) else Color(0xFFA8266B)
    "yellow" -> if (dark) Color(0xFFF2DE7B) else Color(0xFF7A6300)
    "teal" -> if (dark) Color(0xFF7BDCC3) else Color(0xFF0A6E5C)
    "coral" -> if (dark) Color(0xFFFFA894) else Color(0xFFB3422B)
    "silver" -> if (dark) Color(0xFFCBD3DC) else Color(0xFF5A6673)
    "chrome" -> if (dark) Color(0xFFDDE6F2) else Color(0xFF3C4A5A)
    else -> if (dark) Color(0xFF7EE787) else Color(0xFF1F883D)
}

private val AppTypography = Typography(
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 21.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.5.sp, lineHeight = 21.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 11.5.sp),
)

@Composable
fun MausTheme(content: @Composable () -> Unit) {
    val saved = Repo.store.darkTheme
    val dark = saved ?: isSystemInDarkTheme()
    val scheme = remember(dark) { if (dark) Dark else Light }
    MaterialTheme(colorScheme = scheme, typography = AppTypography, content = content)
}

@Composable
fun isDark(): Boolean {
    val saved = Repo.store.darkTheme
    return saved ?: isSystemInDarkTheme()
}
