package com.wifibridge

import android.content.Context
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class BrewfatherCredentials(val userId: String, val apiKey: String)

class BrewfatherSecureStore(context: Context) {
  private val prefs = context.getSharedPreferences("brewfather_secure", Context.MODE_PRIVATE)
  private val alias = "wifibridge_brewfather_credentials"

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = store.getKey(alias, null) as? SecretKey
    if (existing != null) return existing
    val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
    generator.init(android.security.keystore.KeyGenParameterSpec.Builder(
      alias,
      android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
    ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
      .build())
    return generator.generateKey()
  }

  fun save(credentials: BrewfatherCredentials) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.doFinal("${credentials.userId}\u0000${credentials.apiKey}".toByteArray())
    val payload = ByteBuffer.allocate(4 + cipher.iv.size + encrypted.size)
    payload.putInt(cipher.iv.size).put(cipher.iv).put(encrypted)
    prefs.edit().putString("payload", Base64.encodeToString(payload.array(), Base64.NO_WRAP)).apply()
  }

  fun read(): BrewfatherCredentials? {
    val encoded = prefs.getString("payload", null) ?: return null
    return runCatching {
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      val buffer = ByteBuffer.wrap(bytes)
      val iv = ByteArray(buffer.int).also(buffer::get)
      val encrypted = ByteArray(buffer.remaining()).also(buffer::get)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
      val parts = String(cipher.doFinal(encrypted)).split('\u0000', limit = 2)
      if (parts.size != 2 || parts[0].isBlank() || parts[1].isBlank()) null else BrewfatherCredentials(parts[0], parts[1])
    }.getOrNull()
  }

  fun clear() { prefs.edit().remove("payload").apply() }
  fun hasCredentials(): Boolean = prefs.contains("payload") && read() != null
}
