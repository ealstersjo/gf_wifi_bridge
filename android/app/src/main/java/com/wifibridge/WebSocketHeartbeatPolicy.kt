package com.wifibridge

data class WebSocketHeartbeatPolicy(
    val pingIntervalMillis: Long = 10_000,
    val readTimeoutMillis: Int = 30_000,
    val diagnosticLogEvery: Long = 6,
) {
  init {
    require(pingIntervalMillis > 0)
    require(readTimeoutMillis > pingIntervalMillis)
    require(diagnosticLogEvery > 0)
  }

  fun shouldLog(sequence: Long): Boolean =
      sequence == 1L || sequence % diagnosticLogEvery == 0L
}
