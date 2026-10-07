(function (root, factory) {
  const exported = factory();
  if (typeof module === "object" && module.exports) module.exports = exported;
  else root.GatewayWebSocketClient = exported.GatewayWebSocketClient;
})(this, function () {
  "use strict";

  class GatewayWebSocketClient {
    constructor(options) {
      this.url = options.url;
      this.createSocket = options.createSocket;
      this.onOpen = options.onOpen || (() => {});
      this.onMessage = options.onMessage || (() => {});
      this.onClose = options.onClose || (() => {});
      this.log = options.log || (() => {});
      const schedule = options.setTimeout || setTimeout;
      const cancel = options.clearTimeout || clearTimeout;
      // Browser timer functions must not be invoked as methods of this client.
      // Some engines reject the client instance as an illegal Window receiver.
      this.schedule = (callback, delay) => schedule(callback, delay);
      this.cancel = timer => cancel(timer);
      this.retryDelays = options.retryDelays || [2000, 4000, 8000, 10000];
      this.socket = null;
      this.retryTimer = null;
      this.retryAttempt = 0;
      this.generation = 0;
      this.stopped = true;
    }

    start() {
      if (!this.stopped) return;
      this.stopped = false;
      this.connect();
    }

    stop() {
      this.stopped = true;
      this.generation += 1;
      this.cancel(this.retryTimer);
      this.retryTimer = null;
      if (this.socket && this.socket.readyState < 2) this.socket.close(1000, "Client stopping");
      this.socket = null;
    }

    connect() {
      if (this.stopped) return;
      this.cancel(this.retryTimer);
      this.retryTimer = null;
      const generation = ++this.generation;
      const socket = this.createSocket(this.url);
      this.socket = socket;

      socket.onopen = () => {
        if (this.stopped || generation !== this.generation) return;
        this.retryAttempt = 0;
        this.log("info", "[WS-CLIENT] OPEN");
        this.onOpen();
      };
      socket.onmessage = event => {
        if (this.stopped || generation !== this.generation) return;
        this.onMessage(event.data);
      };
      socket.onerror = () => {
        if (this.stopped || generation !== this.generation) return;
        this.log("error", "[WS-CLIENT] ERROR; awaiting CLOSE");
      };
      socket.onclose = event => {
        if (this.stopped || generation !== this.generation) return;
        this.socket = null;
        this.log("warn", `[WS-CLIENT] CLOSE code=${event.code} reason=${event.reason || "none"} clean=${Boolean(event.wasClean)}`);
        this.onClose(event);
        this.scheduleReconnect();
      };
    }

    scheduleReconnect() {
      if (this.stopped || this.retryTimer) return;
      const index = Math.min(this.retryAttempt, this.retryDelays.length - 1);
      const delay = this.retryDelays[index];
      this.retryAttempt += 1;
      this.log("info", `[WS-CLIENT] reconnect attempt ${this.retryAttempt} in ${delay}ms`);
      this.retryTimer = this.schedule(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    }
  }

  return {GatewayWebSocketClient};
});
