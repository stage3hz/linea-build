package com.linea.messenger.attachments

import com.linea.messenger.core.Core

/** The shared core's part about files attached to encrypted messages (native/core/src/e2ee/files.rs), as Kotlin
 *  sees it: the key of a new file, sealing before the upload, opening after the download, the object that
 *  travels inside the message. Nothing here is logged; keys and file bytes only pass through.
 *  The functions on the core's side are in native/core/src/jni.rs (`…_attachments_FileCore_…`). */
object FileCore {
  /** Why a step on a file did not give its answer: the words for the person. */
  class Failure(val words: String) : Exception()

  /** One of the core's file functions by name (`invizent_file_call`): `argsJson` is a JSON array, the answer JSON. */
  @JvmStatic external fun fileCall(name: String, argsJson: String): String?

  /** `invizent_file_seal`: the ciphertext with its tag (`ByteArray`), or the words of the refusal (`String`). */
  @JvmStatic external fun fileSeal(plain: ByteArray, encryptionJson: String): Any?

  /** `invizent_file_open`: the file (`ByteArray`), or the words of the refusal (`String`). */
  @JvmStatic external fun fileOpen(cipher: ByteArray, attachmentJson: String): Any?

  /** `invizent_file_clean_jpeg`: the picture alone (`ByteArray`), or the words of the refusal (`String`). */
  @JvmStatic external fun fileCleanJpeg(jpeg: ByteArray): Any?

  /** One of the core's file functions by name (see `invizent_file_call`); null when it has no answer (or the
   *  library is missing, or is an older one without it). */
  fun call(name: String, args: List<Any?> = emptyList()): Any? {
    if (!Core.loaded) return null
    val argsText = Core.text(args) ?: return null
    return try { Core.value(fileCall(name, argsText)) } catch (_: UnsatisfiedLinkError) { null }
  }

  private val failed = Failure("Не удалось обработать файл.")

  /** Hands bytes (and a JSON value) to the core and takes its bytes back. */
  private fun run(json: Any?, step: (String) -> Any?): Result<ByteArray> {
    if (!Core.loaded) return Result.failure(failed)
    val jsonText = if (json == null) "" else Core.text(json) ?: return Result.failure(failed)
    val answer = try { step(jsonText) } catch (_: UnsatisfiedLinkError) { null }
    return when (answer) {
      is ByteArray -> Result.success(answer)
      is String -> Result.failure(Failure(answer))
      else -> Result.failure(failed)
    }
  }

  /** Seals a file's bytes with the key `call("newEncryption")` gave: the ciphertext with its tag. */
  fun seal(plain: ByteArray, encryption: Map<String, Any?>): Result<ByteArray> = run(encryption) { fileSeal(plain, it) }

  /** Opens a downloaded file with the key from its message; a wrong size or one changed byte is refused. */
  fun open(cipher: ByteArray, attachment: Map<String, Any?>): Result<ByteArray> = run(attachment) { fileOpen(cipher, it) }

  /** A JPEG as the reference's gate lets it out: the picture only. */
  fun cleanJpeg(jpeg: ByteArray): Result<ByteArray> = run(null) { fileCleanJpeg(jpeg) }

  /** The words of a failed step (a failure that is not this file's reads as «could not be processed»). */
  fun words(result: Result<*>): String = (result.exceptionOrNull() as? Failure)?.words ?: failed.words

  /** How an attachment is shown and whether it can be opened here. */
  class Description(val kind: String, val fileName: String, val sizeText: String, val cipherSize: Int?, val refusal: String?)

  fun describe(attachment: Map<String, Any?>): Description {
    // The small picture is not needed for this, and it is the biggest part of the object.
    val made = Core.map(call("describe", listOf(attachment - "preview"))) ?: emptyMap()
    return Description(made["kind"] as? String ?: "file", made["fileName"] as? String ?: "file", made["sizeText"] as? String ?: "",
      (made["cipherSize"] as? Number)?.toInt(), made["refusal"] as? String)
  }

  fun sizeText(bytes: Long): String = call("sizeText", listOf(maxOf(0L, bytes))) as? String ?: ""
}
