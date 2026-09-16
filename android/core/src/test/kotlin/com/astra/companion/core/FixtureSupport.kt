package com.astra.companion.core

import kotlinx.serialization.decodeFromString

internal fun fixtureBytes(name: String): ByteArray =
    checkNotNull(object {}.javaClass.classLoader.getResourceAsStream("$name.json")) {
        "missing fixture $name.json — run scripts/capture-companion-fixtures.mjs"
    }.use { it.readBytes() }

internal fun fixtureText(name: String): String = fixtureBytes(name).toString(Charsets.UTF_8)

internal inline fun <reified T> decodeFixture(name: String): T =
    CompanionJson.decodeFromString(fixtureText(name))

