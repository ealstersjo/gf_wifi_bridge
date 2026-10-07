package com.wifibridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class GatewayBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      Log.i("GatewayService", "[SERVICE] ${intent.action}; starting gateway service")
      GatewayForegroundService.start(context)
    }
  }
}
