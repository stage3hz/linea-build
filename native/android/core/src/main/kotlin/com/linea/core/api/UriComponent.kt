package com.linea.core.api

/** JavaScript's `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8 percent escapes. */
fun encodeUriComponent(value: String): String {
    val out = StringBuilder(value.length)
    var i = 0
    while (i < value.length) {
        val c = value[i]
        if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in "-_.!~*'()") {
            out.append(c)
            i++
            continue
        }
        val codePoint = value.codePointAt(i)
        require(!(Character.charCount(codePoint) == 1 && Character.isSurrogate(c))) { "URI malformed" }
        for (byte in String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8)) out.append('%').append("%02X".format(byte))
        i += Character.charCount(codePoint)
    }
    return out.toString()
}
