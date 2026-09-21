import readline from 'node:readline';
import { Server } from 'proxy-chain';
import { createProxyRoute } from '../lib/proxy-route.js';

// Read credentials over stdin; bind the unauthenticated bridge only to loopback.
const input = readline.createInterface({ input: process.stdin });
let server;
let route;
let starting;
input.once('line', async line => {
  starting = (async () => {
    try {
      route = await createProxyRoute(JSON.parse(line).url);
      const upstreamProxyUrl = route.url;
      server = new Server({ host: '127.0.0.1', port: 0, prepareRequestFunction: () => ({ upstreamProxyUrl }) });
      await server.listen();
      process.stdout.write(JSON.stringify({ server: `http://127.0.0.1:${server.port}` }) + '\n');
    } catch {
      process.stderr.write('Browser proxy bridge startup failed\n');
      process.exit(1);
    }
  })();
  await starting;
});
async function stop() {
  await starting;
  await server?.close(true);
  await route?.close();
  process.exit(0);
}
input.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
