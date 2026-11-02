// Test-stand TLS front: https://api.invizent.com:443 (local CA) → http://127.0.0.1:3001, incl. WebSocket upgrades.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
const dir = (process.env.STAND || '/tmp/invizent-stand') + '/';
const server = https.createServer({ key: readFileSync(dir + 'srv.key'), cert: readFileSync(dir + 'srv.crt') }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: 3001, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(3001, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
server.listen(443, '127.0.0.1', () => console.log('tls front on 443'));
