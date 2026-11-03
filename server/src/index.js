// Modules are loaded only where needed: a witness server (CLUSTER_WITNESS=1) runs with plain Node,
// without the app's npm packages.
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT: 1–65535');

// Several servers (CLUSTER_SELF set): a supervisor elects the primary and runs the app there.
if (process.env.CLUSTER_SELF) {
  const { startCluster } = await import('./cluster.js');
  await startCluster({ port, host: process.env.HOST || '0.0.0.0' });
} else {
const { buildApp } = await import('./app.js');
const { appOptions } = await import('./options.js');
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
