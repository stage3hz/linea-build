package com.linea.core.json

import java.math.BigDecimal

/** Writes exactly what `JSON.stringify(value)` writes in JavaScript (no indentation). */
internal object JsonWriter {
    fun write(value: JsonValue): String = StringBuilder().also { append(it, value) }.toString()

    private fun append(out: StringBuilder, value: JsonValue) {
        when (value) {
            JsonNull -> out.append("null")
            is JsonBool -> out.append(if (value.value) "true" else "false")
            is JsonNumber -> out.append(number(value.value))
            is JsonString -> quote(out, value.value)
            is JsonArray -> {
                out.append('[')
                value.items.forEachIndexed { index, item -> if (index > 0) out.append(','); append(out, item) }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                var first = true
                for (key in javascriptKeyOrder(value.fields.keys)) {
                    if (!first) out.append(',')
                    first = false
                    quote(out, key)
                    out.append(':')
                    append(out, value.fields.getValue(key))
                }
                out.append('}')
            }
        }
    }

    /** JavaScript lists keys that are array indices first, in numeric order, then the rest as they were added. */
    private fun javascriptKeyOrder(keys: Set<String>): List<String> {
        if (keys.none(::isArrayIndex)) return keys.toList()
        val (indices, names) = keys.partition(::isArrayIndex)
        return indices.sortedBy { it.toLong() } + names
    }

    private fun isArrayIndex(key: String): Boolean {
        if (key.isEmpty() || key.length > 10 || key.any { it !in '0'..'9' }) return false
        if (key.length > 1 && key[0] == '0') return false
        return key.toLong() <= 4294967294L
    }

    private fun quote(out: StringBuilder, text: String) {
        out.append('"')
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> escape(out, c)
                // A surrogate without its pair is written as an escape (well-formed JSON.stringify).
                Character.isHighSurrogate(c) ->
                    if (i + 1 < text.length && Character.isLowSurrogate(text[i + 1])) { out.append(c).append(text[i + 1]); i++ } else escape(out, c)
                Character.isLowSurrogate(c) -> escape(out, c)
                else -> out.append(c)
            }
            i++
        }
        out.append('"')
    }

    private fun escape(out: StringBuilder, c: Char) {
        out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
    }

    /** ECMAScript Number::toString: the shortest digits that read back as the same double, in JavaScript's layout. */
    fun number(value: Double): String {
        if (value.isNaN() || value.isInfinite()) return "null"
        if (value == 0.0) return "0"
        if (value < 0) return "-" + number(-value)
        // Double.toString gives the shortest digits; only its layout differs from JavaScript's.
        val decimal = BigDecimal(value.toString()).stripTrailingZeros()
        val digits = decimal.unscaledValue().toString()
        val k = digits.length
        val n = k - decimal.scale() // the decimal point sits after the n-th digit
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val exponent = n - 1
                val sign = if (exponent < 0) "-" else "+"
                val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
                mantissa + "e" + sign + Math.abs(exponent)
            }
        }
    }
}
