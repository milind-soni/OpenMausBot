package com.openmausbot.companion.ui

/**
 * The named desktop skins, mirrored here so the companion keeps the same
 * palette rather than reducing the choice to a light/dark switch.
 */
enum class AppearanceSkin(
    val wireValue: String,
    val label: String,
    val isDark: Boolean,
    val colors: SkinColors,
) {
    MIDNIGHT("midnight", "Midnight", true, SkinColors("070707", "111111", "262626", "FCFCFC", "FCFCFC99", "1084FE", "FFFFFF", "38D591", "FF5667", "333333")),
    ATELIER("atelier", "Atelier", false, SkinColors("F5F1EB", "FBF8F2", "FFFFFF", "1A1A18", "6B6559", "A05F25", "FFFFFF", "3F6B47", "A33A32", "C8BDA8")),
    FOUNDRY("foundry", "Foundry", true, SkinColors("100E0B", "171410", "1E1A14", "F4EFE4", "B0A696", "D99A3E", "1C150C", "57B078", "E0685E", "3D3529")),
    LAGOON("lagoon", "Lagoon", false, SkinColors("DFECEB", "ECF4F3", "FFFFFF", "14201F", "4D5C5B", "11736D", "FFFFFF", "2F6B4F", "A8382F", "AEBFBD")),
    GRAPHITE("graphite", "Graphite", true, SkinColors("111214", "181A1D", "22252A", "F2F4F7", "B3B8C2", "4F75A2", "FFFFFF", "63B58A", "DD6B73", "3B4048")),
    LINEN("linen", "Linen", false, SkinColors("ECEFF3", "F5F6F8", "FFFFFF", "1D2229", "59616C", "355F8A", "FFFFFF", "2F704F", "A83D48", "B4BBC5")),
    DUSK("dusk", "Dusk", true, SkinColors("121014", "19161C", "231F27", "F4EFF6", "B9AFBD", "765683", "FFFFFF", "6FAD83", "DB727A", "403847")),
    DAYLIGHT("daylight", "Daylight", false, SkinColors("FCFCFC", "F7F7F7", "EEEEEE", "0D0D0D", "575757", "0B62C4", "FFFFFF", "1F7A4D", "C02B3A", "D0D0D0")),
    ;

    companion object {
        /** Matches the desktop picker on a fresh install and for invalid old values. */
        val DEFAULT = MIDNIGHT

        fun fromWire(value: String?): AppearanceSkin =
            entries.firstOrNull { it.wireValue == value } ?: DEFAULT
    }
}

/** The Material-relevant desktop tokens for one [AppearanceSkin]. */
data class SkinColors(
    val app: String,
    val panel: String,
    val card: String,
    val ink: String,
    val secondaryInk: String,
    val accent: String,
    val accentInk: String,
    val success: String,
    val error: String,
    val outline: String,
)
