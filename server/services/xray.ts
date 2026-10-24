import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Preserve transport, TLS/Reality and credentials from the original share link.
export function buildOutbound(raw: string): any {
  if (raw.startsWith('ss://')) {
    const [share, query = ''] = raw.slice(5).split('#')[0].split('?');
    if (new URLSearchParams(query).has('plugin')) throw new Error('افزونه Shadowsocks پشتیبانی نمی‌شود.');
    const decoded = share.includes('@') ? share : Buffer.from(share, 'base64').toString('utf8');
    const at = decoded.lastIndexOf('@');
    if (at < 0) throw new Error('کانفیگ Shadowsocks ناقص است.');
    let credentials = decodeURIComponent(decoded.slice(0, at));
    if (!credentials.includes(':')) credentials = Buffer.from(credentials, 'base64').toString('utf8');
    const colon = credentials.indexOf(':');
    if (colon < 1 || colon === credentials.length - 1) throw new Error('رمز یا روش Shadowsocks نامعتبر است.');
    const endpoint = new URL(`ss://${decoded.slice(at + 1).replace(/\/$/, '')}`);
    if (!endpoint.hostname || !endpoint.port) throw new Error('آدرس یا پورت Shadowsocks ناقص است.');
    return { protocol: 'shadowsocks', settings: { servers: [{ address: endpoint.hostname.replace(/^\[|\]$/g, ''),
      port: validPort(endpoint.port), method: credentials.slice(0, colon), password: credentials.slice(colon + 1) }] } };
  }
  if (raw.startsWith('vmess://')) {
    const vm = JSON.parse(Buffer.from(raw.slice(8), 'base64').toString('utf8'));
    if (!vm.add || !vm.id) throw new Error('کانفیگ VMess ناقص است.');
    const params = new URLSearchParams({ type: vm.net || 'tcp', security: vm.tls || 'none',
      host: vm.host || '', path: vm.path || '', sni: vm.sni || '', serviceName: vm.path || '' });
    return { protocol: 'vmess', settings: { vnext: [{ address: vm.add, port: validPort(vm.port || 443),
      users: [{ id: vm.id, alterId: Number(vm.aid || 0), security: vm.scy || 'auto' }] }] },
      streamSettings: streamSettings(params) };
  }
  const url = new URL(raw);
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  const address = url.hostname.replace(/^\[|\]$/g, '');
  const port = validPort(url.port || (['vless', 'trojan', 'https'].includes(protocol) ? 443 : protocol === 'http' ? 80 : 1080));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  if (!address) throw new Error('آدرس سرور پراکسی خالی است.');
  if (protocol === 'vless' || protocol === 'trojan') {
    if (!user) throw new Error('شناسه یا رمز کانفیگ خالی است.');
    return { protocol, settings: protocol === 'vless'
      ? { vnext: [{ address, port, users: [{ id: user, encryption: url.searchParams.get('encryption') || 'none', flow: url.searchParams.get('flow') || '' }] }] }
      : { servers: [{ address, port, password: user }] }, streamSettings: streamSettings(url.searchParams, protocol === 'trojan' ? 'tls' : 'none') };
  }
  if (['http', 'https', 'socks', 'socks5'].includes(protocol)) {
    return { protocol: protocol.startsWith('http') ? 'http' : 'socks', settings: {
      servers: [{ address, port, ...(user ? { users: [{ user, pass }] } : {}) }] },
      ...(protocol === 'https' ? { streamSettings: { security: 'tls', tlsSettings: { serverName: address } } } : {}) };
  }
  throw new Error(`پروتکل ${protocol} پشتیبانی نمی‌شود. از VLESS، VMess، Trojan، Shadowsocks، HTTP یا SOCKS استفاده کنید.`);
}

function validPort(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('پورت پراکسی نامعتبر است.');
  return port;
}

