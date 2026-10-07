/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { GatewayRuntime } from './src/runtime/GatewayRuntime';

AppRegistry.registerComponent(appName, () => App);
GatewayRuntime.start().catch(() => {});
