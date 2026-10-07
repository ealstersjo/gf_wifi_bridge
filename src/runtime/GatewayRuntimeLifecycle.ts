export type GatewayRuntimePhase =
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING';

/**
 * Small synchronous gate around the process-wide runtime. Keeping this logic
 * independent makes duplicate Android service/activity start signals harmless
 * and lets the lifecycle policy be tested without constructing BLE objects.
 */
export class GatewayRuntimeLifecycle {
  private phase: GatewayRuntimePhase = 'STOPPED';

  current(): GatewayRuntimePhase {
    return this.phase;
  }

  beginStart(): boolean {
    if (this.phase !== 'STOPPED') return false;
    this.phase = 'STARTING';
    return true;
  }

  finishStart(): void {
    if (this.phase === 'STARTING') this.phase = 'RUNNING';
  }

  failStart(): void {
    if (this.phase === 'STARTING') this.phase = 'STOPPED';
  }

  beginStop(): boolean {
    if (this.phase === 'STOPPED' || this.phase === 'STOPPING') return false;
    this.phase = 'STOPPING';
    return true;
  }

  finishStop(): void {
    this.phase = 'STOPPED';
  }
}

/** Recovery is deliberately passive: restore recording, but never actuate G30. */
export const COLD_START_RECOVERY_POLICY = Object.freeze({
  restoreActiveSession: true,
  initiateBleScan: false,
  replayCommands: false,
});
