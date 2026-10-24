import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildOutbound, parseProxyUri, startProxy, measureProxyDualPing } from '../server/services/xray.js';
const run = promisify(execFile);
const id = '00000000-0000-4000-8000-000000000001';

test('VLESS keeps credentials, WS host/path, TLS SNI and port', () => {
  const raw = `vless://${id}@example.com:443?type=ws&security=tls&path=%2Fsocket&host=cdn.example.com&sni=tls.example.com#Test`;
  const config = buildOutbound(raw);
  assert.equal(config.settings.vnext[0].users[0].id, id);
  assert.deepEqual(config.streamSettings.wsSettings, { path: '/socket', headers: { Host: 'cdn.example.com' } });
  assert.equal(config.streamSettings.tlsSettings.serverName, 'tls.example.com');
  assert.deepEqual(parseProxyUri(raw), { protocol: 'vless', server: 'example.com', port: 443, name: 'Test' });
});

test('Reality, Trojan gRPC and VMess fields survive translation', () => {
  const reality = buildOutbound(`vless://${id}@example.com:443?security=reality&pbk=key&sid=1234&sni=example.org&flow=xtls-rprx-vision`);
  assert.equal(reality.streamSettings.realitySettings.publicKey, 'key');
  assert.equal(reality.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
  const trojan = buildOutbound('trojan://a%2Fb@example.com:443?type=grpc&serviceName=service');
  assert.equal(trojan.settings.servers[0].password, 'a/b');
  assert.equal(trojan.streamSettings.grpcSettings.serviceName, 'service');
  assert.equal(trojan.streamSettings.security, 'tls');
  const raw = `vmess://${Buffer.from(JSON.stringify({ add: 'example.com', port: '8443', id, net: 'ws', tls: 'tls', host: 'cdn.example.com', path: '/ws', ps: 'VM' })).toString('base64')}`;
  assert.equal(buildOutbound(raw).streamSettings.wsSettings.path, '/ws');
  assert.equal(parseProxyUri(raw).name, 'VM');
});

test('invalid and unsupported configs are rejected, not silently converted to direct traffic', () => {
  for (const raw of ['invalid', 'ss://secret@example.com:443?plugin=unsupported', 'vless://example.com:443', `vless://${id}@example.com:443?type=kcp`, 'socks5://example.com:0']) {
    assert.throws(() => buildOutbound(raw));
  }
});

test('failed proxy test returns offline and null latencies', async () => {
  const result = await measureProxyDualPing('http://127.0.0.1:1');
  assert.deepEqual(result, { reachable: false, latency: null, google_latency: null, x_latency: null });
});

test('missing Xray fails explicitly and cleans its private configuration', async () => {
  const old = process.env.XRAY_BIN;
  process.env.XRAY_BIN = '/nonexistent-x-bot-xray';
  try { await assert.rejects(startProxy(`vless://${id}@example.com:443`), /XRAY_BIN/); }
  finally { if (old === undefined) delete process.env.XRAY_BIN; else process.env.XRAY_BIN = old; }
});

test('tunnel owns a private config and release is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-bot-test-'));
  const script = path.join(dir, 'xray');
  const capture = path.join(dir, 'capture');
  fs.writeFileSync(script, `#!/usr/bin/env node\nconst fs=require('fs'),net=require('net');const p=process.argv[4];const c=JSON.parse(fs.readFileSync(p));fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({path:p,config:c}));net.createServer(s=>s.end()).listen(c.inbounds[0].port,'127.0.0.1');\n`, { mode: 0o700 });
  const old = process.env.XRAY_BIN;
  process.env.XRAY_BIN = script;
  let lease;
  try {
    lease = await startProxy(`vless://${id}@example.com:443?type=ws&path=%2Fsocket`);
    assert.match(lease.url, /^socks5:\/\/127\.0\.0\.1:\d+$/);
    const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(captured.config.outbounds[0].streamSettings.wsSettings.path, '/socket');
    assert.equal(fs.statSync(captured.path).mode & 0o777, 0o600);
    lease.release(); lease.release();
    assert.equal(fs.existsSync(captured.path), false);
  } finally {
    lease?.release(); fs.rmSync(dir, { recursive: true, force: true });
    if (old === undefined) delete process.env.XRAY_BIN; else process.env.XRAY_BIN = old;
  }
});

test('real Xray tunnels three simultaneous clients through an authenticated upstream', { skip: !process.env.XRAY_BIN }, async () => {
  const target = http.createServer((_req, res) => res.end('tunnel-ok'));
  const proxy = http.createServer();
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  let connections = 0;
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('user:pass').toString('base64')}`);
    connections++;
    const upstream = net.connect((target.address() as net.AddressInfo).port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const leases = [];
  try {
    const raw = `http://user:pass@127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    for (let i = 0; i < 3; i++) leases.push(await startProxy(raw));
    const results = await Promise.all(leases.map(lease => run('curl', ['--fail', '--silent', '--noproxy', '', '--proxy', lease.url.replace('socks5:', 'socks5h:'), '--max-time', '5', `http://127.0.0.1:${(target.address() as net.AddressInfo).port}/`])));
    assert.deepEqual(results.map(r => r.stdout), ['tunnel-ok', 'tunnel-ok', 'tunnel-ok']);
    assert.equal(connections, 3);
  } finally {
    leases.forEach(l => l.release());
    sockets.forEach(s => s.destroy());
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => target.close(r))]);
  }
});


test('Shadowsocks supports SIP002 and legacy base64 credentials', () => {
  const credentials = 'aes-256-gcm:p@ss:word';
  for (const raw of [`ss://${Buffer.from(credentials).toString('base64')}@example.com:80#SS`,
    `ss://${Buffer.from(credentials + '@example.com:80').toString('base64')}#SS`]) {
    const outbound = buildOutbound(raw);
    assert.deepEqual(outbound.settings.servers[0], { address: 'example.com', port: 80, method: 'aes-256-gcm', password: 'p@ss:word' });
    assert.equal(parseProxyUri(raw).name, 'SS');
  }
});

test('real Xray accepts generated VLESS, VMess, Trojan and Shadowsocks configurations', { skip: !process.env.XRAY_BIN }, async () => {
  const configs = [
    `vless://${id}@example.com:443?security=reality&sni=example.com&pbk=${Buffer.alloc(32, 1).toString('base64url')}&sid=abcd&flow=xtls-rprx-vision`,
    `vless://${id}@example.com:443?type=ws&security=tls&path=%2Fws&host=example.com`,
    `vless://${id}@example.com:443?type=grpc&security=tls&serviceName=test`,
    'trojan://synthetic@example.com:443?type=grpc&serviceName=test',
    `vmess://${Buffer.from(JSON.stringify({ add: 'example.com', port: 443, id, net: 'ws', tls: 'tls' })).toString('base64')}`,
    `ss://${Buffer.from('aes-256-gcm:synthetic').toString('base64')}@example.com:443`,
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-bot-config-test-'));
  try {
    for (const raw of configs) {
      const filename = path.join(dir, 'config.json');
      fs.writeFileSync(filename, JSON.stringify({ outbounds: [buildOutbound(raw)] }));
      await run(process.env.XRAY_BIN!, ['run', '-test', '-config', filename]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
