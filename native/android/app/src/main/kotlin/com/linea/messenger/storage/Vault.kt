package com.linea.messenger.storage

import android.content.Context
import net.zetetic.database.DatabaseErrorHandler
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale

/** The private storage of one account on this device: an SQLCipher database whose key lives in the keystore.
 *  Everything the encryption needs is here — the Signal state, who is trusted, decrypted messages.
 *
 *  The file, its table and the key's name are those of the previous app (expo-sqlite with SQLCipher:
 *  `files/SQLite/linea-e2ee-<scope>.db`), so an update opens the storage that is already on the phone. A lost
 *  or damaged key never silently makes a new identity: opening fails and the database stays as it was.
 *
 *  One connection, used by one thread at a time (the encryption service's own). */
class Vault(context: Context, server: String, userId: String, earlierServers: List<String> = emptyList()) {
  class Failure(val kind: Kind) : Exception(kind.name)
  enum class Kind {
    /** The build has no SQLCipher: keys are never kept unencrypted. */
    NO_CIPHER,
    BAD_KEY,
    /** The database could not be opened with the key; nothing was changed. */
    CANNOT_OPEN,
    CLOSED,
    WRITE,
  }

  private var db: SQLiteDatabase? = null

  init {
    try {
      val app = context.applicationContext
      var scope = scope(server, userId)
      var key = Keystore.get(app, keyName(scope))
      if (key == null) {
        for (earlier in earlierServers) {
          if (earlier == server) continue
          val candidate = scope(earlier, userId)
          val found = Keystore.get(app, keyName(candidate))
          if (found != null) { scope = candidate; key = found; break }
        }
      }
      val folder = File(app.filesDir, "SQLite")
      if (!folder.isDirectory && !folder.mkdirs()) throw Failure(Kind.CANNOT_OPEN)
      val file = File(folder, "linea-e2ee-$scope.db")
      try { System.loadLibrary("sqlcipher") } catch (_: UnsatisfiedLinkError) { throw Failure(Kind.NO_CIPHER) }
      if (key != null) {
        if (!Regex("^[a-f0-9]{64}$").matches(key)) throw Failure(Kind.BAD_KEY)
        db = open(file, key)
      } else {
        val existed = file.exists()
        val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { String.format(Locale.ROOT, "%02x", it.toInt() and 0xFF) }
        // If an encrypted database is already there and its key is lost, opening reads it and fails: the
        // database is left intact instead of being written over.
        db = open(file, fresh)
        try {
          Keystore.set(app, keyName(scope), fresh)
        } catch (error: Exception) {
          // The key could not be kept. A database made a moment ago and still empty is taken away, so the next
          // try starts clean; one that was there before is never touched.
          close()
          if (!existed) SQLiteDatabase.deleteDatabase(file)
          throw error
        }
      }
      if (text("PRAGMA cipher_version").isNullOrEmpty()) throw Failure(Kind.NO_CIPHER)
      // The library opens a database with its own choice of journal; the storage's own follows, on the one connection.
      text("PRAGMA journal_mode = WAL")
      run("PRAGMA synchronous = FULL")
      text("PRAGMA secure_delete = ON")
      run("CREATE TABLE IF NOT EXISTS private_values (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    } catch (failure: Failure) {
      close()
      throw if (failure.kind == Kind.NO_CIPHER || failure.kind == Kind.BAD_KEY) failure else Failure(Kind.CANNOT_OPEN)
    } catch (_: Exception) {
      close()
      throw Failure(Kind.CANNOT_OPEN)
    }
  }

  /** Opens (or makes) the file with a raw key; the library reads the database once to see that the key fits. */
  private fun open(file: File, key: String): SQLiteDatabase =
    SQLiteDatabase.openOrCreateDatabase(file, "x'$key'".toByteArray(Charsets.US_ASCII), null, keepFile, null)

  fun close() {
    try { db?.close() } catch (_: Exception) {}
    db = null
  }

  private fun run(sql: String, arguments: Array<Any?> = emptyArray()) {
    val db = db ?: throw Failure(Kind.CLOSED)
    try { db.execSQL(sql, arguments) } catch (_: Exception) { throw Failure(Kind.WRITE) }
  }

  /** The first column of the first row of a query, as text. */
  private fun text(sql: String, arguments: Array<String> = emptyArray()): String? {
    val db = db ?: throw Failure(Kind.CLOSED)
    try {
      db.rawQuery(sql, arguments).use { rows -> return if (rows.moveToFirst() && !rows.isNull(0)) rows.getString(0) else null }
    } catch (_: Exception) { throw Failure(Kind.WRITE) }
  }

  fun get(name: String): String? = text("SELECT value FROM private_values WHERE key = ?", arrayOf(name))

  /** Writes every change or none. A null value removes the record. */
  fun commit(changes: List<Pair<String, String?>>) {
    val db = db ?: throw Failure(Kind.CLOSED)
    try {
      // BEGIN IMMEDIATE … COMMIT; anything thrown in between rolls all of it back.
      db.beginTransactionNonExclusive()
      try {
        for ((name, value) in changes) {
          if (value != null) db.execSQL("INSERT INTO private_values (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arrayOf<Any?>(name, value))
          else db.execSQL("DELETE FROM private_values WHERE key = ?", arrayOf<Any?>(name))
        }
        db.setTransactionSuccessful()
      } finally {
        db.endTransaction()
      }
    } catch (_: Exception) { throw Failure(Kind.WRITE) }
  }

  companion object {
    /** `server\u0000user` hashed: what the files and the key of one account on one server are named by. */
    fun scope(server: String, userId: String): String =
      MessageDigest.getInstance("SHA-256").digest("$server\u0000$userId".toByteArray(Charsets.UTF_8)).joinToString("") { String.format(Locale.ROOT, "%02x", it.toInt() and 0xFF) }

    fun keyName(scope: String) = "linea.e2ee.v1.$scope"

    /** A database that cannot be read is never deleted here, whatever the library's own habit is. */
    private val keepFile = DatabaseErrorHandler { _, _ -> }
  }
}
