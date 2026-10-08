import {Device, State} from 'react-native-ble-plx';
import {CommandStatus} from '../ble/SerializedCommandExecutor';
import {ConnectionState, DebugEvent, GrainfatherConnection} from '../ble/GrainfatherConnection';
import {EMPTY_GRAINFATHER_STATE, GrainfatherState} from '../protocol/GrainfatherState';
import {GatewayApi, GatewayRuntimeState, serializeGatewayState} from '../gateway/GatewayApi';
import {GatewayNative, NativeGatewayStatus, NativeSessionStore} from '../gateway/GatewayNative';
import {BrewSessionManager} from '../session/BrewSessionManager';
import {SessionLiveState, SessionObservation} from '../session/BrewSession';
import {GatewayRuntimeLifecycle} from './GatewayRuntimeLifecycle';

const STALE_AFTER_MS = 8_000;
const MAX_DEBUG_EVENTS = 100;

export interface GatewayUiState {
  connectionState: ConnectionState;
  connectionDetail?: string;
  bluetoothState: State;
  devices: Device[];
  grainfatherState: GrainfatherState;
  rssi: number | null;
  commandStatus: CommandStatus;
  debugEvents: DebugEvent[];
  gatewayStatus: NativeGatewayStatus;
  gatewayError?: string;
  sessionLive: SessionLiveState;
  now: number;
}

const initialSession: SessionLiveState = {
  active: null, heatingRateCPerMinute: null, etaSeconds: null,
  latestTelemetry: null, latestEvent: null, revision: 0,
};

function observation(runtime: GatewayRuntimeState, now = new Date()): SessionObservation {
  const updated = runtime.grainfatherState.lastUpdated?.getTime() ?? 0;
  return {
    connectionState: runtime.connectionState,
    state: runtime.grainfatherState,
    rssi: runtime.rssi,
    stale: runtime.connectionState !== 'CONNECTED' || !updated || now.getTime() - updated > STALE_AFTER_MS,
  };
}

class GatewayRuntimeOwner {
  private state: GatewayUiState = {
    connectionState: 'DISCONNECTED', bluetoothState: State.Unknown, devices: [],
    grainfatherState: EMPTY_GRAINFATHER_STATE, rssi: null, commandStatus: {state: 'IDLE'},
    debugEvents: [], gatewayStatus: {running: false, port: 8080, localIp: null, webSocketClients: 0, serviceRunning: false, serviceStartedAt: 0},
    sessionLive: initialSession, now: Date.now(),
  };
  private listeners = new Set<(state: GatewayUiState) => void>();
  private controller: GrainfatherConnection | null = null;
  private sessions: BrewSessionManager | null = null;
  private subscriptions: Array<{remove(): void}> = [];
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly lifecycle = new GatewayRuntimeLifecycle();
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private gatewayEventId = 1_000_000;

  constructor() {
    GatewayNative.onServiceCommand(command => {
      if (command === 'START') this.start().catch(() => {});
      if (command === 'STOP') this.stop().catch(() => {});
    });
  }

