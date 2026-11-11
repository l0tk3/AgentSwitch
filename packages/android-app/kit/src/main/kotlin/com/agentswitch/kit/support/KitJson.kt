package com.agentswitch.kit.support

import kotlinx.serialization.json.Json

/**
 * The one JSON configuration of the kit, for what the Mac sends and what is sent to it.
 *
 * - A field the phone does not know is passed over, so a newer Mac never breaks an older phone.
 * - A `null`, or a value an enum does not have, where a property has a default takes the default.
 * - What is sent carries every property that has a value, also one that equals its default (the Mac reads a missing
 *   field its own way); a `null` is left out, as the iPhone's encoder leaves out an absent optional.
 */
val KitJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    encodeDefaults = true
    explicitNulls = false
    isLenient = false
}
