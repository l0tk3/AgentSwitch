package com.agentswitch.android.design

import com.agentswitch.kit.live.ShadedSprite

/**
 * The Files tab's picture in the pixel look (the app's own; not one of the shared copies): a folder, its tab and back
 * panel darker, the front panel raised — a light edge above and left, a dark one below and right.
 */
val ShadedSprite.Companion.folder: ShadedSprite
    get() = folderSprite

private val folderSprite = ShadedSprite(listOf(
    ".dddddd.........", "dkkkkkkdddddddd.", "dkkkkkkkkkkkkkkd", "WWWWWWWWWWWWWWW#", "W##############m", "W##############m",
    "W##############m", "W##############m", "W##############m", "W##############m", "#mmmmmmmmmmmmmmd",
))
