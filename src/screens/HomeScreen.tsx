import React, {useEffect, useState} from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {
  isLikelyGrainfather,
} from '../ble/GrainfatherConnection';
import {
  MAX_TARGET_TEMPERATURE_C,
  MAX_CONTROLLER_DURATION_SECONDS,
  MIN_CONTROLLER_DURATION_SECONDS,
  MIN_TARGET_TEMPERATURE_C,
} from '../protocol/GrainfatherProtocol';
import {GatewayRuntime} from '../runtime/GatewayRuntime';

const STALE_AFTER_MS = 8_000;

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`
    : `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function parseDurationInputs(hours: string, minutes: string): number | null {
  if (!/^\d+$/.test(hours) || !/^\d+$/.test(minutes)) return null;
  const totalSeconds = (Number(hours) * 60 + Number(minutes)) * 60;
  return Number(minutes) <= 59 &&
    totalSeconds >= MIN_CONTROLLER_DURATION_SECONDS &&
    totalSeconds <= MAX_CONTROLLER_DURATION_SECONDS
    ? totalSeconds
    : null;
}

function DurationEditor({
  hours,
  minutes,
  setHours,
  setMinutes,
  disabled,
}: {
  hours: string;
  minutes: string;
  setHours: (value: string) => void;
  setMinutes: (value: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.durationRow}>
      <TextInput
        accessibilityLabel="Hours"
        editable={!disabled}
        keyboardType="number-pad"
        maxLength={2}
        onChangeText={setHours}
        selectTextOnFocus
        style={[styles.durationInput, disabled && styles.inputDisabled]}
        value={hours}
      />
      <Text style={styles.durationUnit}>h</Text>
      <TextInput
        accessibilityLabel="Minutes"
        editable={!disabled}
        keyboardType="number-pad"
        maxLength={2}
        onChangeText={setMinutes}
        selectTextOnFocus
        style={[styles.durationInput, disabled && styles.inputDisabled]}
        value={minutes}
      />
      <Text style={styles.durationUnit}>min</Text>
    </View>
  );
}

