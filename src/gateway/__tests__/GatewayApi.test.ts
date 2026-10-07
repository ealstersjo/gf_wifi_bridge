import {EMPTY_GRAINFATHER_STATE} from '../../protocol/GrainfatherState';
import {
  GatewayApi,
  GatewayDomain,
  GatewayRuntimeState,
  SessionApiDomain,
  serializeGatewayState,
} from '../GatewayApi';

function runtime(): GatewayRuntimeState {
  return {
    connectionState: 'CONNECTED',
    grainfatherState: {
      ...EMPTY_GRAINFATHER_STATE,
      actualTemperatureC: 64.7,
      targetTemperatureC: 65,
      heaterOn: true,
      heaterPowerPercent: 100,
      pumpOn: false,
      timerState: 'RUNNING',
      timerActive: true,
      timerPaused: false,
      timerDurationSeconds: 3600,
      timerRemainingSeconds: 1800,
      timerElapsedSeconds: 1800,
      delayedHeat: false,
      delayedHeatState: 'INACTIVE',
      lastUpdated: new Date('2026-09-16T08:00:00.000Z'),
    },
    commandStatus: {state: 'IDLE'},
    rssi: -52,
    gatewayInfo: {port: 8080, localIp: '192.168.1.87', webSocketClients: 1},
  };
}

function domain(): jest.Mocked<GatewayDomain> {
  return {
    scanAndConnect: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
    setTargetTemperature: jest.fn<Promise<void>, [number]>(async () => undefined),
    setHeater: jest.fn<Promise<void>, [boolean]>(async () => undefined),
    setPump: jest.fn<Promise<void>, [boolean]>(async () => undefined),
    startTimer: jest.fn<Promise<void>, [number]>(async () => undefined),
    setTimerPaused: jest.fn<Promise<void>, [boolean]>(async () => undefined),
    cancelTimer: jest.fn(async () => undefined),
    startDelayedHeat: jest.fn<Promise<void>, [number]>(async () => undefined),
    setDelayedHeatPaused: jest.fn<Promise<void>, [boolean]>(async () => undefined),
    cancelDelayedHeat: jest.fn(async () => undefined),
  };
}

function sessionDomain(): jest.Mocked<SessionApiDomain> {
  const session = {id: 'session-1', name: 'Pilsner', startedAt: '2026-09-16T09:00:00.000Z', endedAt: null, status: 'ACTIVE' as const};
  return {
    start: jest.fn<ReturnType<SessionApiDomain['start']>, Parameters<SessionApiDomain['start']>>(async () => session),
    end: jest.fn<ReturnType<SessionApiDomain['end']>, Parameters<SessionApiDomain['end']>>(async () => ({...session, endedAt: '2026-09-16T10:00:00.000Z', status: 'COMPLETED' as const})),
    list: jest.fn(async () => [session]),
    get: jest.fn<ReturnType<SessionApiDomain['get']>, Parameters<SessionApiDomain['get']>>(async () => session),
    telemetry: jest.fn<ReturnType<SessionApiDomain['telemetry']>, Parameters<SessionApiDomain['telemetry']>>(async () => [{id: 1, sessionId: session.id, timestamp: session.startedAt, actualTemperatureC: 20, targetTemperatureC: 65, heaterEnabled: true, heaterOutputPercent: 100, pumpEnabled: false, rssi: -50}]),
    events: jest.fn<ReturnType<SessionApiDomain['events']>, Parameters<SessionApiDomain['events']>>(async () => [{id: 1, sessionId: session.id, timestamp: session.startedAt, type: 'SESSION_STARTED' as const, source: 'SYSTEM' as const, payload: {}}]),
  };
}