  getState(): GatewayUiState { return this.state; }
  subscribe(listener: (state: GatewayUiState) => void): () => void {
    this.listeners.add(listener); listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.startPromise) return this.startPromise;
    if (!this.lifecycle.beginStart()) return Promise.resolve();
    this.logService('Starting process-wide gateway runtime');
    this.startPromise = this.startInternal()
      .then(() => {
        this.lifecycle.finishStart();
        this.logService('Gateway runtime started');
      })
      .catch(async error => {
        await this.cleanup();
        this.lifecycle.failStart();
        this.patch({gatewayError: error instanceof Error ? error.message : String(error)});
        this.logService(`Gateway runtime failed to start: ${String(error)}`);
        throw error;
      })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const controller = new GrainfatherConnection({
      onConnectionState: (connectionState, connectionDetail) => this.patch({connectionState, connectionDetail}),
      onDevices: devices => this.patch({devices}),
      onStatus: grainfatherState => this.patch({grainfatherState}),
      onCommandStatus: commandStatus => this.patch({commandStatus}),
      onRssi: rssi => this.patch({rssi}),
      onLog: event => this.patch({debugEvents: [event, ...this.state.debugEvents].slice(0, MAX_DEBUG_EVENTS)}),
    });
    this.controller = controller;
    const sessions = new BrewSessionManager(NativeSessionStore);
    this.sessions = sessions;
    sessions.setListener(sessionLive => this.patch({sessionLive}));
    await sessions.initialize();
    const expected = <T,>(type: Parameters<BrewSessionManager['expect']>[0], value: unknown, action: () => Promise<T>): Promise<T> => {
      sessions.expect(type, value, 'WEB');
      return action().catch(error => { sessions.cancelExpectation(type); throw error; });
    };
    const api = new GatewayApi(() => this.domainState(), {
      scanAndConnect: () => controller.scanAndConnect(), disconnect: () => controller.disconnect(),
      setTargetTemperature: value => expected('TARGET_CHANGED', value, () => controller.setTargetTemperature(value)),
      setHeater: enabled => expected(enabled ? 'HEATER_ON' : 'HEATER_OFF', enabled, () => controller.setHeater(enabled)),
      setHeaterControlMode: mode => controller.setHeaterControlMode(mode),
      setPump: enabled => expected(enabled ? 'PUMP_ON' : 'PUMP_OFF', enabled, () => controller.setPump(enabled)),
      startTimer: duration => expected('TIMER_STARTED', 'RUNNING', () => controller.startTimer(duration)),
      setTimerPaused: paused => expected(paused ? 'TIMER_PAUSED' : 'TIMER_RESUMED', paused ? 'PAUSED' : 'RUNNING', () => controller.setTimerPaused(paused)),
      cancelTimer: () => expected('TIMER_CANCELLED', 'IDLE', () => controller.cancelTimer()),
      startDelayedHeat: duration => expected('DELAYED_HEAT_STARTED', 'ARMED', () => controller.startDelayedHeat(duration)),
      setDelayedHeatPaused: paused => expected(paused ? 'DELAYED_HEAT_PAUSED' : 'DELAYED_HEAT_RESUMED', paused ? 'PAUSED' : 'ARMED', () => controller.setTimerPaused(paused)),
      cancelDelayedHeat: () => expected('DELAYED_HEAT_CANCELLED', 'INACTIVE', () => controller.cancelDelayedHeat()),
    }, {
      start: async (name, recipeId = null) => {
        const recipe = recipeId ? await sessions.recipe(recipeId) : null;
        if (recipeId && !recipe) throw new Error('Recipe not found');
        return sessions.start(name, observation(this.domainState()), new Date(), recipe);
      }, end: id => sessions.end(id),
      list: () => sessions.listSessions(), get: id => sessions.getSession(id),
      telemetry: (id, since, limit) => sessions.telemetry(id, since, limit), events: (id, limit) => sessions.events(id, limit),
      summary: id => sessions.summary(id), recipes: () => sessions.recipes(), recipe: id => sessions.recipe(id),
      saveRecipe: recipe => sessions.saveRecipe(recipe), duplicateRecipe: (id, name) => sessions.duplicateRecipe(id, name),
      deleteRecipe: id => sessions.deleteRecipe(id), updateActualValues: (id, actual) => sessions.updateActualValues(id, actual),
      markPhase: (id, phase) => sessions.markPhase(id, phase), performance: () => sessions.performance(),
    });
    this.subscriptions.push(
      GatewayNative.onRequest(request => api.handle(request).then(response => GatewayNative.respond(request.id, response.statusCode, response.body)).catch(() => GatewayNative.respond(request.id, 500, {error: 'gateway_internal_error'}))),
      GatewayNative.onLog(event => this.patch({debugEvents: [{id: ++this.gatewayEventId, timestamp: new Date(), category: event.category, message: event.message}, ...this.state.debugEvents].slice(0, MAX_DEBUG_EVENTS)})),
      GatewayNative.onClientCount(webSocketClients => this.patch({gatewayStatus: {...this.state.gatewayStatus, webSocketClients}})),
      controller.onBluetoothStateChanged(bluetoothState => this.patch({bluetoothState})),
    );
    try {
      const gatewayStatus = await GatewayNative.start(8080);
      this.patch({gatewayStatus, gatewayError: undefined});
    } catch (error) {
      this.patch({gatewayError: error instanceof Error ? error.message : String(error)});
    }
    this.timers.push(setInterval(() => this.tick(), 1_000));
    this.timers.push(setInterval(() => GatewayNative.getStatus().then(gatewayStatus => this.patch({gatewayStatus})).catch(() => {}), 5_000));
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (!this.lifecycle.beginStop()) return;
    this.logService('Stopping process-wide gateway runtime');
    this.stopPromise = this.cleanup().finally(() => {
      this.lifecycle.finishStop();
      this.stopPromise = null;
      this.logService('Gateway runtime stopped');
    });
    return this.stopPromise;
  }

  private async cleanup(): Promise<void> {
    this.timers.forEach(clearInterval); this.timers = [];
    this.subscriptions.forEach(item => item.remove()); this.subscriptions = [];
    await this.controller?.disconnect().catch(() => {});
    this.controller?.destroy(); this.controller = null; this.sessions = null;
    await GatewayNative.stop().catch(() => {});
    this.patch({connectionState: 'DISCONNECTED', gatewayStatus: {...this.state.gatewayStatus, running: false}});
  }

  async startService(): Promise<void> { await GatewayNative.startGatewayService(); await this.start(); }
  async stopService(): Promise<void> {
    await GatewayNative.stopGatewayService();
    await this.stop();
    const service = await GatewayNative.getGatewayServiceStatus().catch(() => ({running: false, startedAt: 0}));
    this.patch({gatewayStatus: {
      ...this.state.gatewayStatus,
      running: false,
      webSocketClients: 0,
      serviceRunning: service.running,
      serviceStartedAt: service.startedAt,
    }});
  }

  scan(): Promise<void> | undefined { return this.controller?.scan(); }
  connect(id: string): Promise<void> | undefined { return this.controller?.connect(id); }
  disconnect(): Promise<void> | undefined { return this.controller?.disconnect(); }
  setTarget(value: number): Promise<void> | undefined { return this.controller?.setTargetTemperature(value); }
  setHeater(value: boolean): Promise<void> | undefined { return this.controller?.setHeater(value); }
  setPump(value: boolean): Promise<void> | undefined { return this.controller?.setPump(value); }
  startTimer(value: number): Promise<void> | undefined { return this.controller?.startTimer(value); }
  setTimerPaused(value: boolean): Promise<void> | undefined { return this.controller?.setTimerPaused(value); }
  cancelTimer(): Promise<void> | undefined { return this.controller?.cancelTimer(); }
  startDelayedHeat(value: number): Promise<void> | undefined { return this.controller?.startDelayedHeat(value); }
  cancelDelayedHeat(): Promise<void> | undefined { return this.controller?.cancelDelayedHeat(); }

  private tick(): void {
    if (this.lifecycle.current() !== 'RUNNING' && this.lifecycle.current() !== 'STARTING') return;
    const now = Date.now(); this.patch({now});
    const current = this.domainState();
    this.sessions?.observe(observation(current, new Date(now)), new Date(now)).catch(error => this.patch({gatewayError: String(error)}));
    if (this.state.gatewayStatus.running) GatewayNative.updateSnapshot(serializeGatewayState(current, new Date(now)));
  }

  private domainState(): GatewayRuntimeState {
    return {
      connectionState: this.state.connectionState, connectionDetail: this.state.connectionDetail,
      grainfatherState: this.state.grainfatherState, commandStatus: this.state.commandStatus, rssi: this.state.rssi,
      gatewayInfo: {port: this.state.gatewayStatus.port, localIp: this.state.gatewayStatus.localIp, webSocketClients: this.state.gatewayStatus.webSocketClients},
      session: this.state.sessionLive,
    };
  }

  private patch(update: Partial<GatewayUiState>): void {
    this.state = {...this.state, ...update};
    this.listeners.forEach(listener => listener(this.state));
    // BLE status callbacks are the source of truth for the dashboard. Publish
    // them immediately instead of waiting for the one-second runtime tick;
    // the tick remains responsible for freshness/session bookkeeping.
    if (this.state.gatewayStatus.running) {
      GatewayNative.updateSnapshot(serializeGatewayState(this.domainState(), new Date(this.state.now)));
    }
  }

  private logService(message: string): void {
    const event: DebugEvent = {
      id: ++this.gatewayEventId,
      timestamp: new Date(),
      category: 'SERVICE',
      message,
    };
    this.patch({debugEvents: [event, ...this.state.debugEvents].slice(0, MAX_DEBUG_EVENTS)});
  }
}

export const GatewayRuntime = new GatewayRuntimeOwner();
