import {Device, State, Subscription} from 'react-native-ble-plx';

import {BleService} from './BleService';
import {
  buildCancelTimerCommand,
  buildHeaterCommand,
  buildPumpCommand,
  buildStartDelayedHeatCommand,
  buildStartTimerCommand,
  buildTargetTemperatureCommand,
  buildToggleTimerPauseCommand,
  bytesToAscii,
  bytesToHex,
  GrainfatherMessageFramer,
  ParsedGrainfatherStatus,
  parseGrainfatherStatus,
} from '../protocol/GrainfatherProtocol';
import {
  deriveGrainfatherState,
  EMPTY_GRAINFATHER_STATE,
  GrainfatherState,
} from '../protocol/GrainfatherState';
import {
  CommandStatus,
  SerializedCommandExecutor,
} from './SerializedCommandExecutor';

// Verified in clausbroch/node-red-gfconnect/flow.json. Note that the service
// and characteristic UUIDs genuinely use different final Bluetooth bases.
export const G30_SERVICE_UUID = '0000cdd0-0000-1000-8000-00805f9b34fb';
export const G30_STATUS_CHARACTERISTIC_UUID =
  '0003cdd1-0000-1000-8000-00805f9b0131';
export const G30_COMMAND_CHARACTERISTIC_UUID =
  '0003cdd2-0000-1000-8000-00805f9b0131';

export type ConnectionState =
  | 'DISCONNECTED'
  | 'NOT_FOUND'
  | 'SCANNING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ERROR';

export interface DebugEvent {
  id: number;
  timestamp: Date;
  category:
    | 'BLE'
    | 'G30'
    | 'PROTOCOL'
    | 'COMMAND'
    | 'STATE'
    | 'RECONNECT'
    | 'SERVICE'
    | 'GATEWAY'
    | 'HTTP'
    | 'WS';
  message: string;
}

export interface GrainfatherCallbacks {
  onConnectionState: (state: ConnectionState, detail?: string) => void;
  onDevices: (devices: Device[]) => void;
  onStatus: (status: GrainfatherState) => void;
  onCommandStatus: (status: CommandStatus) => void;
  onRssi: (rssi: number | null) => void;
  onLog: (event: DebugEvent) => void;
}

function decodeBase64(value: string): Uint8Array {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      continue;
    }
    buffer = buffer * 64 + index;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      const divisor = 2 ** bitCount;
      bytes.push(Math.floor(buffer / divisor) % 256);
      buffer %= divisor;
    }
  }
  return Uint8Array.from(bytes);
}

export function isLikelyGrainfather(device: Device): boolean {
  const name = `${device.name ?? ''} ${device.localName ?? ''}`;
  const advertisedServices = device.serviceUUIDs ?? [];
  return (
    /grain|g30|father/i.test(name) ||
    advertisedServices.some(uuid => uuid.toLowerCase() === G30_SERVICE_UUID)
  );
}

export class GrainfatherConnection {
  private readonly ble = new BleService();
  private readonly devices = new Map<string, Device>();
  private connectedDevice: Device | null = null;
  private notificationSubscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private rssiTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelAutoConnect: ((reason: string) => void) | null = null;
  private connectInProgress = false;
  private manualDisconnect = false;
  private reconnectAttempt = 0;
  private eventId = 0;
  private readonly messageFramer = new GrainfatherMessageFramer();
  private latestState: GrainfatherState = {...EMPTY_GRAINFATHER_STATE};
  private readyForCommands = false;
  private readonly commandExecutor: SerializedCommandExecutor;

  constructor(private readonly callbacks: GrainfatherCallbacks) {
    this.commandExecutor = new SerializedCommandExecutor(
      () => this.readyForCommands && this.connectedDevice !== null,
      payload => this.writeCommand(payload),
      status => {
        this.callbacks.onCommandStatus(status);
        const detail = status.detail ? `: ${status.detail}` : '';
        this.log('COMMAND', `${status.state}: ${status.description ?? 'none'}${detail}`);
      },
    );
  }

  onBluetoothStateChanged(listener: (state: State) => void): Subscription {
    return this.ble.onBluetoothStateChanged(listener);
  }

  private log(
    category: DebugEvent['category'],
    message: string,
    timestamp = new Date(),
  ): void {
    const prefix = `[${category}]`;
    console.log(prefix, message);
    this.callbacks.onLog({
      id: ++this.eventId,
      timestamp,
      category,
      message,
    });
  }

