const {GatewayWebSocketClient} = require('../ws-client');

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.close = jest.fn((code = 1000, reason = '') => {
      this.readyState = 3;
      this.onclose?.({code, reason, wasClean: code === 1000});
    });
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  message(value) {
    this.onmessage?.({data: JSON.stringify(value)});
  }

  lose(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({code, reason, wasClean: false});
  }
}

describe('GatewayWebSocketClient', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup() {
    const sockets = [];
    const messages = [];
    const states = [];
    const logs = [];
    const client = new GatewayWebSocketClient({
      url: 'ws://gateway/api/v1/ws',
      createSocket: url => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      onOpen: () => states.push('ONLINE'),
      onClose: () => states.push('RECONNECTING'),
      onMessage: value => messages.push(JSON.parse(value)),
      log: (_, message) => logs.push(message),
      retryDelays: [2000, 4000],
    });
    client.start();
    return {client, sockets, messages, states, logs};
  }

  it('stays online indefinitely with a disconnected G30 and no state updates', () => {
    const test = setup();
    test.sockets[0].open();
    test.sockets[0].message({gateway: {status: 'online'}, grainfather: {connectionState: 'DISCONNECTED', stale: true}});
    jest.advanceTimersByTime(3_600_000);
    expect(test.states).toEqual(['ONLINE']);
    expect(test.sockets).toHaveLength(1);
    expect(test.sockets[0].close).not.toHaveBeenCalled();
  });

  it('does not confuse stale G30 data with gateway connectivity', () => {
    const test = setup();
    test.sockets[0].open();
    test.sockets[0].message({gateway: {status: 'online'}, grainfather: {connectionState: 'CONNECTED', stale: true}});
    expect(test.states.at(-1)).toBe('ONLINE');
    expect(test.messages.at(-1).grainfather.stale).toBe(true);
    expect(test.sockets[0].close).not.toHaveBeenCalled();
  });

  it('reconnects after genuine socket loss with bounded backoff', () => {
    const test = setup();
    test.sockets[0].open();
    test.sockets[0].lose(1006);
    expect(test.states.at(-1)).toBe('RECONNECTING');
    expect(test.logs).toContain('[WS-CLIENT] reconnect attempt 1 in 2000ms');
    jest.advanceTimersByTime(1999);
    expect(test.sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(test.sockets).toHaveLength(2);
  });

  it('returns online and accepts a fresh snapshot after reconnect', () => {
    const test = setup();
    test.sockets[0].open();
    test.sockets[0].lose();
    jest.advanceTimersByTime(2000);
    test.sockets[1].open();
    test.sockets[1].message({gateway: {status: 'online'}, grainfather: {connectionState: 'CONNECTED', stale: false, actualTemperatureC: 64.7}});
    expect(test.states).toEqual(['ONLINE', 'RECONNECTING', 'ONLINE']);
    expect(test.messages.at(-1).grainfather.actualTemperatureC).toBe(64.7);
  });

  it('logs errors but lets the close event own reconnect scheduling', () => {
    const test = setup();
    test.sockets[0].open();
    test.sockets[0].onerror?.({});
    expect(test.logs).toContain('[WS-CLIENT] ERROR; awaiting CLOSE');
    expect(test.sockets[0].close).not.toHaveBeenCalled();
    expect(test.sockets).toHaveLength(1);
  });

  it('does not invoke injected browser timers with the client as receiver', () => {
    const receivers = [];
    const scheduled = [];
    const client = new GatewayWebSocketClient({
      url: 'ws://gateway/api/v1/ws',
      createSocket: url => new FakeSocket(url),
      setTimeout: function (callback, delay) {
        'use strict';
        receivers.push(this);
        scheduled.push({callback, delay});
        return 17;
      },
      clearTimeout: function (timer) {
        'use strict';
        receivers.push(this);
        expect(timer).toBeNull();
      },
    });

    client.start();
    client.socket.lose();

    expect(receivers).toEqual([undefined, undefined]);
    expect(scheduled[0].delay).toBe(2000);
  });
});
