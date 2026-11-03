package com.wifibridge

import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL

data class BrewfatherResponse(val status: Int, val body: String, val retryAfter: String? = null)

class BrewfatherApiException(val code: Int, message: String, val retryAfter: String? = null) : Exception(message)

class BrewfatherClient {
  private val baseUrl = "https://api.brewfather.app/v2"

  fun get(path: String, credentials: BrewfatherCredentials): BrewfatherResponse {
    val cleanPath = if (path.startsWith('/')) path else "/$path"
    val connection = (URL("$baseUrl$cleanPath").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15_000
      readTimeout = 20_000
      setRequestProperty("Accept", "application/json")
      val token = Base64.encodeToString("${credentials.userId}:${credentials.apiKey}".toByteArray(), Base64.NO_WRAP)
      setRequestProperty("Authorization", "Basic $token")
    }
    return try {
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
      if (status !in 200..299) {
        val detail = when (status) { 401, 403 -> "Brewfather credentials or batches.read scope rejected"; 429 -> "Brewfather rate limit reached"; else -> "Brewfather API returned HTTP $status" }
        throw BrewfatherApiException(status, detail, connection.getHeaderField("Retry-After"))
      }
      BrewfatherResponse(status, body)
    } finally { connection.disconnect() }
  }
}
