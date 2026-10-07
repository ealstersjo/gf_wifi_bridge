package com.wifibridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.net.Inet4Address
import org.json.JSONObject
import java.lang.ref.WeakReference

class GatewayModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private var server: GatewayServer? = null
  private var listenerCount = 0
  private val sessionStoreDelegate = lazy { BrewSessionStore(reactContext.applicationContext) }
  private val sessionStore by sessionStoreDelegate

  init {
    moduleReference = WeakReference(this)
  }

  override fun getName(): String = "GatewayServer"

  @ReactMethod
  fun start(port: Double, promise: Promise) {
    val requestedPort = port.toInt()
    try {
      if (server == null) {
        server = GatewayServer(
            context = reactContext.applicationContext,
            port = requestedPort,
            onHttpRequest = ::emitHttpRequest,
            onLog = ::emitLog,
            onClientCount = ::emitClientCount,
        ).also { server ->
          server.start(server.webSocketReadTimeoutMillis, false)
        }
      }
      promise.resolve(statusMap())
    } catch (error: Exception) {
      server?.stop()
      server = null
      promise.reject("gateway_start_failed", "Unable to start gateway server", error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    server?.stop()
    server = null
    promise.resolve(null)
  }

  @ReactMethod
  fun updateSnapshot(snapshotJson: String) {
    server?.updateSnapshot(snapshotJson)
    GatewayForegroundService.updateFromSnapshot(reactContext.applicationContext, snapshotJson)
  }

  @ReactMethod
  fun respond(requestId: String, statusCode: Double, bodyJson: String) {
    server?.respond(requestId, statusCode.toInt(), bodyJson)
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    promise.resolve(statusMap())
  }

  @ReactMethod
  fun startGatewayService(promise: Promise) {
    GatewayForegroundService.start(reactContext.applicationContext)
    promise.resolve(serviceStatusMap())
  }

  @ReactMethod
  fun stopGatewayService(promise: Promise) {
    GatewayForegroundService.stop(reactContext.applicationContext)
    promise.resolve(null)
  }

  @ReactMethod
  fun getGatewayServiceStatus(promise: Promise) {
    promise.resolve(serviceStatusMap())
  }

  @ReactMethod
  fun sessionStore(operation: String, payloadJson: String, promise: Promise) {
    try {
      promise.resolve(sessionStore.execute(operation, JSONObject(payloadJson)))
    } catch (error: Exception) {
      promise.reject("session_store_failed", error.message ?: "Session storage failed", error)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
    listenerCount += 1
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    listenerCount = maxOf(0, listenerCount - count.toInt())
  }

  override fun invalidate() {
    server?.stop()
    server = null
    if (sessionStoreDelegate.isInitialized()) sessionStore.close()
    super.invalidate()
  }

  private fun statusMap() = Arguments.createMap().apply {
    putBoolean("running", server?.wasStarted() == true)
    putInt("port", server?.configuredPort ?: 8080)
    putString("localIp", localIpv4Address())
    putInt("webSocketClients", server?.clientCount ?: 0)
    putBoolean("serviceRunning", GatewayServiceState.running)
    putDouble("serviceStartedAt", GatewayServiceState.startedAtMillis.toDouble())
  }

  private fun serviceStatusMap() = Arguments.createMap().apply {
    putBoolean("running", GatewayServiceState.running)
    putDouble("startedAt", GatewayServiceState.startedAtMillis.toDouble())
  }

  private fun localIpv4Address(): String? {
    val manager = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE)
        as ConnectivityManager
    val wifiNetwork = manager.allNetworks.firstOrNull { network ->
      manager.getNetworkCapabilities(network)
          ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }
    val candidates = listOfNotNull(wifiNetwork, manager.activeNetwork).distinct()
    return candidates.firstNotNullOfOrNull { network ->
      manager.getLinkProperties(network)
          ?.linkAddresses
          ?.map { it.address }
          ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
          ?.hostAddress
    }
  }

  private fun emitHttpRequest(request: GatewayHttpRequest) {
    val payload = Arguments.createMap().apply {
      putString("id", request.id)
      putString("method", request.method)
      putString("path", request.path)
      putString("body", request.body)
    }
    emit("GatewayHttpRequest", payload)
  }

  private fun emitLog(category: String, message: String) {
    val payload = Arguments.createMap().apply {
      putString("category", category)
      putString("message", message)
    }
    emit("GatewayLog", payload)
  }

  private fun emitClientCount(count: Int) {
    emit("GatewayClientCount", count)
  }

  private fun emit(eventName: String, payload: Any) {
    if (listenerCount <= 0 || !reactContext.hasActiveReactInstance()) return
    reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, payload)
  }

  companion object {
    private var moduleReference = WeakReference<GatewayModule>(null)

    fun emitServiceCommand(command: String) {
      moduleReference.get()?.emit("GatewayServiceCommand", command)
    }
  }
}
