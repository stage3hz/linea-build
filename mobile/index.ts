import './src/installDesktopFetch';
// Фоновое обновление: the task has to be defined before the system may start the app without a screen.
import './src/prefetch/task';
// A call that wakes the app (Android): its task too.
import './src/calls/incomingPush';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
