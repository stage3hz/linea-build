package com.linea.core.api

import com.linea.core.model.PublicBundle

/** The four server calls the encryption core makes (the `CryptoTransport` of e2ee/core.ts). [Api] implements it. */
interface CryptoTransport {
    suspend fun registerCryptoDevice(deviceId: String, bundle: PublicBundle): RegisteredDevice
    suspend fun cryptoDevices(userId: String): List<com.linea.core.model.CryptoDevice>
    suspend fun claimPreKey(userId: String, deviceId: String): ClaimedPreKey
    suspend fun cryptoInbox(deviceId: String, chatId: String, after: Long): InboxPage
}