describe('gateway state serialization', () => {
  it('creates one semantic snapshot without raw BLE data', () => {
    const snapshot = serializeGatewayState(
      runtime(),
      new Date('2026-09-16T08:00:01.000Z'),
    );

    expect(snapshot).toMatchObject({
      gateway: {
        status: 'online',
        port: 8080,
        localIp: '192.168.1.87',
        webSocketClients: 1,
      },
      grainfather: {
        connectionState: 'CONNECTED',
        stale: false,
        actualTemperatureC: 64.7,
        targetTemperatureC: 65,
        heater: {enabled: true, powerPercent: 100},
        pump: {enabled: false},
        timer: {state: 'RUNNING', remainingSeconds: 1800},
        delayedHeat: {state: 'INACTIVE'},
        rssi: -52,
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/ZX|characteristic|raw/i);
  });

  it('marks old or disconnected Grainfather data stale', () => {
    expect(
      (serializeGatewayState(
        runtime(),
        new Date('2026-09-16T08:00:09.000Z'),
      ).grainfather as {stale: boolean}).stale,
    ).toBe(true);
    const disconnected = runtime();
    disconnected.connectionState = 'DISCONNECTED';
    expect(
      (serializeGatewayState(disconnected).grainfather as {stale: boolean}).stale,
    ).toBe(true);
  });
});

describe('GatewayApi command routing', () => {
  it('accepts omitted or empty optional recipe numbers as null instead of NaN', async () => {
    const sessions = sessionDomain();
    sessions.saveRecipe = jest.fn(async recipe => ({...recipe, id: 'recipe-1', createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z'} as any));
    const api = new GatewayApi(runtime, domain(), sessions);
    const response = await api.handle({id: 'recipe', method: 'POST', path: '/api/v1/recipes', body: JSON.stringify({name: 'Imported', mashSteps: [{name: 'Rest', targetTemperatureC: 65, durationMinutes: 30}], plannedBatchVolumeL: '', grainWeightKg: null})});
    expect(response.statusCode).toBe(201);
    expect(sessions.saveRecipe).toHaveBeenCalledWith(expect.objectContaining({plannedBatchVolumeL: null, grainWeightKg: null}));
  });

  it('keeps recipe list/detail IDs on the same canonical route', async () => {
    const sessions = sessionDomain();
    const recipe = {id: 'cc44d39f-f2c9-41cc-8b37-2fb1fdab292c', name: 'Tmavé', mashSteps: [], createdAt: '', updatedAt: ''} as any;
    sessions.recipes = jest.fn(async () => [recipe]); sessions.recipe = jest.fn(async id => id === recipe.id ? recipe : null);
    const api = new GatewayApi(runtime, domain(), sessions);
    const list = await api.handle({id: 'list', method: 'GET', path: '/api/v1/recipes', body: ''});
    const id = (list.body as any).recipes[0].id;
    await expect(api.handle({id: 'detail', method: 'GET', path: `/api/v1/recipes/${encodeURIComponent(id)}`, body: ''})).resolves.toMatchObject({statusCode: 200, body: {recipe}});
    await expect(api.handle({id: 'missing', method: 'GET', path: '/api/v1/recipes/00000000-0000-0000-0000-000000000000', body: ''})).resolves.toMatchObject({statusCode: 404});
  });

  it('routes completed-session deletion and maps active-session protection', async () => {
    const sessions = sessionDomain();
    sessions.deleteSession = jest.fn(async () => undefined);
    const api = new GatewayApi(runtime, domain(), sessions);
    await expect(api.handle({id: 'delete', method: 'DELETE', path: '/api/v1/sessions/session-1', body: ''})).resolves.toMatchObject({statusCode: 204});
    (sessions.deleteSession as jest.Mock).mockRejectedValueOnce(new Error('SESSION_ACTIVE: End the active brew session before deleting it.'));
    await expect(api.handle({id: 'active', method: 'DELETE', path: '/api/v1/sessions/session-1', body: ''})).resolves.toMatchObject({statusCode: 409, body: {error: 'SESSION_ACTIVE'}});
  });

  it('routes connect and disconnect to the existing domain', async () => {
    const commands = domain();
    const api = new GatewayApi(runtime, commands);

    await expect(
      api.handle({id: '1', method: 'POST', path: '/api/v1/grainfather/connect', body: '{}'}),
    ).resolves.toMatchObject({statusCode: 200});
    await expect(
      api.handle({id: '2', method: 'POST', path: '/api/v1/grainfather/disconnect', body: '{}'}),
    ).resolves.toMatchObject({statusCode: 200});
    expect(commands.scanAndConnect).toHaveBeenCalledTimes(1);
    expect(commands.disconnect).toHaveBeenCalledTimes(1);
  });

  it('routes semantic target, heater, pump, timer and delayed-heat commands', async () => {
    const commands = domain();
    const api = new GatewayApi(runtime, commands);
    const post = (path: string, body = '{}') =>
      api.handle({id: path, method: 'POST', path, body});

    await post('/api/v1/target', '{"temperatureC":66.5}');
    await post('/api/v1/heater', '{"enabled":false}');
    await post('/api/v1/pump', '{"enabled":true}');
    await post('/api/v1/timer/start', '{"durationSeconds":120}');
    await post('/api/v1/timer/pause');
    await post('/api/v1/timer/resume');
    await post('/api/v1/timer/cancel');
    await post('/api/v1/delayed-heat/start', '{"durationSeconds":300}');
    await post('/api/v1/delayed-heat/pause');
    await post('/api/v1/delayed-heat/resume');
    await post('/api/v1/delayed-heat/cancel');

    expect(commands.setTargetTemperature).toHaveBeenCalledWith(66.5);
    expect(commands.setHeater).toHaveBeenCalledWith(false);
    expect(commands.setPump).toHaveBeenCalledWith(true);
    expect(commands.startTimer).toHaveBeenCalledWith(120);
    expect(commands.setTimerPaused).toHaveBeenNthCalledWith(1, true);
    expect(commands.setTimerPaused).toHaveBeenNthCalledWith(2, false);
    expect(commands.cancelTimer).toHaveBeenCalledTimes(1);
    expect(commands.startDelayedHeat).toHaveBeenCalledWith(300);
    expect(commands.setDelayedHeatPaused).toHaveBeenNthCalledWith(1, true);
    expect(commands.setDelayedHeatPaused).toHaveBeenNthCalledWith(2, false);
    expect(commands.cancelDelayedHeat).toHaveBeenCalledTimes(1);
  });

  it('validates JSON input before reaching the domain', async () => {
    const commands = domain();
    const api = new GatewayApi(runtime, commands);
    const response = await api.handle({
      id: 'bad',
      method: 'POST',
      path: '/api/v1/pump',
      body: '{"enabled":"yes"}',
    });

    expect(response).toMatchObject({
      statusCode: 400,
      body: {error: 'invalid_request'},
    });
    expect(commands.setPump).not.toHaveBeenCalled();
  });

  it('returns a structured disconnected error from the domain', async () => {
    const commands = domain();
    commands.setPump.mockRejectedValueOnce(
      new Error('G30 is not connected and ready for commands'),
    );
    const response = await new GatewayApi(runtime, commands).handle({
      id: 'offline',
      method: 'POST',
      path: '/api/v1/pump',
      body: '{"enabled":true}',
    });

    expect(response).toMatchObject({
      statusCode: 409,
      body: {error: 'grainfather_disconnected'},
    });
  });

  it('returns a structured command-pending error from the existing executor', async () => {
    const commands = domain();
    commands.setHeater.mockRejectedValueOnce(
      new Error('Command already pending: Set pump ON'),
    );
    const response = await new GatewayApi(runtime, commands).handle({
      id: 'pending',
      method: 'POST',
      path: '/api/v1/heater',
      body: '{"enabled":true}',
    });

    expect(response).toMatchObject({
      statusCode: 409,
      body: {error: 'command_pending'},
    });
  });

  it('rejects unknown API routes without calling the domain', async () => {
    const commands = domain();
    const response = await new GatewayApi(runtime, commands).handle({
      id: 'unknown',
      method: 'POST',
      path: '/api/v1/ble/write',
      body: '{}',
    });

    expect(response).toEqual({statusCode: 404, body: {error: 'not_found'}});
    expect(commands.setHeater).not.toHaveBeenCalled();
    expect(commands.setPump).not.toHaveBeenCalled();
  });

  it('returns state and health endpoints', async () => {
    const api = new GatewayApi(runtime, domain());
    await expect(
      api.handle({id: 'health', method: 'GET', path: '/api/v1/health', body: ''}),
    ).resolves.toMatchObject({statusCode: 200, body: {gateway: 'online'}});
    await expect(
      api.handle({id: 'state', method: 'GET', path: '/api/v1/state', body: ''}),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {grainfather: {actualTemperatureC: 64.7}},
    });
  });

  it('creates and ends sessions through the session domain', async () => {
    const sessions = sessionDomain();
    const api = new GatewayApi(runtime, domain(), sessions);
    await expect(api.handle({id: 'create', method: 'POST', path: '/api/v1/sessions', body: '{"name":"Pilsner"}'}))
      .resolves.toMatchObject({statusCode: 201, body: {session: {id: 'session-1'}}});
    await expect(api.handle({id: 'end', method: 'POST', path: '/api/v1/sessions/session-1/end', body: '{}'}))
      .resolves.toMatchObject({statusCode: 200, body: {session: {status: 'COMPLETED'}}});
    expect(sessions.start).toHaveBeenCalledWith('Pilsner');
    expect(sessions.end).toHaveBeenCalledWith('session-1');
  });

  it('returns session history, details, telemetry ranges and events', async () => {
    const sessions = sessionDomain();
    const api = new GatewayApi(runtime, domain(), sessions);
    await expect(api.handle({id: 'list', method: 'GET', path: '/api/v1/sessions', body: ''}))
      .resolves.toMatchObject({statusCode: 200, body: {sessions: [{id: 'session-1'}]}});
    await expect(api.handle({id: 'get', method: 'GET', path: '/api/v1/sessions/session-1', body: ''}))
      .resolves.toMatchObject({statusCode: 200, body: {session: {name: 'Pilsner'}}});
    await expect(api.handle({id: 'telemetry', method: 'GET', path: '/api/v1/sessions/session-1/telemetry?since=2026-09-16T09%3A30%3A00.000Z&limit=50', body: ''}))
      .resolves.toMatchObject({statusCode: 200, body: {telemetry: [{actualTemperatureC: 20}]}});
    await expect(api.handle({id: 'events', method: 'GET', path: '/api/v1/sessions/session-1/events?limit=25', body: ''}))
      .resolves.toMatchObject({statusCode: 200, body: {events: [{type: 'SESSION_STARTED'}]}});
    expect(sessions.telemetry).toHaveBeenCalledWith('session-1', '2026-09-16T09:30:00.000Z', 50);
    expect(sessions.events).toHaveBeenCalledWith('session-1', 25);
  });
});
