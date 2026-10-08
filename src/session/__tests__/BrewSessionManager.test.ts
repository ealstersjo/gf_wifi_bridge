import {EMPTY_GRAINFATHER_STATE} from '../../protocol/GrainfatherState';
import {
  BrewEvent, BrewSession, SessionObservation, SessionStore, TelemetrySample,
  calculateEtaSeconds, calculateHeatingRate,
} from '../BrewSession';
import {Recipe} from '../BrewSession';
import {BrewSessionManager} from '../BrewSessionManager';

class MemoryStore implements SessionStore {
  sessions: BrewSession[] = [];
  telemetryRows: TelemetrySample[] = [];
  eventRows: BrewEvent[] = [];
  async getActiveSession() { return this.sessions.find(item => item.status === 'ACTIVE') ?? null; }
  async createSession(name: string | null, startedAt: string, recipeId?: string | null, recipeSnapshot?: Recipe | null) {
    if (await this.getActiveSession()) throw new Error('active constraint');
    const session: BrewSession = {id: `s${this.sessions.length + 1}`, name, startedAt, endedAt: null, status: 'ACTIVE', recipeId: recipeId ?? undefined, recipeSnapshot: recipeSnapshot ?? undefined};
    this.sessions.push(session); return session;
  }
  async endSession(id: string, endedAt: string) {
    const session = this.sessions.find(item => item.id === id && item.status === 'ACTIVE');
    if (!session) throw new Error('not found');
    session.status = 'COMPLETED'; session.endedAt = endedAt; return session;
  }
  async listSessions() { return [...this.sessions].reverse(); }
  async getSession(id: string) { return this.sessions.find(item => item.id === id) ?? null; }
  async insertTelemetry(sample: Omit<TelemetrySample, 'id'>) {
    const row = {...sample, id: this.telemetryRows.length + 1}; this.telemetryRows.push(row); return row;
  }
  async listTelemetry(id: string, since: string | null, limit: number) {
    return this.telemetryRows.filter(row => row.sessionId === id && (!since || row.timestamp >= since)).slice(-limit);
  }
  async insertEvent(event: Omit<BrewEvent, 'id'>) {
    const row = {...event, id: this.eventRows.length + 1}; this.eventRows.push(row); return row;
  }
  async listEvents(id: string, limit: number) { return this.eventRows.filter(row => row.sessionId === id).slice(-limit).reverse(); }
}

function observation(overrides: Partial<SessionObservation> = {}): SessionObservation {
  return {
    connectionState: 'CONNECTED', stale: false, rssi: -50,
    state: {...EMPTY_GRAINFATHER_STATE, actualTemperatureC: 20, targetTemperatureC: 65, heaterOn: true, heaterPowerPercent: 100, pumpOn: false, timerState: 'IDLE', delayedHeatState: 'INACTIVE', lastUpdated: new Date()},
    ...overrides,
  };
}

