package com.wifibridge

object GatewayServiceState {
  @Volatile var running = false
  @Volatile var startedAtMillis = 0L
}
