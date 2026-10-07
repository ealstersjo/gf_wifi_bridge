package com.wifibridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.facebook.react.ReactApplication
import org.json.JSONObject

class GatewayForegroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    Log.i(LOG_TAG, "[SERVICE] GatewayForegroundService created")
    GatewayServiceState.running = true
    if (GatewayServiceState.startedAtMillis == 0L) GatewayServiceState.startedAtMillis = System.currentTimeMillis()
    createChannel()
    Log.i(LOG_TAG, "[SERVICE] Starting foreground")
    startInForeground("Gateway starting • G30 disconnected")
    acquireCpuWakeLock()
    Thread {
      val host = checkNotNull((application as ReactApplication).reactHost)
      val task = host.start()
      task.waitForCompletion()
      if (task.isFaulted()) {
        Log.e(LOG_TAG, "[SERVICE] React runtime failed to start")
        updateNotification("Gateway runtime error")
      } else {
        Log.i(LOG_TAG, "[SERVICE] React runtime available")
        GatewayModule.emitServiceCommand("START")
        updateNotification("Gateway running • G30 disconnected")
      }
    }.start()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (flags and START_FLAG_RETRY != 0 || flags and START_FLAG_REDELIVERY != 0) {
      Log.i(LOG_TAG, "[SERVICE] Service restart requested by Android")
    }
    if (intent?.action == ACTION_STOP) {
      GatewayModule.emitServiceCommand("STOP")
      stopSelf()
      return START_NOT_STICKY
    }
    GatewayModule.emitServiceCommand("START")
    return START_STICKY
  }

  override fun onDestroy() {
    Log.i(LOG_TAG, "[SERVICE] GatewayForegroundService destroyed")
    GatewayModule.emitServiceCommand("STOP")
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    GatewayServiceState.running = false
    GatewayServiceState.startedAtMillis = 0L
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "Grainfather Gateway", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps the local Grainfather Wi-Fi and Bluetooth gateway running"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
  }

  private fun startInForeground(text: String) {
    ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        buildNotification(this, text),
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0,
    )
  }

  private fun updateNotification(text: String) {
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(this, text))
  }

  private fun acquireCpuWakeLock() {
    val powerManager = getSystemService(POWER_SERVICE) as PowerManager
    wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:GatewayRuntime").apply {
      setReferenceCounted(false)
      acquire()
    }
    Log.i(LOG_TAG, "[SERVICE] Partial CPU wake lock acquired")
  }

  companion object {
    private const val CHANNEL_ID = "grainfather_gateway"
    private const val LOG_TAG = "GatewayService"
    private const val NOTIFICATION_ID = 3010
    private const val ACTION_STOP = "com.wifibridge.STOP_GATEWAY"
    @Volatile private var lastNotificationAt = 0L
    @Volatile private var lastConnected: Boolean? = null

    fun start(context: Context) {
      val intent = Intent(context, GatewayForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, GatewayForegroundService::class.java))
    }

    fun updateFromSnapshot(context: Context, snapshotJson: String) {
      if (!GatewayServiceState.running) return
      try {
        val grainfather = JSONObject(snapshotJson).optJSONObject("grainfather")
        val connected = grainfather?.optString("connectionState") == "CONNECTED"
        val now = System.currentTimeMillis()
        if (lastConnected == connected && now - lastNotificationAt < 30_000) return
        val actual = grainfather?.optDouble("actualTemperatureC", Double.NaN)
        val target = grainfather?.optDouble("targetTemperatureC", Double.NaN)
        val status = if (!connected) "Gateway running • G30 disconnected" else {
          val temperatures = if (actual?.isFinite() == true && target?.isFinite() == true) " • %.1f°C → %.1f°C".format(actual, target) else ""
          "Gateway running • G30 connected$temperatures"
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(context, status))
        lastConnected = connected
        lastNotificationAt = now
      } catch (_: Exception) {
      }
    }

    private fun buildNotification(context: Context, text: String) = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Grainfather Gateway")
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .build()
  }
}