describe('BrewSessionManager', () => {
  it('starts one session, records initial telemetry and ends without controlling G30', async () => {
    const store = new MemoryStore(); const manager = new BrewSessionManager(store);
    await manager.initialize();
    const session = await manager.start('Pilsner', observation(), new Date('2026-09-16T09:00:00Z'));
    await expect(manager.start(null, observation())).rejects.toThrow('already active');
    expect(store.telemetryRows).toHaveLength(1);
    expect(store.eventRows.map(event => event.type)).toEqual(['SESSION_STARTED']);
    await manager.end(session.id, new Date('2026-09-16T10:00:00Z'));
    expect(store.sessions[0]).toMatchObject({status: 'COMPLETED', endedAt: '2026-09-16T10:00:00.000Z'});
    expect(store.eventRows.at(-1)?.type).toBe('SESSION_ENDED');
  });

  it('restores the one persisted active session', async () => {
    const store = new MemoryStore(); await store.createSession('Recovered', '2026-09-16T09:00:00Z');
    const manager = new BrewSessionManager(store); await manager.initialize();
    expect(manager.snapshot().active?.name).toBe('Recovered');
    expect(store.sessions).toHaveLength(1);
  });

  it('samples every five seconds only while active and data is fresh/connected', async () => {
    const store = new MemoryStore(); const manager = new BrewSessionManager(store); await manager.initialize();
    await manager.observe(observation(), new Date('2026-09-16T09:00:00Z'));
    expect(store.telemetryRows).toHaveLength(0);
    await manager.start(null, observation(), new Date('2026-09-16T09:00:00Z'));
    await manager.observe(observation(), new Date('2026-09-16T09:00:04Z'));
    await manager.observe(observation({stale: true}), new Date('2026-09-16T09:00:06Z'));
    await manager.observe(observation({connectionState: 'DISCONNECTED'}), new Date('2026-09-16T09:00:07Z'));
    expect(store.telemetryRows).toHaveLength(1);
    await manager.observe(observation(), new Date('2026-09-16T09:00:10Z'));
    expect(store.telemetryRows).toHaveLength(2);
    expect(store.telemetryRows[1].sessionId).toBe(store.sessions[0].id);
  });

  it('records deterministic transitions once and correlates a WEB target command', async () => {
    const store = new MemoryStore(); const manager = new BrewSessionManager(store); await manager.initialize();
    const initial = observation(); await manager.start(null, initial, new Date('2026-09-16T09:00:00Z'));
    manager.expect('TARGET_CHANGED', 67, 'WEB');
    const changed = observation({state: {...initial.state, targetTemperatureC: 67, heaterOn: false, pumpOn: true}});
    await manager.observe(changed, new Date('2026-09-16T09:00:01Z'));
    await manager.observe(changed, new Date('2026-09-16T09:00:02Z'));
    expect(store.eventRows.filter(event => event.type === 'TARGET_CHANGED')).toMatchObject([{source: 'WEB', payload: {old: 65, new: 67}}]);
    expect(store.eventRows.filter(event => event.type === 'HEATER_OFF')).toHaveLength(1);
    expect(store.eventRows.find(event => event.type === 'PUMP_ON')?.source).toBe('G30');
  });

  it('records connection loss/recovery but keeps the session active', async () => {
    const store = new MemoryStore(); const manager = new BrewSessionManager(store); await manager.initialize();
    await manager.start(null, observation(), new Date('2026-09-16T09:00:00Z'));
    await manager.observe(observation({connectionState: 'DISCONNECTED', stale: true}), new Date('2026-09-16T09:00:01Z'));
    await manager.observe(observation(), new Date('2026-09-16T09:00:02Z'));
    expect(store.eventRows.map(event => event.type)).toEqual(['SESSION_STARTED', 'G30_DISCONNECTED', 'G30_CONNECTED']);
    expect(manager.snapshot().active?.status).toBe('ACTIVE');
  });

  it('emits TARGET_REACHED once after five seconds inside hysteresis', async () => {
    const store = new MemoryStore(); const manager = new BrewSessionManager(store); await manager.initialize();
    const near = observation({state: {...observation().state, actualTemperatureC: 64.9}});
    await manager.start(null, near, new Date('2026-09-16T09:00:00Z'));
    await manager.observe(near, new Date('2026-09-16T09:00:01Z'));
    await manager.observe(near, new Date('2026-09-16T09:00:07Z'));
    await manager.observe(observation({state: {...near.state, actualTemperatureC: 64.8}}), new Date('2026-09-16T09:00:12Z'));
    const noiseTarget = observation({state: {...near.state, actualTemperatureC: 65, targetTemperatureC: 65.1}});
    await manager.observe(noiseTarget, new Date('2026-09-16T09:00:13Z'));
    await manager.observe(noiseTarget, new Date('2026-09-16T09:00:20Z'));
    expect(store.eventRows.filter(event => event.type === 'TARGET_REACHED')).toHaveLength(1);
  });

  it('stores an immutable recipe snapshot when a recipe starts a session', async () => {
    const store = new MemoryStore(); const manager = new BrewSessionManager(store); await manager.initialize();
    const recipe: Recipe = {
      id: 'recipe-1', name: 'Two step', style: 'Ale', notes: '', plannedBatchVolumeL: 20,
      grainWeightKg: 5, mashWaterVolumeL: 25, spargeWaterVolumeL: 10, plannedPreBoilVolumeL: 28,
      mashSteps: [{name: 'Beta', targetTemperatureC: 65, durationMinutes: 45}, {name: 'Alpha', targetTemperatureC: 72, durationMinutes: 15}],
      boilDurationMinutes: 60, createdAt: '2026-09-16T08:00:00.000Z', updatedAt: '2026-09-16T08:00:00.000Z',
    };
    const session = await manager.start('Recipe brew', observation(), new Date('2026-09-16T09:00:00Z'), recipe);
    recipe.name = 'Edited later'; recipe.mashSteps[0].targetTemperatureC = 70;
    expect(session.recipeSnapshot).toMatchObject({name: 'Two step', mashSteps: [{targetTemperatureC: 65}, {targetTemperatureC: 72}]});
    expect(store.eventRows.map(event => event.type)).toEqual(['SESSION_STARTED', 'RECIPE_SELECTED', 'MASH_STEP_STARTED']);
  });
});

describe('heating rate and ETA', () => {
  const samples = (temps: number[], offsets = temps.map((_, i) => i * 30_000)): TelemetrySample[] => temps.map((temperature, index) => ({
    id: index + 1, sessionId: 's1', timestamp: new Date(1_000_000 + offsets[index]).toISOString(),
    actualTemperatureC: temperature, targetTemperatureC: 67, heaterEnabled: true,
    heaterOutputPercent: 100, heaterControlMode: 'TEMPERATURE', pumpEnabled: false, rssi: -50,
  }));

  it('uses regression for rising, flat, falling and irregular samples', () => {
    expect(calculateHeatingRate(samples([20, 20.5, 21, 21.5, 22, 22.5]), 1_150_000)).toBeCloseTo(1, 5);
    expect(calculateHeatingRate(samples([20, 20, 20, 20, 20, 20]), 1_150_000)).toBe(0);
    expect(calculateHeatingRate(samples([22.5, 22, 21.5, 21, 20.5, 20]), 1_150_000)).toBeCloseTo(-1, 5);
    expect(calculateHeatingRate(samples([20, 20.2, 20.7, 21.1, 21.8, 22.4], [0, 12_000, 43_000, 67_000, 111_000, 148_000]), 1_148_000)).toBeGreaterThan(0.8);
    expect(calculateHeatingRate(samples([20, 21, 22]), 1_060_000)).toBeNull();
  });

  it('shows ETA only for a valid active heating scenario', () => {
    expect(calculateEtaSeconds(observation(), 1.5)).toBe(1800);
    expect(calculateEtaSeconds(observation({state: {...observation().state, heaterOn: false}}), 1.5)).toBeNull();
    expect(calculateEtaSeconds(observation(), 0)).toBeNull();
    expect(calculateEtaSeconds(observation(), -1)).toBeNull();
    expect(calculateEtaSeconds(observation({state: {...observation().state, actualTemperatureC: 65}}), 1.5)).toBeNull();
    expect(calculateEtaSeconds(observation({stale: true}), 1.5)).toBeNull();
  });
});
