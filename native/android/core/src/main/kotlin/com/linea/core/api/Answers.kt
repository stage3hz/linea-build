package com.linea.core.api

import com.linea.core.model.ClaimedBundle
import com.linea.core.model.CryptoDevice
import com.linea.core.model.Message
import com.linea.core.model.User

data class MeAnswer(val user: User, val securitySetupRequired: Boolean)

data class MessagesPage(val messages: List<Message>, val hasMore: Boolean)

/** A page of this device's encrypted inbox for a chat; [nextCursor] is the `after` of the next page. */
data class InboxPage(val messages: List<Message>, val nextCursor: Long, val hasMore: Boolean)

data class ReadAnswer(val ok: Boolean, val lastReadMessageId: Long)

data class RegisteredDevice(val device: CryptoDevice, val preKeyCount: Int)

data class ClaimedPreKey(val device: CryptoDevice, val bundle: ClaimedBundle)

/** What the recipient's phone shows for a message: `CALL` rings, `NONE` is for reactions and edits. */
enum class PushKind(val wire: String) { MESSAGE("message"), CALL("call"), MISSED("missed"), NONE("none"), SILENT("silent") }