  async scan(): Promise<void> {
    this.cancelAutoConnect?.('Manual scan started');
    this.cancelAutoConnect = null;
    this.stopScan();
    const permission = await this.ble.requestPermissions();
    if (!permission.granted) {
      this.callbacks.onConnectionState('ERROR', permission.message);
      this.log('BLE', permission.message ?? 'BLE permission denied');
      return;
    }
    const bluetoothState = await this.ble.bluetoothState();
    if (bluetoothState !== State.PoweredOn) {
      const message = `Bluetooth is ${bluetoothState}; turn it on before scanning.`;
      this.callbacks.onConnectionState('ERROR', message);
      this.log('BLE', message);
      return;
    }

    this.devices.clear();
    this.callbacks.onDevices([]);
    this.callbacks.onConnectionState('SCANNING');
    this.log('BLE', 'Scanning for nearby BLE devices (10 seconds)');
    this.ble.startScan(
      device => {
        const previous = this.devices.get(device.id);
        this.devices.set(device.id, device);
        this.callbacks.onDevices(
          [...this.devices.values()].sort((a, b) => {
            const grainfatherPriority =
              Number(isLikelyGrainfather(b)) - Number(isLikelyGrainfather(a));
            return (
              grainfatherPriority || (b.rssi ?? -999) - (a.rssi ?? -999)
            );
          }),
        );
        if (!previous) {
          this.log(
            'BLE',
            `Discovered name=${device.name ?? device.localName ?? '(unnamed)'} ` +
              `id=${device.id} RSSI=${device.rssi ?? 'n/a'} ` +
              `services=${device.serviceUUIDs?.join(',') || '(not advertised)'}`,
          );
        }
      },
      error => {
        this.stopScan();
        this.callbacks.onConnectionState('ERROR', error.message);
        this.log('BLE', `Scan failed: ${error.message}`);
      },
    );
    this.scanTimer = setTimeout(() => {
      this.stopScan();
      if (!this.connectedDevice) {
        this.callbacks.onConnectionState('DISCONNECTED');
      }
      this.log('BLE', 'Scan finished');
    }, 10_000);
  }

