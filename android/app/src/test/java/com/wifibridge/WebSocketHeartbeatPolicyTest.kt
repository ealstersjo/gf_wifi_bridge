package com.wifibridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSocketHeartbeatPolicyTest {
  @Test
  fun pingArrivesBeforeTransportReadTimeout() {
    val policy = WebSocketHeartbeatPolicy()
    assertTrue(policy.pingIntervalMillis < policy.readTimeoutMillis)
    assertTrue(policy.pingIntervalMillis * 2 < policy.readTimeoutMillis)
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsHeartbeatThatCannotKeepSocketAlive() {
    WebSocketHeartbeatPolicy(pingIntervalMillis = 30_000, readTimeoutMillis = 30_000)
  }

  @Test
  fun diagnosticHeartbeatLoggingIsThrottled() {
    val policy = WebSocketHeartbeatPolicy(diagnosticLogEvery = 6)
    assertTrue(policy.shouldLog(1))
    assertFalse(policy.shouldLog(2))
    assertTrue(policy.shouldLog(6))
  }
}
