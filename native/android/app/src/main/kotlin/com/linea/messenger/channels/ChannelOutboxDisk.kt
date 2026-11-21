package com.linea.messenger.channels

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** The channel messages waiting for a connection, kept on this device per account so they survive a restart — the same
 *  records and keys as the reference (`mobile/src/communities/channelOutbox.ts`: `linea.channel-outbox.v1:<user>` for the
 *  queue, `…:failed` for what the server refused for good, at most 20; iOS Channels/ChannelOutboxDisk.swift). Anything
 *  malformed is dropped. Channel messages are not end-to-end encrypted (the server keeps them), so they are kept as plain
 *  JSON like there, in the app's own private preferences. */
object ChannelOutboxDisk {
  private const val PREFIX = "linea.channel-outbox.v1"
  /** Where the records are kept; null (the JVM rules' check) keeps nothing. */
  var store: SharedPreferences? = null

  fun attach(context: Context) { if (store == null) store = context.applicationContext.getSharedPreferences("linea.channels", Context.MODE_PRIVATE) }

  fun load(userId: String): Pair<List<ChannelOutbox.Item>, List<ChannelOutbox.Refused>> {
    val kept = store ?: return emptyList<ChannelOutbox.Item>() to emptyList()
    val waiting = parse(kept.getString("$PREFIX:$userId", null))
    val refused = ArrayList<ChannelOutbox.Refused>()
    try {
      val list = JSONArray(kept.getString("$PREFIX:$userId:failed", null) ?: "[]")
      for (index in 0 until list.length()) {
        val entry = list.optJSONObject(index) ?: continue
        val item = item(entry.optJSONObject("item") ?: continue) ?: continue
        if (refused.any { it.item.key == item.key }) continue
        val words = entry.optString("error", "")
        refused.add(ChannelOutbox.Refused(item, words.ifEmpty { "Не удалось отправить." }))
      }
    } catch (_: Exception) {}
    return waiting.take(ChannelOutbox.limit) to refused.takeLast(20)
  }

  fun save(userId: String, waiting: List<ChannelOutbox.Item>, refused: List<ChannelOutbox.Refused>) {
    val kept = store ?: return
    val now = Instant.now().toString()
    val queue = JSONArray().apply { for (item in waiting) put(fields(item, now)) }
    val failed = JSONArray().apply { for (entry in refused) put(JSONObject().put("item", fields(entry.item, now)).put("error", entry.words).put("failedAt", now)) }
    kept.edit().apply {
      if (queue.length() == 0) remove("$PREFIX:$userId") else putString("$PREFIX:$userId", queue.toString())
      if (failed.length() == 0) remove("$PREFIX:$userId:failed") else putString("$PREFIX:$userId:failed", failed.toString())
    }.apply()
  }

  private fun fields(item: ChannelOutbox.Item, now: String): JSONObject {
    val out = JSONObject().put("key", item.key).put("communityId", item.communityId).put("channelId", item.channelId).put("text", item.text).put("createdAt", now)
    if (item.replyTo != 0L) out.put("replyTo", item.replyTo)
    return out
  }

  private fun item(fields: JSONObject): ChannelOutbox.Item? {
    val key = fields.opt("key") as? String ?: return null
    if (key.isEmpty() || key.length > 64) return null
    val community = fields.opt("communityId") as? String ?: return null
    val channel = fields.opt("channelId") as? String ?: return null
    val text = fields.opt("text") as? String ?: return null
    if (text.isBlank()) return null
    val reply = (fields.opt("replyTo") as? Number)?.toLong() ?: 0L
    return ChannelOutbox.Item(key, community, channel, text, reply)
  }

  fun parse(raw: String?): List<ChannelOutbox.Item> {
    if (raw.isNullOrEmpty()) return emptyList()
    val list = try { JSONArray(raw) } catch (_: Exception) { return emptyList() }
    val seen = HashSet<String>()
    val out = ArrayList<ChannelOutbox.Item>()
    for (index in 0 until list.length()) {
      val made = item(list.optJSONObject(index) ?: continue) ?: continue
      if (!seen.add(made.key)) continue
      out.add(made)
    }
    return out
  }
}