function Button({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.buttonDisabled]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function HomeScreen(): React.JSX.Element {
  const [runtimeState, setRuntimeState] = useState(GatewayRuntime.getState());
  const [showDebug, setShowDebug] = useState(false);
  const [timerHours, setTimerHours] = useState('0');
  const [timerMinutes, setTimerMinutes] = useState('2');
  const [delayHours, setDelayHours] = useState('0');
  const [delayMinutes, setDelayMinutes] = useState('5');
  useEffect(() => GatewayRuntime.subscribe(setRuntimeState), []);
  const {
    connectionState, connectionDetail, bluetoothState, devices,
    grainfatherState, rssi, commandStatus, debugEvents, gatewayStatus,
    gatewayError, now,
  } = runtimeState;

  const lastUpdatedMs = grainfatherState.lastUpdated?.getTime() ?? 0;
  const ageMs = lastUpdatedMs ? Math.max(0, now - lastUpdatedMs) : Infinity;
  const stale = connectionState !== 'CONNECTED' || ageMs > STALE_AFTER_MS;
  const canDisconnect =
    connectionState === 'CONNECTED' || connectionState === 'CONNECTING';
  const commandPending = commandStatus.state === 'PENDING';
  const controlsDisabled = connectionState !== 'CONNECTED' || commandPending;
  const target = grainfatherState.targetTemperatureC;
  const timerDurationSeconds = parseDurationInputs(timerHours, timerMinutes);
  const delayDurationSeconds = parseDurationInputs(delayHours, delayMinutes);
  const delayedHeatActive = grainfatherState.delayedHeat === true;
  const timerCanStart =
    !controlsDisabled &&
    grainfatherState.timerState === 'IDLE' &&
    grainfatherState.delayedHeat === false;
  const canLowerTarget =
    !controlsDisabled && !stale && target !== null && target > MIN_TARGET_TEMPERATURE_C;
  const canRaiseTarget =
    !controlsDisabled && !stale && target !== null && target < MAX_TARGET_TEMPERATURE_C;
  const runCommand = (command: Promise<void> | undefined): void => {
    command?.catch(() => {
      // Command failures are surfaced through onCommandStatus.
    });
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>GRAINFATHER G30</Text>
        <View style={styles.statusRow}>
          <Text style={styles.label}>Status</Text>
          <Text style={[styles.status, connectionState === 'ERROR' && styles.error]}>
            {connectionState}
          </Text>
        </View>
        <Text style={styles.secondary}>Bluetooth: {bluetoothState}</Text>
        {connectionDetail ? (
          <Text style={styles.errorText}>{connectionDetail}</Text>
        ) : null}

        <View style={styles.gatewayCard}>
          <Text style={styles.cardTitle}>GATEWAY SERVICE</Text>
          <View style={styles.statusRow}>
            <Text style={styles.label}>Status</Text>
            <Text
              style={[
                styles.status,
                gatewayError ? styles.error : undefined,
              ]}>
              {gatewayError
                ? 'ERROR'
                : gatewayStatus.serviceRunning && gatewayStatus.running
                  ? 'RUNNING'
                  : gatewayStatus.serviceRunning
                    ? 'STARTING'
                    : 'STOPPED'}
            </Text>
          </View>
          {gatewayStatus.serviceStartedAt > 0 ? (
            <>
              <Text style={styles.secondary}>
                Started: {new Date(gatewayStatus.serviceStartedAt).toLocaleTimeString()}
              </Text>
              <Text style={styles.secondary}>
                Uptime: {formatDuration(Math.floor((now - gatewayStatus.serviceStartedAt) / 1000))}
              </Text>
            </>
          ) : null}
          <Text style={styles.secondary}>Port: {gatewayStatus.port}</Text>
          <Text style={styles.secondary}>
            Local IP: {gatewayStatus.localIp ?? 'not connected to LAN'}
          </Text>
          <Text style={styles.secondary} selectable>
            Open in browser:{' '}
            {gatewayStatus.localIp
              ? `http://${gatewayStatus.localIp}:${gatewayStatus.port}`
              : 'waiting for local IPv4 address'}
          </Text>
          <Text style={styles.secondary}>
            WebSocket clients: {gatewayStatus.webSocketClients}
          </Text>
          <Text style={styles.secondary}>
            For a dedicated gateway, exclude this app from battery optimization in Android settings.
          </Text>
          <View style={styles.controlRow}>
            <Button
              title="START GATEWAY"
              disabled={gatewayStatus.serviceRunning}
              onPress={() => GatewayRuntime.startService().catch(() => {})}
            />
            <Button
              title="STOP GATEWAY"
              disabled={!gatewayStatus.serviceRunning}
              onPress={() => GatewayRuntime.stopService().catch(() => {})}
            />
          </View>
          {gatewayError ? <Text style={styles.errorText}>{gatewayError}</Text> : null}
        </View>

        <View style={styles.temperatureCard}>
          <Text style={styles.label}>Actual</Text>
          <Text style={styles.temperature}>
            {grainfatherState.actualTemperatureC === null
              ? '--.- °C'
              : `${grainfatherState.actualTemperatureC.toFixed(1)} °C`}
          </Text>
          {stale ? <Text style={styles.stale}>STALE DATA</Text> : null}
          <Text style={styles.label}>Target</Text>
          <Text style={styles.target}>
            {grainfatherState.targetTemperatureC === null
              ? '--.- °C'
              : `${grainfatherState.targetTemperatureC.toFixed(1)} °C`}
          </Text>
          <View style={styles.controlRow}>
            <Button
              title="− 0.5 °C"
              disabled={!canLowerTarget}
              onPress={() =>
                runCommand(
                  target === null
                    ? undefined
                    : GatewayRuntime.setTarget(
                        Math.max(MIN_TARGET_TEMPERATURE_C, target - 0.5),
                      ),
                )
              }
            />
            <Button
              title="+ 0.5 °C"
              disabled={!canRaiseTarget}
              onPress={() =>
                runCommand(
                  target === null
                    ? undefined
                    : GatewayRuntime.setTarget(
                        Math.min(MAX_TARGET_TEMPERATURE_C, target + 0.5),
                      ),
                )
              }
            />
          </View>
          <Text style={styles.secondary}>
            Heater enabled: {grainfatherState.heaterOn === null ? 'UNKNOWN' : grainfatherState.heaterOn ? 'ON' : 'OFF'}
          </Text>
          <View style={styles.controlRow}>
            <Button
              title="Heat ON"
              disabled={controlsDisabled || grainfatherState.heaterOn === true}
              onPress={() => runCommand(GatewayRuntime.setHeater(true))}
            />
            <Button
              title="Heat OFF"
              disabled={controlsDisabled || grainfatherState.heaterOn === false}
              onPress={() => runCommand(GatewayRuntime.setHeater(false))}
            />
          </View>
          <Text style={styles.secondary}>
            Heater output: {grainfatherState.heaterPowerPercent === null ? 'UNKNOWN' : `${grainfatherState.heaterPowerPercent}%`}
          </Text>
          <Text style={styles.secondary}>
            Manual power mode: {grainfatherState.manualPowerMode === null ? 'UNKNOWN' : grainfatherState.manualPowerMode ? 'ON' : 'OFF'}
          </Text>
          <Text style={styles.secondary}>
            Pump: {grainfatherState.pumpOn === null ? 'UNKNOWN' : grainfatherState.pumpOn ? 'ON' : 'OFF'}
          </Text>
          <View style={styles.controlRow}>
            <Button
              title="Pump ON"
              disabled={controlsDisabled || grainfatherState.pumpOn === true}
              onPress={() => runCommand(GatewayRuntime.setPump(true))}
            />
            <Button
              title="Pump OFF"
              disabled={controlsDisabled || grainfatherState.pumpOn === false}
              onPress={() => runCommand(GatewayRuntime.setPump(false))}
            />
          </View>
          <Text style={styles.secondary}>
            Process: {grainfatherState.autoMode === null ? 'UNKNOWN' : grainfatherState.autoMode ? 'AUTO' : 'MANUAL'}
            {grainfatherState.stageNumber === null ? '' : ` · stage ${grainfatherState.stageNumber}`}
            {grainfatherState.stageRamp ? ' · ramping' : ''}
            {grainfatherState.delayedHeat ? ' · delayed heat' : ''}
          </Text>
          <Text style={styles.secondary}>
            Last update:{' '}
            {!lastUpdatedMs
              ? 'never'
              : `${Math.floor(ageMs / 1000)} sec ago${
                  connectionState !== 'CONNECTED' ? ' (disconnected)' : ''
                }`}
          </Text>
          <Text style={styles.secondary}>BLE RSSI: {rssi ?? '--'} dBm</Text>
          {commandStatus.state !== 'IDLE' ? (
            <Text
              style={
                commandStatus.state === 'FAILED'
                  ? styles.commandFailed
                  : styles.commandStatus
              }>
              Command {commandStatus.state.toLowerCase()}: {commandStatus.description}
              {commandStatus.detail ? ` — ${commandStatus.detail}` : ''}
            </Text>
          ) : null}
        </View>

        <View style={styles.controlCard}>
          <Text style={styles.cardTitle}>TIMER</Text>
          <Text style={styles.stateValue}>
            {delayedHeatActive ? 'USED BY DELAYED HEAT' : grainfatherState.timerState}
          </Text>
          <Text style={styles.timerValue}>
            {formatDuration(grainfatherState.timerRemainingSeconds)}
          </Text>
          <Text style={styles.secondary}>
            Controller duration: {formatDuration(grainfatherState.timerDurationSeconds)}
          </Text>
          <Text style={styles.secondary}>
            Derived elapsed: {formatDuration(grainfatherState.timerElapsedSeconds)}
          </Text>
          <Text style={styles.label}>New countdown duration</Text>
          <DurationEditor
            hours={timerHours}
            minutes={timerMinutes}
            setHours={setTimerHours}
            setMinutes={setTimerMinutes}
            disabled={controlsDisabled || delayedHeatActive}
          />
          {timerDurationSeconds === null ? (
            <Text style={styles.errorText}>
              Enter 1 minute to 48 h 59 min (whole minutes).
            </Text>
          ) : null}
          <View style={styles.controlRow}>
            <Button
              title="Start timer"
              disabled={!timerCanStart || timerDurationSeconds === null}
              onPress={() =>
                runCommand(
                  timerDurationSeconds === null
                    ? undefined
                    : GatewayRuntime.startTimer(timerDurationSeconds),
                )
              }
            />
            <Button
              title="Pause"
              disabled={
                controlsDisabled ||
                delayedHeatActive ||
                grainfatherState.timerState !== 'RUNNING'
              }
              onPress={() =>
                runCommand(GatewayRuntime.setTimerPaused(true))
              }
            />
            <Button
              title="Resume"
              disabled={
                controlsDisabled ||
                delayedHeatActive ||
                grainfatherState.timerState !== 'PAUSED'
              }
              onPress={() =>
                runCommand(GatewayRuntime.setTimerPaused(false))
              }
            />
            <Button
              title="Cancel timer"
              disabled={
                controlsDisabled ||
                delayedHeatActive ||
                !['RUNNING', 'PAUSED', 'FINISHED'].includes(
                  grainfatherState.timerState,
                )
              }
              onPress={() => runCommand(GatewayRuntime.cancelTimer())}
            />
          </View>
          <Text style={styles.secondary}>
            Time is reported by the G30; Android does not run this countdown.
          </Text>
        </View>

        <View style={styles.controlCard}>
          <Text style={styles.cardTitle}>DELAYED HEAT</Text>
          <Text style={styles.stateValue}>
            {grainfatherState.delayedHeatState}
          </Text>
          <Text style={styles.timerValue}>
            {formatDuration(grainfatherState.timerRemainingSeconds)}
          </Text>
          <Text style={styles.secondary}>
            Target used by controller:{' '}
            {target === null ? 'UNKNOWN' : `${target.toFixed(1)} °C`}
          </Text>
          <Text style={styles.label}>Delay before controller starts heating</Text>
          <DurationEditor
            hours={delayHours}
            minutes={delayMinutes}
            setHours={setDelayHours}
            setMinutes={setDelayMinutes}
            disabled={controlsDisabled || delayedHeatActive}
          />
          {delayDurationSeconds === null ? (
            <Text style={styles.errorText}>
              Enter 1 minute to 48 h 59 min (whole minutes).
            </Text>
          ) : null}
          <View style={styles.controlRow}>
            <Button
              title="Arm delayed heat"
              disabled={
                !timerCanStart ||
                delayDurationSeconds === null ||
                target === null ||
                stale
              }
              onPress={() =>
                runCommand(
                  delayDurationSeconds === null
                    ? undefined
                    : GatewayRuntime.startDelayedHeat(delayDurationSeconds),
                )
              }
            />
            <Button
              title="Pause"
              disabled={
                controlsDisabled ||
                grainfatherState.delayedHeatState !== 'ARMED'
              }
              onPress={() =>
                runCommand(GatewayRuntime.setTimerPaused(true))
              }
            />
            <Button
              title="Resume"
              disabled={
                controlsDisabled ||
                grainfatherState.delayedHeatState !== 'PAUSED'
              }
              onPress={() =>
                runCommand(GatewayRuntime.setTimerPaused(false))
              }
            />
            <Button
              title="Cancel delayed heat"
              disabled={controlsDisabled || !delayedHeatActive}
              onPress={() =>
                runCommand(GatewayRuntime.cancelDelayedHeat())
              }
            />
          </View>
          <Text style={styles.secondary}>
            This is a duration-until-start, not an absolute clock time. The G30
            owns the schedule after confirmation.
          </Text>
        </View>

        <View style={styles.buttonRow}>
          <Button
            title={connectionState === 'SCANNING' ? 'Scanning…' : 'Scan'}
            disabled={connectionState === 'SCANNING'}
            onPress={() => GatewayRuntime.scan()}
          />
          <Button
            title="Disconnect"
            disabled={!canDisconnect}
            onPress={() => GatewayRuntime.disconnect()}
          />
        </View>

        <Text style={styles.sectionTitle}>Nearby devices</Text>
        {devices.length === 0 ? (
          <Text style={styles.secondary}>Tap Scan to discover BLE devices.</Text>
        ) : (
          <FlatList
            data={devices}
            scrollEnabled={false}
            keyExtractor={item => item.id}
            renderItem={({item}) => {
              const likely = isLikelyGrainfather(item);
              return (
                <Pressable
                  onPress={() => GatewayRuntime.connect(item.id)}
                  style={[styles.device, likely && styles.likelyDevice]}>
                  <View style={styles.deviceHeader}>
                    <Text style={styles.deviceName}>
                      {item.name ?? item.localName ?? 'Unnamed device'}
                    </Text>
                    {likely ? <Text style={styles.badge}>LIKELY G30</Text> : null}
                  </View>
                  <Text style={styles.deviceId}>{item.id}</Text>
                  <Text style={styles.secondary}>RSSI: {item.rssi ?? '--'} dBm</Text>
                  <Text style={styles.connectHint}>Tap to connect</Text>
                </Pressable>
              );
            }}
          />
        )}

        <Pressable onPress={() => setShowDebug(value => !value)}>
          <Text style={styles.sectionTitle}>
            {showDebug ? '▼' : '▶'} Raw BLE debug ({debugEvents.length})
          </Text>
        </Pressable>
        {showDebug ? (
          <View style={styles.debugPanel}>
            {debugEvents.length === 0 ? (
              <Text style={styles.debugText}>No BLE events yet.</Text>
            ) : (
              debugEvents.map(event => (
                <Text key={event.id} style={styles.debugText} selectable>
                  {event.timestamp.toISOString()} [{event.category}] {event.message}
                </Text>
              ))
            )}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: '#f4f5f1'},
  container: {padding: 18, paddingBottom: 48},
  title: {fontSize: 25, fontWeight: '800', color: '#172016', marginBottom: 18},
  statusRow: {flexDirection: 'row', justifyContent: 'space-between'},
  label: {fontSize: 14, fontWeight: '700', color: '#536052', marginTop: 8},
  status: {fontSize: 16, fontWeight: '800', color: '#277a36'},
  error: {color: '#aa2020'},
  errorText: {color: '#aa2020', marginTop: 6},
  temperatureCard: {backgroundColor: '#fff', borderRadius: 10, padding: 18, marginTop: 16, borderWidth: 1, borderColor: '#dce0d9'},
  gatewayCard: {backgroundColor: '#edf7ed', borderRadius: 10, padding: 14, marginTop: 14, borderWidth: 1, borderColor: '#bcd7bd'},
  controlCard: {backgroundColor: '#fff', borderRadius: 10, padding: 18, marginTop: 14, borderWidth: 1, borderColor: '#dce0d9'},
  cardTitle: {fontSize: 18, fontWeight: '900', color: '#172016'},
  stateValue: {fontSize: 14, fontWeight: '800', color: '#246c32', marginTop: 5},
  timerValue: {fontSize: 34, fontWeight: '700', color: '#172016', marginTop: 3},
  temperature: {fontSize: 48, fontWeight: '700', color: '#172016'},
  target: {fontSize: 25, fontWeight: '600', color: '#172016'},
  stale: {color: '#b04a12', fontWeight: '900', marginBottom: 10},
  secondary: {fontSize: 13, color: '#647064', marginTop: 4},
  buttonRow: {flexDirection: 'row', gap: 10, marginVertical: 18},
  controlRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 5},
  durationRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 7},
  durationInput: {borderWidth: 1, borderColor: '#9ba59a', borderRadius: 6, minWidth: 60, paddingHorizontal: 12, paddingVertical: 8, fontSize: 18, color: '#172016', backgroundColor: '#fff', textAlign: 'center'},
  durationUnit: {fontSize: 14, color: '#536052', fontWeight: '700'},
  inputDisabled: {backgroundColor: '#e3e6e1', color: '#778077'},
  button: {backgroundColor: '#246c32', borderRadius: 7, paddingVertical: 11, paddingHorizontal: 20},
  buttonDisabled: {backgroundColor: '#9ba59a'},
  buttonText: {color: '#fff', fontWeight: '800'},
  commandStatus: {color: '#246c32', fontWeight: '700', marginTop: 10},
  commandFailed: {color: '#aa2020', fontWeight: '700', marginTop: 10},
  sectionTitle: {fontSize: 17, fontWeight: '800', color: '#172016', marginTop: 12, marginBottom: 8},
  device: {backgroundColor: '#fff', padding: 12, marginBottom: 8, borderRadius: 7, borderWidth: 1, borderColor: '#dce0d9'},
  likelyDevice: {borderColor: '#2a8b3d', borderWidth: 2},
  deviceHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  deviceName: {fontSize: 15, fontWeight: '700', color: '#172016', flex: 1},
  deviceId: {fontSize: 12, color: '#536052', marginTop: 3},
  badge: {fontSize: 10, fontWeight: '900', color: '#fff', backgroundColor: '#2a8b3d', padding: 4, borderRadius: 4},
  connectHint: {fontSize: 12, color: '#246c32', fontWeight: '700', marginTop: 5},
  debugPanel: {backgroundColor: '#111', borderRadius: 7, padding: 10},
  debugText: {fontFamily: 'monospace', fontSize: 11, color: '#d6f5d5', marginBottom: 10},
});
