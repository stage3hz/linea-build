package com.linea.core.json

/**
 * A JSON document as a tree. Objects keep the order their keys were added in, as JavaScript objects do:
 * the encryption core hashes and signs `JSON.stringify` output, so key order is part of the format.
 */
sealed interface JsonValue {
    /** The text `JSON.stringify` would produce for this value. */
    fun stringify(): String = JsonWriter.write(this)

    companion object {
        /** Parses strict JSON (what `JSON.parse` accepts). Throws [JsonException] otherwise. */
        fun parse(text: String): JsonValue = JsonParser(text).parseDocument()
    }
}

data object JsonNull : JsonValue

data class JsonBool(val value: Boolean) : JsonValue

/** Every JSON number is a double, as in JavaScript: integers are exact up to 2^53. */
data class JsonNumber(val value: Double) : JsonValue {
    constructor(value: Long) : this(value.toDouble())
    constructor(value: Int) : this(value.toDouble())

    /** The value as a whole number, or null when it has a fraction or is outside the exact range. */
    val safeLong: Long?
        get() = if (value == Math.rint(value) && Math.abs(value) <= MAX_SAFE_INTEGER) value.toLong() else null

    companion object {
        const val MAX_SAFE_INTEGER = 9007199254740991.0
    }
}

data class JsonString(val value: String) : JsonValue

data class JsonArray(val items: List<JsonValue>) : JsonValue, List<JsonValue> by items

data class JsonObject(val fields: Map<String, JsonValue>) : JsonValue {
    operator fun get(name: String): JsonValue? = fields[name]
    val keys: Set<String> get() = fields.keys

    companion object {
        val EMPTY = JsonObject(emptyMap())
    }
}

class JsonException(message: String) : Exception(message)
