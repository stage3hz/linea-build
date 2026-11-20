package com.linea.core.json

/** A server answer that does not have the shape the app relies on. */
class MalformedResponseException(message: String) : Exception(message)

fun JsonValue?.asObject(): JsonObject? = this as? JsonObject
fun JsonValue?.asArray(): JsonArray? = this as? JsonArray
fun JsonValue?.asString(): String? = (this as? JsonString)?.value
fun JsonValue?.asBoolean(): Boolean? = (this as? JsonBool)?.value
fun JsonValue?.asDouble(): Double? = (this as? JsonNumber)?.value
fun JsonValue?.asLong(): Long? = (this as? JsonNumber)?.safeLong
fun JsonValue?.asInt(): Int? = asLong()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

fun JsonObject.string(name: String): String = this[name].asString() ?: missing(name)
fun JsonObject.long(name: String): Long = this[name].asLong() ?: missing(name)
fun JsonObject.int(name: String): Int = this[name].asInt() ?: missing(name)
fun JsonObject.boolean(name: String): Boolean = this[name].asBoolean() ?: missing(name)
fun JsonObject.obj(name: String): JsonObject = this[name].asObject() ?: missing(name)
fun JsonObject.array(name: String): JsonArray = this[name].asArray() ?: missing(name)

fun JsonObject.stringOrNull(name: String): String? = this[name].asString()
fun JsonObject.longOrNull(name: String): Long? = this[name].asLong()
fun JsonObject.intOrNull(name: String): Int? = this[name].asInt()
fun JsonObject.booleanOrNull(name: String): Boolean? = this[name].asBoolean()

private fun missing(name: String): Nothing = throw MalformedResponseException("The server answer has no valid «$name».")

fun JsonValue.requireObject(): JsonObject = this as? JsonObject ?: throw MalformedResponseException("The server answer is not an object.")

/** Builds an object in the given order, leaving out the fields whose value is null (as `undefined` is left out). */
fun jsonObject(vararg fields: Pair<String, JsonValue?>): JsonObject {
    val map = LinkedHashMap<String, JsonValue>()
    for ((name, value) in fields) if (value != null) map[name] = value
    return JsonObject(map)
}

fun String.json(): JsonValue = JsonString(this)
fun Long.json(): JsonValue = JsonNumber(this)
fun Int.json(): JsonValue = JsonNumber(this)
fun Boolean.json(): JsonValue = JsonBool(this)
