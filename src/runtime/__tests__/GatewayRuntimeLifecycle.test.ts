import {
  COLD_START_RECOVERY_POLICY,
  GatewayRuntimeLifecycle,
} from '../GatewayRuntimeLifecycle';

describe('GatewayRuntimeLifecycle', () => {
  it('allows only one owner to start and stop', () => {
    const lifecycle = new GatewayRuntimeLifecycle();
    expect(lifecycle.beginStart()).toBe(true);
    expect(lifecycle.beginStart()).toBe(false);
    lifecycle.finishStart();
    expect(lifecycle.current()).toBe('RUNNING');
    expect(lifecycle.beginStop()).toBe(true);
    expect(lifecycle.beginStop()).toBe(false);
    lifecycle.finishStop();
    expect(lifecycle.current()).toBe('STOPPED');
  });

  it('can restart cleanly after stop or failed initialization', () => {
    const lifecycle = new GatewayRuntimeLifecycle();
    lifecycle.beginStart();
    lifecycle.failStart();
    expect(lifecycle.current()).toBe('STOPPED');
    expect(lifecycle.beginStart()).toBe(true);
    lifecycle.finishStart();
    lifecycle.beginStop();
    lifecycle.finishStop();
    expect(lifecycle.beginStart()).toBe(true);
  });

  it('restores recording without scanning or replaying commands on cold start', () => {
    expect(COLD_START_RECOVERY_POLICY).toEqual({
      restoreActiveSession: true,
      initiateBleScan: false,
      replayCommands: false,
    });
  });
});
