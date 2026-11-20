package com.linea.core.json

/** Strict JSON, as `JSON.parse` reads it: no comments, no trailing commas, no leading zeros. */
internal class JsonParser(private val text: String) {
    private var at = 0
    private var depth = 0

    fun parseDocument(): JsonValue {
        skipSpace()
        val value = parseValue()
        skipSpace()
        if (at != text.length) fail("unexpected text after the document")
        return value
    }

    private fun parseValue(): JsonValue {
        if (at >= text.length) fail("unexpected end")
        return when (val c = text[at]) {
            '{' -> nested(::parseObject)
            '[' -> nested(::parseArray)
            '"' -> JsonString(parseString())
            't' -> literal("true", JsonBool(true))
            'f' -> literal("false", JsonBool(false))
            'n' -> literal("null", JsonNull)
            else -> if (c == '-' || c in '0'..'9') parseNumber() else fail("unexpected character")
        }
    }

    private fun nested(parse: () -> JsonValue): JsonValue {
        // A document nested deeper than any real answer would overflow the stack before it was refused.
        if (++depth > MAX_DEPTH) fail("nested too deep")
        return parse().also { depth-- }
    }

    private fun parseObject(): JsonValue {
        at++
        val fields = LinkedHashMap<String, JsonValue>()
        skipSpace()
        if (peek() == '}') { at++; return JsonObject(fields) }
        while (true) {
            skipSpace()
            if (peek() != '"') fail("a key must be a string")
            val key = parseString()
            skipSpace()
            if (peek() != ':') fail("':' expected")
            at++
            skipSpace()
            // A repeated key keeps its first position and takes the last value, as in JavaScript.
            fields[key] = parseValue()
            skipSpace()
            when (peek()) {
                ',' -> at++
                '}' -> { at++; return JsonObject(fields) }
                else -> fail("',' or '}' expected")
            }
        }
    }

    private fun parseArray(): JsonValue {
        at++
        val items = ArrayList<JsonValue>()
        skipSpace()
        if (peek() == ']') { at++; return JsonArray(items) }
        while (true) {
            skipSpace()
            items.add(parseValue())
            skipSpace()
            when (peek()) {
                ',' -> at++
                ']' -> { at++; return JsonArray(items) }
                else -> fail("',' or ']' expected")
            }
        }
    }

    private fun parseString(): String {
        at++
        val out = StringBuilder()
        while (true) {
            if (at >= text.length) fail("unterminated string")
            val c = text[at++]
            when {
                c == '"' -> return out.toString()
                c == '\\' -> out.append(parseEscape())
                c < ' ' -> fail("control character in a string")
                else -> out.append(c)
            }
        }
    }

    private fun parseEscape(): Char {
        if (at >= text.length) fail("unterminated escape")
        return when (text[at++]) {
            '"' -> '"'
            '\\' -> '\\'
            '/' -> '/'
            'b' -> '\b'
            'f' -> '\u000C'
            'n' -> '\n'
            'r' -> '\r'
            't' -> '\t'
            'u' -> {
                if (at + 4 > text.length) fail("unterminated \\u escape")
                var code = 0
                repeat(4) {
                    val digit = Character.digit(text[at++], 16)
                    if (digit < 0) fail("bad \\u escape")
                    code = code * 16 + digit
                }
                code.toChar()
            }
            else -> fail("bad escape")
        }
    }

    private fun parseNumber(): JsonValue {
        val start = at
        if (peek() == '-') at++
        when (peek()) {
            '0' -> at++
            in '1'..'9' -> digits()
            else -> fail("bad number")
        }
        if (peek() == '.') { at++; if (peek() !in '0'..'9') fail("bad number"); digits() }
        if (peek() == 'e' || peek() == 'E') {
            at++
            if (peek() == '+' || peek() == '-') at++
            if (peek() !in '0'..'9') fail("bad number")
            digits()
        }
        return JsonNumber(text.substring(start, at).toDouble())
    }

    private fun digits() { while (peek() in '0'..'9') at++ }

    private fun literal(word: String, value: JsonValue): JsonValue {
        if (!text.startsWith(word, at)) fail("unexpected word")
        at += word.length
        return value
    }

    private fun skipSpace() {
        while (at < text.length) {
            val c = text[at]
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at++ else break
        }
    }

    private fun peek(): Char = if (at < text.length) text[at] else '\u0000'

    private fun fail(reason: String): Nothing = throw JsonException("Invalid JSON at $at: $reason")

    private companion object {
        const val MAX_DEPTH = 200
    }
}
