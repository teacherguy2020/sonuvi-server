// Credential-less, fixed TCP relay for a Docker Desktop localhost binding.
// The real fixture runs on an internal-only network; this process can forward
// only to that named container's SSH port and never interprets SSH traffic.
import net from 'node:net';

const TARGET_HOST = 'sonuvi-gate-c-archive-status-fixture';
const TARGET_PORT = 22;
const LISTEN_PORT = 2225;

const server = net.createServer((client) => {
  const upstream = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (error) => {
  process.stderr.write(`sonuvi_gate_c_archive_status_relay:${error.message}\n`);
  process.exitCode = 1;
});
server.listen({ host: '0.0.0.0', port: LISTEN_PORT });
