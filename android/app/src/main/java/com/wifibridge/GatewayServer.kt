package com.wifibridge

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

data class GatewayHttpRequest(
    val id: String,
    val method: String,
    val path: String,
    val body: String,
)

private data class PendingHttpResponse(
    val latch: CountDownLatch = CountDownLatch(1),
    @Volatile var statusCode: Int = 500,
    @Volatile var body: String = "{\"error\":\"gateway_internal_error\"}",
)

class GatewayServer(
    private val context: Context,
    port: Int,
    private val onHttpRequest: (GatewayHttpRequest) -> Unit,
    private val onLog: (String, String) -> Unit,
    private val onClientCount: (Int) -> Unit,
) : NanoWSD("0.0.0.0", port) {
  val configuredPort: Int = port
  private val pendingResponses = ConcurrentHashMap<String, PendingHttpResponse>()
  private val sockets = ConcurrentHashMap.newKeySet<GatewaySocket>()
  private val heartbeatPolicy = WebSocketHeartbeatPolicy()
  private val heartbeatStarted = AtomicBoolean(false)
  private val heartbeatExecutor: ScheduledExecutorService =
      Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "GatewayWsHeartbeat").apply { isDaemon = true }
      }
  @Volatile private var snapshotJson = "{\"gateway\":{\"status\":\"online\"},\"grainfather\":{\"connectionState\":\"DISCONNECTED\"}}"

  val clientCount: Int
    get() = sockets.size

  val webSocketReadTimeoutMillis: Int
    get() = heartbeatPolicy.readTimeoutMillis

  override fun start(timeout: Int, daemon: Boolean) {
    super.start(timeout, daemon)
    if (heartbeatStarted.compareAndSet(false, true)) {
      heartbeatExecutor.scheduleAtFixedRate(
          ::sendHeartbeats,
          heartbeatPolicy.pingIntervalMillis,
          heartbeatPolicy.pingIntervalMillis,
          TimeUnit.MILLISECONDS,
      )
    }
    onLog("GATEWAY", "HTTP/WebSocket server started on 0.0.0.0:$configuredPort; " +
        "WS ping=${heartbeatPolicy.pingIntervalMillis}ms readTimeout=${heartbeatPolicy.readTimeoutMillis}ms")
  }

  override fun stop() {
    heartbeatExecutor.shutdownNow()
    sockets.forEach { socket ->
      try {
        socket.close(
            WebSocketFrame.CloseCode.GoingAway,
            "Gateway stopping",
            false,
        )
      } catch (_: IOException) {
      }
    }
    sockets.clear()
    pendingResponses.values.forEach { it.latch.countDown() }
    pendingResponses.clear()
    super.stop()
    onLog("GATEWAY", "HTTP/WebSocket server stopped")
  }

  fun updateSnapshot(json: String) {
    if (json == snapshotJson) return
    snapshotJson = json
    var delivered = 0
    sockets.toList().forEach { socket ->
      try {
        socket.send(json)
        delivered += 1
      } catch (error: IOException) {
        sockets.remove(socket)
        onLog("WS", "[WS-SERVER] ERROR state-send ${error.javaClass.simpleName}: ${error.message ?: "no detail"}")
      }
    }
    if (delivered > 0) onLog("WS", "State broadcast to $delivered client(s)")
    publishClientCount()
  }

  fun respond(requestId: String, statusCode: Int, body: String) {
    pendingResponses[requestId]?.let { pending ->
      pending.statusCode = statusCode
      pending.body = body
      pending.latch.countDown()
    }
  }

  override fun serveHttp(session: IHTTPSession): Response {
    val path = session.uri.substringBefore('?')
    if (path.startsWith("/api/v1/")) return serveApi(session, path)
    if (session.method != Method.GET) {
      return jsonResponse(405, "{\"error\":\"method_not_allowed\"}")
    }
    return serveAsset(path)
  }

  override fun openWebSocket(handshake: IHTTPSession): WebSocket {
    return GatewaySocket(handshake)
  }

  private fun serveApi(session: IHTTPSession, path: String): Response {
    val body = if (session.method == Method.POST) readBody(session) else ""
    val id = UUID.randomUUID().toString()
    val pending = PendingHttpResponse()
    pendingResponses[id] = pending
    val requestPath = session.queryParameterString
        ?.takeIf { it.isNotBlank() }
        ?.let { "$path?$it" }
        ?: path
    onLog("HTTP", "${session.method.name} $requestPath")
    onHttpRequest(GatewayHttpRequest(id, session.method.name, requestPath, body))
    val completed = pending.latch.await(45, TimeUnit.SECONDS)
    pendingResponses.remove(id)
    return if (completed) {
      jsonResponse(pending.statusCode, pending.body)
    } else {
      jsonResponse(504, "{\"error\":\"gateway_request_timeout\"}")
    }
  }

  private fun readBody(session: IHTTPSession): String {
    val files = HashMap<String, String>()
    return try {
      session.parseBody(files)
      files["postData"] ?: ""
    } catch (_: Exception) {
      ""
    }
  }

  private fun serveAsset(path: String): Response {
    val asset = when (path) {
      "/", "/index.html" -> "gateway/index.html"
      "/app.js" -> "gateway/app.js"
      "/ws-client.js" -> "gateway/ws-client.js"
      "/styles.css" -> "gateway/styles.css"
      else -> return jsonResponse(404, "{\"error\":\"not_found\"}")
    }
    val mime = when {
      asset.endsWith(".html") -> "text/html; charset=utf-8"
      asset.endsWith(".js") -> "application/javascript; charset=utf-8"
      else -> "text/css; charset=utf-8"
    }
    return try {
      val bytes = context.assets.open(asset).use { it.readBytes() }
      NanoHTTPD.newFixedLengthResponse(
          Response.Status.OK,
          mime,
          bytes.inputStream(),
          bytes.size.toLong(),
      ).apply { addHeader("Cache-Control", "no-cache") }
    } catch (_: IOException) {
      jsonResponse(500, "{\"error\":\"web_asset_unavailable\"}")
    }
  }

  private fun jsonResponse(statusCode: Int, body: String): Response {
    val status: Response.IStatus = when (statusCode) {
      200 -> Response.Status.OK
      204 -> Response.Status.NO_CONTENT
      201 -> Response.Status.CREATED
      202 -> Response.Status.ACCEPTED
      400 -> Response.Status.BAD_REQUEST
      404 -> Response.Status.NOT_FOUND
      405 -> Response.Status.METHOD_NOT_ALLOWED
      409 -> Response.Status.CONFLICT
      504 -> object : Response.IStatus {
        override fun getRequestStatus(): Int = 504
        override fun getDescription(): String = "504 Gateway Timeout"
      }
      else -> Response.Status.INTERNAL_ERROR
    }
    return NanoHTTPD.newFixedLengthResponse(
        status,
        "application/json; charset=utf-8",
        body,
    ).apply { addHeader("Cache-Control", "no-store") }
  }

  private fun publishClientCount() {
    onClientCount(sockets.size)
  }

  private fun sendHeartbeats() {
    sockets.toList().forEach { socket ->
      try {
        socket.sendHeartbeat()
      } catch (error: IOException) {
        sockets.remove(socket)
        onLog("WS", "[WS-SERVER] ERROR ping ${error.javaClass.simpleName}: ${error.message ?: "no detail"}")
      }
    }
    publishClientCount()
  }

  private inner class GatewaySocket(handshake: IHTTPSession) : WebSocket(handshake) {
    private val requestedPath = handshake.uri
    private val heartbeatSequence = AtomicLong(0)

    override fun onOpen() {
      if (requestedPath != "/api/v1/ws") {
        close(WebSocketFrame.CloseCode.PolicyViolation, "Unknown WebSocket endpoint", false)
        return
      }
      sockets.add(this)
      onLog("WS", "[WS-SERVER] OPEN path=$requestedPath clients=${sockets.size}")
      publishClientCount()
      try {
        send(snapshotJson)
      } catch (error: IOException) {
        onException(error)
      }
    }

    override fun onClose(
        code: WebSocketFrame.CloseCode,
        reason: String,
        initiatedByRemote: Boolean,
    ) {
      sockets.remove(this)
      onLog("WS", "[WS-SERVER] CLOSE code=$code reason=${reason.ifBlank { "none" }} remote=$initiatedByRemote")
      publishClientCount()
    }

    override fun onMessage(message: WebSocketFrame) {
      // The WebSocket is server-to-client state only. Commands use HTTP.
      onLog("WS", "[WS-SERVER] MESSAGE ignored opcode=${message.opCode}")
    }

    override fun onPong(pong: WebSocketFrame) {
      val sequence = heartbeatSequence.get()
      if (heartbeatPolicy.shouldLog(sequence)) {
        onLog("WS", "[WS-SERVER] PONG sequence=$sequence")
      }
    }

    override fun onException(exception: IOException) {
      sockets.remove(this)
      onLog("WS", "[WS-SERVER] ERROR ${exception.javaClass.simpleName}: ${exception.message ?: "no detail"}")
      publishClientCount()
    }

    @Throws(IOException::class)
    fun sendHeartbeat() {
      if (!isOpen) return
      val sequence = heartbeatSequence.incrementAndGet()
      ping("gateway:$sequence".toByteArray(Charsets.UTF_8))
      if (heartbeatPolicy.shouldLog(sequence)) {
        onLog("WS", "[WS-SERVER] PING sequence=$sequence")
      }
    }
  }
}