  stopScan(): void {
    this.ble.stopScan();
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  async connect(deviceId: string, reconnecting = false): Promise<void> {
    if (this.connectInProgress) {
      throw new Error('Grainfather connection already pending');
    }
    this.connectInProgress = true;
    this.stopScan();
    this.manualDisconnect = false;
    this.readyForCommands = false;
    this.latestState = deriveGrainfatherState({
      ...this.latestState,
      delayedHeat: null,
      timerActive: null,
      timerPaused: null,
      timerDurationSeconds: null,
      timerRemainingSeconds: null,
      timerElapsedSeconds: null,
      timerState: 'UNKNOWN',
      delayedHeatState: 'UNKNOWN',
      timerLastUpdated: null,
    });
    this.callbacks.onStatus(this.latestState);
    this.callbacks.onConnectionState('CONNECTING');
    this.log(reconnecting ? 'RECONNECT' : 'G30', `Connecting to ${deviceId}`);
    try {
      const device = await this.ble.connect(deviceId);
      if (await this.abortConnectedDeviceAfterManualDisconnect(device)) return;
      this.connectedDevice = device;
      this.callbacks.onConnectionState('CONNECTED');
      this.callbacks.onRssi(device.rssi);
      this.log('G30', `Connected to ${device.name ?? device.id}`);
      await this.logGattDatabase(device);
      if (await this.abortConnectedDeviceAfterManualDisconnect(device)) return;
      await this.subscribeToStatus(device);
      if (await this.abortConnectedDeviceAfterManualDisconnect(device)) return;
      this.readyForCommands = true;
      this.watchDisconnect(device);
      this.startRssiPolling(device);
      this.reconnectAttempt = 0;
      return;
    } catch (error) {
      this.readyForCommands = false;
      if (this.manualDisconnect) return;
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onConnectionState('ERROR', message);
      this.log(reconnecting ? 'RECONNECT' : 'G30', `Connection failed: ${message}`);
      if (reconnecting) {
        this.scheduleReconnect(deviceId);
      }
    } finally {
      this.connectInProgress = false;
    }
  }

  private async abortConnectedDeviceAfterManualDisconnect(
    device: Device,
  ): Promise<boolean> {
    if (!this.manualDisconnect) return false;
    this.notificationSubscription?.remove();
    this.notificationSubscription = null;
    if (this.connectedDevice?.id === device.id) this.connectedDevice = null;
    this.readyForCommands = false;
    try {
      await this.ble.disconnect(device.id);
    } catch {
      // A simultaneous manual disconnect may already have closed the GATT link.
    }
    this.callbacks.onConnectionState('DISCONNECTED');
    this.log('G30', 'Cancelled in-progress connection after manual disconnect');
    return true;
  }

  async scanAndConnect(timeoutMs = 25_000): Promise<void> {
    this.cancelAutoConnect?.('A new scan-and-connect request replaced the previous one');
    this.cancelAutoConnect = null;
    this.stopScan();
    const permission = await this.ble.requestPermissions();
    if (!permission.granted) {
      const message = permission.message ?? 'BLE permission denied';
      this.callbacks.onConnectionState('ERROR', message);
      throw new Error(message);
    }
    const bluetoothState = await this.ble.bluetoothState();
    if (bluetoothState !== State.PoweredOn) {
      const message = `Bluetooth is ${bluetoothState}; turn it on before scanning.`;
      this.callbacks.onConnectionState('ERROR', message);
      throw new Error(message);
    }
    if (this.connectedDevice && this.readyForCommands) return;

    this.devices.clear();
    this.callbacks.onDevices([]);
    this.manualDisconnect = false;
    this.callbacks.onConnectionState('SCANNING');
    this.log('BLE', `Remote scan for Grainfather (${timeoutMs / 1000} seconds)`);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finishWithError = (message: string, state: ConnectionState) => {
        if (settled) return;
        settled = true;
        this.cancelAutoConnect = null;
        this.stopScan();
        this.callbacks.onConnectionState(state, message);
        reject(new Error(message));
      };
      this.cancelAutoConnect = reason => finishWithError(reason, 'DISCONNECTED');
      this.ble.startScan(
        device => {
          this.devices.set(device.id, device);
          this.callbacks.onDevices(
            [...this.devices.values()].sort((a, b) => {
              const priority =
                Number(isLikelyGrainfather(b)) - Number(isLikelyGrainfather(a));
              return priority || (b.rssi ?? -999) - (a.rssi ?? -999);
            }),
          );
          if (!isLikelyGrainfather(device) || settled) return;
          settled = true;
          this.cancelAutoConnect = null;
          this.stopScan();
          this.log('G30', `Likely Grainfather found: ${device.name ?? device.id}`);
          this.connect(device.id)
            .then(() => {
              if (this.connectedDevice && this.readyForCommands) {
                resolve();
              } else {
                reject(new Error('Grainfather connection failed'));
              }
            })
            .catch(error => reject(error instanceof Error ? error : new Error(String(error))));
        },
        error => finishWithError(error.message, 'ERROR'),
      );
      this.scanTimer = setTimeout(
        () => finishWithError('No Grainfather found before scan timeout', 'NOT_FOUND'),
        timeoutMs,
      );
    });
  }

  private async logGattDatabase(device: Device): Promise<void> {
    const services = await device.services();
    for (const service of services) {
      this.log('BLE', `Service ${service.uuid}`);
      const characteristics = await service.characteristics();
      for (const characteristic of characteristics) {
        this.log(
          'BLE',
          `  Characteristic ${characteristic.uuid} ` +
            `read=${characteristic.isReadable} notify=${characteristic.isNotifiable} ` +
            `indicate=${characteristic.isIndicatable} ` +
            `writeResponse=${characteristic.isWritableWithResponse} ` +
            `writeNoResponse=${characteristic.isWritableWithoutResponse}`,
        );
      }
    }
  }

  private async subscribeToStatus(device: Device): Promise<void> {
    const characteristics = await device.characteristicsForService(
      G30_SERVICE_UUID,
    );
    const statusCharacteristic = characteristics.find(
      characteristic =>
        characteristic.uuid.toLowerCase() === G30_STATUS_CHARACTERISTIC_UUID,
    );
    if (!statusCharacteristic) {
      throw new Error(
        `Verified G30 status characteristic ${G30_STATUS_CHARACTERISTIC_UUID} not found`,
      );
    }
    if (!statusCharacteristic.isNotifiable && !statusCharacteristic.isIndicatable) {
      throw new Error('Verified G30 status characteristic does not support notifications');
    }
    const commandCharacteristic = characteristics.find(
      characteristic =>
        characteristic.uuid.toLowerCase() === G30_COMMAND_CHARACTERISTIC_UUID,
    );
    if (!commandCharacteristic) {
      throw new Error(
        `Verified G30 command characteristic ${G30_COMMAND_CHARACTERISTIC_UUID} not found`,
      );
    }
    if (!commandCharacteristic.isWritableWithoutResponse) {
      throw new Error('Verified G30 command characteristic does not support writes without response');
    }

    this.notificationSubscription?.remove();
    this.notificationSubscription = this.ble.monitor(
      device,
      G30_SERVICE_UUID,
      G30_STATUS_CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error) {
          this.log('BLE', `Status monitor error: ${error.message}`);
          return;
        }
        if (!characteristic?.value) {
          this.log('PROTOCOL', 'Notification had no value');
          return;
        }
        this.handleNotification(characteristic.uuid, characteristic.value);
      },
    );
    this.log('G30', `Subscribed to status ${G30_STATUS_CHARACTERISTIC_UUID}`);
  }

  private handleNotification(characteristicUuid: string, base64: string): void {
    const timestamp = new Date();
    const bytes = decodeBase64(base64);
    const ascii = bytesToAscii(bytes).replace(/\0/g, '');
    this.log(
      'G30',
      `Notification characteristic=${characteristicUuid}\n` +
        `HEX: ${bytesToHex(bytes)}\n` +
        `DEC: ${Array.from(bytes).join(' ')}\nASCII: ${JSON.stringify(ascii)}`,
      timestamp,
    );
    const framedRecords = this.messageFramer.push(bytes);
    const parsedRecords = framedRecords
      .map(record => parseGrainfatherStatus(record, timestamp))
      .filter((parsed): parsed is ParsedGrainfatherStatus => parsed !== null);

    // A real G30 notification can contain Z padding plus the complete X data
    // in exactly 17 bytes. The upstream framer carries its final character
    // into the next record; parse this verified notification form immediately
    // so the UI does not wait for another BLE event.
    const directlyParsed = parseGrainfatherStatus(bytes, timestamp);
    // Prefer the complete notification when it is itself a verified record.
    // A notification may contain a leading Z padding byte, which means the
    // fixed-width framer can emit a truncated record (without its final Z)
    // and leave the padding byte in its buffer.  In that case the direct
    // parse is the authoritative representation and must not be hidden by a
    // merely-framed partial record.
    const directLooksComplete = Boolean(directlyParsed && /Z\s*$/.test(ascii));
    const parsed = directLooksComplete && framedRecords.length <= 1
      ? [directlyParsed as ParsedGrainfatherStatus]
      : parsedRecords;
    if (parsed.length === 0) {
      this.log('PROTOCOL', 'No verified G30 state decoded from this packet', timestamp);
      return;
    }

    if (directLooksComplete && framedRecords.length <= 1) {
      this.messageFramer.reset();
    }
    parsed.forEach(status => this.applyParsedStatus(status, timestamp));
  }

  private applyParsedStatus(
    parsed: ParsedGrainfatherStatus,
    timestamp: Date,
  ): void {
    this.latestState = deriveGrainfatherState({
      ...this.latestState,
      ...parsed.state,
    });
    if (parsed.messageType === 'X') {
      this.log(
        'PROTOCOL',
        `X decoded: actual=${this.latestState.actualTemperatureC?.toFixed(1)}°C ` +
          `target=${this.latestState.targetTemperatureC?.toFixed(1)}°C`,
        timestamp,
      );
    } else if (parsed.messageType === 'Y') {
      this.log(
        'PROTOCOL',
        `Y decoded: heater=${this.latestState.heaterOn ? 'ON' : 'OFF'} ` +
          `pump=${this.latestState.pumpOn ? 'ON' : 'OFF'} ` +
          `stage=${this.latestState.stageNumber ?? 'unknown'}`,
        timestamp,
      );
      this.log(
        'STATE',
        `Heater reported ${this.latestState.heaterOn ? 'ON' : 'OFF'}; ` +
          `pump reported ${this.latestState.pumpOn ? 'ON' : 'OFF'}`,
        timestamp,
      );
    } else if (parsed.messageType === 'T') {
      this.log(
        'PROTOCOL',
        `T timer decoded: state=${this.latestState.timerState} ` +
          `remaining=${this.latestState.timerRemainingSeconds}s ` +
          `duration=${this.latestState.timerDurationSeconds}s`,
        timestamp,
      );
      this.log(
        'STATE',
        `Timer reported ${this.latestState.timerState}; delayed heat ` +
          `${this.latestState.delayedHeatState}`,
        timestamp,
      );
    } else {
      this.log(
        'PROTOCOL',
        `W decoded: heater output=${this.latestState.heaterPowerPercent}% ` +
          `manual power=${this.latestState.manualPowerMode ? 'ON' : 'OFF'} ` +
          `timer paused=${this.latestState.timerPaused ?? 'unknown'}`,
        timestamp,
      );
    }
    this.callbacks.onStatus(this.latestState);
    this.commandExecutor.observe(this.latestState, parsed.messageType);
  }

  private async writeCommand(payload: Uint8Array): Promise<void> {
    const device = this.connectedDevice;
    if (!device || !this.readyForCommands) {
      throw new Error('G30 is not connected and ready for commands');
    }
    this.log(
      'COMMAND',
      `Writing command ASCII=${JSON.stringify(bytesToAscii(payload))} ` +
        `HEX=${bytesToHex(payload)}`,
    );
    await this.ble.writeWithoutResponse(
      device,
      G30_SERVICE_UUID,
      G30_COMMAND_CHARACTERISTIC_UUID,
      payload,
    );
    this.log('COMMAND', 'Write completed; awaiting notification confirmation');
  }

  setTargetTemperature(temperatureC: number): Promise<void> {
    const expected = Number(temperatureC.toFixed(1));
    return this.commandExecutor.execute({
      description: `set target to ${expected.toFixed(1)} °C`,
      payload: buildTargetTemperatureCommand(expected),
      confirmationSource: 'X',
      isConfirmed: state => state.targetTemperatureC === expected,
    });
  }

  setHeater(enabled: boolean): Promise<void> {
    return this.commandExecutor.execute({
      description: `turn heater ${enabled ? 'on' : 'off'}`,
      payload: buildHeaterCommand(enabled),
      confirmationSource: 'Y',
      isConfirmed: state => state.heaterOn === enabled,
    });
  }

  setPump(enabled: boolean): Promise<void> {
    return this.commandExecutor.execute({
      description: `turn pump ${enabled ? 'on' : 'off'}`,
      payload: buildPumpCommand(enabled),
      confirmationSource: 'Y',
      isConfirmed: state => state.pumpOn === enabled,
    });
  }

  private rejectCommand(description: string, detail: string): Promise<void> {
    const status: CommandStatus = {state: 'FAILED', description, detail};
    this.callbacks.onCommandStatus(status);
    this.log('COMMAND', `FAILED: ${description}: ${detail}`);
    return Promise.reject(new Error(detail));
  }

  startTimer(durationSeconds: number): Promise<void> {
    const description = `start timer for ${durationSeconds} sec`;
    if (
      this.latestState.timerState !== 'IDLE' ||
      this.latestState.delayedHeat !== false
    ) {
      return this.rejectCommand(
        description,
        'Controller timer state must be confirmed idle before starting',
      );
    }
    return this.commandExecutor.execute({
      description,
      payload: buildStartTimerCommand(durationSeconds),
      confirmationSource: 'T',
      isConfirmed: state =>
        state.timerActive === true &&
        state.timerDurationSeconds === durationSeconds,
    });
  }

  startDelayedHeat(durationSeconds: number): Promise<void> {
    const description = `arm delayed heat for ${durationSeconds} sec`;
    if (
      this.latestState.timerState !== 'IDLE' ||
      this.latestState.delayedHeat !== false
    ) {
      return this.rejectCommand(
        description,
        'Controller timer state must be confirmed idle before arming delayed heat',
      );
    }
    return this.commandExecutor.execute({
      description,
      payload: buildStartDelayedHeatCommand(durationSeconds),
      confirmationSource: 'Y',
      isConfirmed: state => state.delayedHeat === true,
    });
  }

  setTimerPaused(paused: boolean): Promise<void> {
    const description = `${paused ? 'pause' : 'resume'} ${
      this.latestState.delayedHeat ? 'delayed heat' : 'timer'
    }`;
    if (
      this.latestState.timerPaused === null ||
      (this.latestState.timerActive !== true &&
        this.latestState.timerPaused !== true)
    ) {
      return this.rejectCommand(
        description,
        'No confirmed active or paused controller timer',
      );
    }
    if (this.latestState.timerPaused === paused) {
      return this.rejectCommand(
        description,
        `Controller already reports timer ${paused ? 'paused' : 'running'}`,
      );
    }
    return this.commandExecutor.execute({
      description,
      payload: buildToggleTimerPauseCommand(),
      confirmationSource: 'W',
      isConfirmed: state => state.timerPaused === paused,
    });
  }

  cancelTimer(): Promise<void> {
    const description = 'cancel timer';
    if (this.latestState.delayedHeat === true) {
      return this.rejectCommand(
        description,
        'Controller reports delayed heat; use delayed-heat cancel',
      );
    }
    return this.commandExecutor.execute({
      description,
      payload: buildCancelTimerCommand(),
      confirmationSource: 'T',
      isConfirmed: state => state.timerActive === false,
    });
  }

  cancelDelayedHeat(): Promise<void> {
    const description = 'cancel delayed heat';
    if (this.latestState.delayedHeat !== true) {
      return this.rejectCommand(
        description,
        'Controller does not report delayed heat active',
      );
    }
    return this.commandExecutor.execute({
      description,
      payload: buildCancelTimerCommand(),
      confirmationSource: 'Y',
      isConfirmed: state => state.delayedHeat === false,
    });
  }

  private watchDisconnect(device: Device): void {
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = this.ble.onDisconnected(
      device.id,
      (error, disconnectedDevice) => {
        this.connectedDevice = null;
        this.readyForCommands = false;
        this.commandExecutor.cancel('Disconnected before controller confirmation');
        this.stopRssiPolling();
        this.callbacks.onConnectionState('DISCONNECTED', error?.message);
        this.log(
          'BLE',
          `Disconnected from ${disconnectedDevice?.id ?? device.id}${
            error ? `: ${error.message}` : ''
          }`,
        );
        if (!this.manualDisconnect) {
          this.scheduleReconnect(device.id);
        }
      },
    );
  }

  private scheduleReconnect(deviceId: string): void {
    if (this.manualDisconnect || this.reconnectAttempt >= 3) {
      if (!this.manualDisconnect) {
        this.log('RECONNECT', 'Reconnect limit reached (3 attempts)');
      }
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs = this.reconnectAttempt * 2_000;
    this.log(
      'RECONNECT',
      `Attempt ${this.reconnectAttempt}/3 in ${delayMs / 1000} seconds`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.connect(deviceId, true);
    }, delayMs);
  }

  private startRssiPolling(device: Device): void {
    this.stopRssiPolling();
    this.rssiTimer = setInterval(() => {
      device
        .readRSSI()
        .then(updated => this.callbacks.onRssi(updated.rssi))
        .catch(error => this.log('BLE', `RSSI read failed: ${String(error)}`));
    }, 3_000);
  }

  private stopRssiPolling(): void {
    if (this.rssiTimer) {
      clearInterval(this.rssiTimer);
      this.rssiTimer = null;
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.cancelAutoConnect?.('Scan cancelled by manual disconnect');
    this.cancelAutoConnect = null;
    this.stopScan();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.notificationSubscription?.remove();
    this.notificationSubscription = null;
    this.stopRssiPolling();
    this.messageFramer.reset();
    this.readyForCommands = false;
    this.commandExecutor.cancel('Disconnected before controller confirmation');
    const id = this.connectedDevice?.id;
    this.connectedDevice = null;
    if (id) {
      await this.ble.disconnect(id);
    }
    this.callbacks.onConnectionState('DISCONNECTED');
    this.log('G30', 'Manual disconnect; automatic reconnect suppressed');
  }

  destroy(): void {
    this.manualDisconnect = true;
    this.cancelAutoConnect?.('Connection controller destroyed');
    this.cancelAutoConnect = null;
    this.stopScan();
    this.stopRssiPolling();
    this.messageFramer.reset();
    this.readyForCommands = false;
    this.commandExecutor.cancel('Connection controller destroyed');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.notificationSubscription?.remove();
    this.disconnectSubscription?.remove();
    this.ble.destroy();
  }
}
