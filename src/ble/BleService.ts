import {PermissionsAndroid, Platform} from 'react-native';
import {
  BleError,
  BleManager,
  Characteristic,
  Device,
  ScanMode,
  State,
  Subscription,
} from 'react-native-ble-plx';

export type ScanDevice = Device;

function encodeBase64(data: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let offset = 0; offset < data.length; offset += 3) {
    const first = data[offset];
    const second = data[offset + 1];
    const third = data[offset + 2];
    const combined = first * 65_536 + (second ?? 0) * 256 + (third ?? 0);
    result += alphabet[Math.floor(combined / 262_144) % 64];
    result += alphabet[Math.floor(combined / 4_096) % 64];
    result +=
      second === undefined ? '=' : alphabet[Math.floor(combined / 64) % 64];
    result += third === undefined ? '=' : alphabet[combined % 64];
  }
  return result;
}

export class BleService {
  private readonly manager = new BleManager();

  async requestPermissions(): Promise<{granted: boolean; message?: string}> {
    if (Platform.OS !== 'android') {
      return {granted: false, message: 'This MVP supports Android only.'};
    }

    const apiLevel = Number(Platform.Version);
    const permissions =
      apiLevel >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

    const results = await PermissionsAndroid.requestMultiple(permissions);
    const denied = permissions.filter(
      permission => results[permission] !== PermissionsAndroid.RESULTS.GRANTED,
    );
    return denied.length === 0
      ? {granted: true}
      : {
          granted: false,
          message: `BLE permission denied: ${denied.join(', ')}`,
        };
  }

  async bluetoothState(): Promise<State> {
    return this.manager.state();
  }

  onBluetoothStateChanged(listener: (state: State) => void): Subscription {
    return this.manager.onStateChange(listener, true);
  }

  startScan(
    onDevice: (device: Device) => void,
    onError: (error: BleError) => void,
  ): void {
    this.manager.startDeviceScan(
      null,
      {allowDuplicates: true, scanMode: ScanMode.LowLatency},
      (error, device) => {
        if (error) {
          onError(error);
        } else if (device) {
          onDevice(device);
        }
      },
    );
  }

  stopScan(): void {
    this.manager.stopDeviceScan();
  }

  async connect(deviceId: string): Promise<Device> {
    const device = await this.manager.connectToDevice(deviceId, {
      autoConnect: false,
    });
    return device.discoverAllServicesAndCharacteristics();
  }

  onDisconnected(
    deviceId: string,
    listener: (error: BleError | null, device: Device | null) => void,
  ): Subscription {
    return this.manager.onDeviceDisconnected(deviceId, listener);
  }

  monitor(
    device: Device,
    serviceUuid: string,
    characteristicUuid: string,
    listener: (error: BleError | null, characteristic: Characteristic | null) => void,
  ): Subscription {
    return device.monitorCharacteristicForService(
      serviceUuid,
      characteristicUuid,
      listener,
    );
  }

  async writeWithoutResponse(
    device: Device,
    serviceUuid: string,
    characteristicUuid: string,
    payload: Uint8Array,
  ): Promise<void> {
    await device.writeCharacteristicWithoutResponseForService(
      serviceUuid,
      characteristicUuid,
      encodeBase64(payload),
    );
  }

  async disconnect(deviceId: string): Promise<void> {
    if (await this.manager.isDeviceConnected(deviceId)) {
      await this.manager.cancelDeviceConnection(deviceId);
    }
  }

  destroy(): void {
    this.stopScan();
    this.manager.destroy();
  }
}