function streamSettings(params: URLSearchParams, defaultSecurity = 'none'): any {
  const network = params.get('type') || 'tcp';
  const security = params.get('security') || defaultSecurity;
  if (!['tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp'].includes(network)) throw new Error(`نوع انتقال ${network} پشتیبانی نمی‌شود.`);
  if (!['none', 'tls', 'reality'].includes(security)) throw new Error('نوع امنیت کانفیگ پشتیبانی نمی‌شود.');
  const settings: any = { network, security };
  const serverName = params.get('sni') || params.get('serverName') || params.get('host') || '';
  if (security === 'tls') settings.tlsSettings = { serverName, fingerprint: params.get('fp') || 'chrome',
    ...(params.get('alpn') ? { alpn: params.get('alpn')!.split(',') } : {}) };
  if (security === 'reality') settings.realitySettings = { serverName, fingerprint: params.get('fp') || 'chrome',
    publicKey: params.get('pbk') || '', shortId: params.get('sid') || '', spiderX: params.get('spx') || '' };
  if (network === 'ws') settings.wsSettings = { path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : {} };
  if (network === 'grpc') settings.grpcSettings = { serviceName: params.get('serviceName') || '', multiMode: params.get('mode') === 'multi' };
  if (network === 'httpupgrade' || network === 'xhttp') settings[`${network}Settings`] = { path: params.get('path') || '/', host: params.get('host') || '', ...(network === 'xhttp' ? { mode: params.get('mode') || 'auto' } : {}) };
  if ((network === 'tcp' || network === 'raw') && params.get('headerType') && params.get('headerType') !== 'none') throw new Error('هدر TCP این کانفیگ پشتیبانی نمی‌شود.');
  return settings;
}

export function parseProxyUri(raw: string): { protocol: string; server: string; port: number; name: string } {
  const trimmed = raw.trim();
  const outbound = buildOutbound(trimmed);
  const node = outbound.settings.vnext?.[0] || outbound.settings.servers[0];
  const vm = trimmed.startsWith('vmess://') ? JSON.parse(Buffer.from(trimmed.slice(8), 'base64').toString('utf8')) : null;
  const protocol = trimmed.split(':')[0];
  const hash = trimmed.includes('#') ? trimmed.slice(trimmed.indexOf('#') + 1) : '';
  return { protocol, server: node.address, port: node.port,
    name: vm?.ps || (hash ? decodeURIComponent(hash) : `${protocol.toUpperCase()}-${node.address}:${node.port}`) };
}

export interface ProxyLease { url: string; release: () => void }

// Each browser owns a tunnel for its lifetime. No direct-connection fallback.
export async function startProxy(raw: string): Promise<ProxyLease> {
  const outbound = buildOutbound(raw.trim());
  const url = ['http', 'https', 'socks', 'socks5'].includes(raw.split(':')[0]) ? new URL(raw) : null;
  if (url && !url.username && !url.password) {
    if (url.protocol === 'socks:') url.protocol = 'socks5:';
    return { url: `${url.protocol}//${url.host}`, release() {} };
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-bot-xray-'));
  fs.chmodSync(dir, 0o700);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ log: { loglevel: 'none' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [outbound] }), { mode: 0o600 });
  const child = spawn(process.env.XRAY_BIN || 'xray', ['run', '-config', configPath], { stdio: 'ignore' });
  let failure = '';
  let exited = false;
  child.once('error', () => { failure = 'اجرای Xray ناموفق بود. Xray را نصب کنید یا XRAY_BIN را تنظیم کنید.'; });
  child.once('exit', () => { exited = true; });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  try {
    for (let i = 0; i < 100; i++) {
      if (failure || exited) throw new Error(failure || 'Xray کانفیگ را نپذیرفت یا متوقف شد.');
      const ready = await new Promise<boolean>(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(100);
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.once('timeout', () => done(false));
      });
      if (ready && !exited && !failure) return { url: `socks5://127.0.0.1:${port}`, release };
      await sleep(100);
    }
    throw new Error('مهلت راه‌اندازی پراکسی محلی Xray تمام شد.');
  } catch (err) {
    release();
    throw err;
  }
}

export async function measureProxyDualPing(raw: string): Promise<{
  reachable: boolean; google_latency: number | null; x_latency: number | null; latency: number | null;
}> {
  let lease: ProxyLease | undefined;
  const failed = { reachable: false, google_latency: null, x_latency: null, latency: null };
  try {
    lease = await startProxy(raw);
    const proxyUrl = lease.url.replace(/^socks5:/, 'socks5h:');
    const probe = async (target: string) => {
      try {
        const { stdout } = await runFile('curl', ['--silent', '--show-error', '--noproxy', '', '--proxy', proxyUrl,
          '--max-time', '15', '--output', os.devNull, '--write-out', '%{http_code} %{time_total}', target], { timeout: 17000 });
        const [status, seconds] = stdout.trim().split(' ').map(Number);
        return status >= 200 && status < 400 && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
      } catch { return null; }
    };
    const [google, x] = await Promise.all([probe('https://www.google.com/generate_204'), probe('https://x.com/')]);
    return { reachable: google !== null && x !== null, google_latency: google, x_latency: x,
      latency: google !== null && x !== null ? Math.round((google + x) / 2) : null };
  } catch { return failed; }
  finally { lease?.release(); }
}
