import { buildApp } from './app.js';
import { appOptions, integerEnv } from './options.js';

const port = integerEnv('PORT', 3001, 1, 65535);

// Several servers (CLUSTER_SELF set): a supervisor elects the primary and runs the app there.
if (process.env.CLUSTER_SELF) {
  const { startCluster } = await import('./cluster.js');
  await startCluster({ port, host: process.env.HOST || '0.0.0.0' });
} else {
const app = await buildApp(appOptions());

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (stopping) return;
  stopping = true;
  try { await app.close(); } catch { process.exitCode = 1; }
});

try {
  await app.listen({ host: process.env.HOST || '0.0.0.0', port });
} catch (error) {
  app.log.error({ code: error.code || 'START_FAILED' }, 'Server did not start');
  await app.close();
  process.exitCode = 1;
}
}
