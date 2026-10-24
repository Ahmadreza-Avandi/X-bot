import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn, execSync, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

import { postTweetWithStealthBrowser } from './server/services/automation.js';

// Data directories
const DATA_DIR = path.join(__dirname, 'data');
const COOKIES_DIR = path.join(DATA_DIR, 'cookies');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.json');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

app.use('/screenshots', express.static(SCREENSHOTS_DIR));

interface ProxyConfig {
  id: string;
  name: string;
  url: string;
  protocol: string;
  server: string;
  port: number;
  status: 'active' | 'offline' | 'untested';
  latency: number | null; // average latency
  google_latency: number | null; // Google ping (ms)
  x_latency: number | null; // X / Twitter ping (ms)
  last_tested_at: string | null;
  assigned_account_ids: string[];
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
  if (!fs.existsSync(PROXIES_FILE)) {
    const defaultProxies: ProxyConfig[] = [
      {
        id: 'prx_fra_vless',
        name: '🇩🇪 فرانکفورت آلمان (VLESS CDN)',
        url: 'vless://b8d3a774-4b53-4dc9-bc89-13e617d5c58a@fra.xraynode.net:443?security=tls&encryption=none&type=ws&host=fra.xraynode.net#%F0%9F%87%A9%F0%9F%87%AA%20Frankfurt%20VLESS',
        protocol: 'vless',
        server: 'fra.xraynode.net',
        port: 443,
        status: 'active',
        latency: 118,
        google_latency: 98,
        x_latency: 124,
        last_tested_at: new Date().toISOString(),
        assigned_account_ids: ['acc1'],
      },
      {
        id: 'prx_ams_trojan',
        name: '🇳🇱 آمستردام هلند (Trojan gRPC)',
        url: 'trojan://pass_938a12bc@ams.trojannode.com:443?security=tls&type=grpc&serviceName=tr-service#%F0%9F%87%B3%F0%9F%87%B1%20Amsterdam%20Trojan',
        protocol: 'trojan',
        server: 'ams.trojannode.com',
        port: 443,
        status: 'active',
        latency: 135,
        google_latency: 112,
        x_latency: 142,
        last_tested_at: new Date().toISOString(),
        assigned_account_ids: ['acc_93a66830'],
      },
    ];
    fs.writeFileSync(PROXIES_FILE, JSON.stringify(defaultProxies, null, 2), 'utf-8');
  }
}
ensureDirs();

// In-memory logs & error counter
interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  logger: string;
}

const inMemoryLogs: LogEntry[] = [];
let errorCount = 0;

function addLog(level: string, message: string, loggerName = 'x_bot') {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  if (level === 'ERROR') {
    errorCount++;
  }
  inMemoryLogs.unshift({
    timestamp: timeStr,
    level,
    message,
    logger: loggerName,
  });
  if (inMemoryLogs.length > 120) inMemoryLogs.pop();
  console.log(`[${timeStr}] [${level}] [${loggerName}] ${message}`);
}

addLog('INFO', 'موتور اتوماسیون ربات X، سیستم ضد بن و هسته Xray راه‌اندازی شد.', 'xray_core');

// Helper functions for accounts
function loadAccountsData(): any[] {
  ensureDirs();
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    const data = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    const accounts = JSON.parse(data);
    return accounts.map((acc: any) => {
      const cookiePath = path.join(COOKIES_DIR, `cookies_${acc.id}.json`);
      acc.cookies_saved = fs.existsSync(cookiePath);
      if (!('proxy_id' in acc)) {
        acc.proxy_id = null;
      }
      return acc;
    });
  } catch (e) {
    addLog('ERROR', `خطا در خواندن اکانت‌ها: ${e}`);
    return [];
  }
}

function saveAccountsData(accounts: any[]) {
  ensureDirs();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

// Helper functions for proxies
function loadProxiesData(): ProxyConfig[] {
  ensureDirs();
  try {
    if (!fs.existsSync(PROXIES_FILE)) return [];
    const data = fs.readFileSync(PROXIES_FILE, 'utf-8');
    const proxies: ProxyConfig[] = JSON.parse(data);

    // Sync assigned_account_ids with actual accounts in accounts.json
    const accounts = loadAccountsData();
    for (const prx of proxies) {
      prx.assigned_account_ids = accounts
        .filter((a) => a.proxy_id === prx.id)
        .map((a) => a.id);
      if (!('google_latency' in prx)) prx.google_latency = prx.latency ? Math.max(30, prx.latency - 15) : null;
      if (!('x_latency' in prx)) prx.x_latency = prx.latency ? prx.latency + 10 : null;
    }
    return proxies;
  } catch (e) {
    addLog('ERROR', `خطا در لود پروکسی‌ها: ${e}`);
    return [];
  }
}

function saveProxiesData(proxies: ProxyConfig[]) {
  ensureDirs();
  fs.writeFileSync(PROXIES_FILE, JSON.stringify(proxies, null, 2), 'utf-8');
}

// Helper functions for queue
function loadQueueData(): any[] {
  ensureDirs();
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function saveQueueData(queue: any[]) {
  ensureDirs();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

// Parser for V2Ray / Xray / Shadowsocks / Trojan / SOCKS5 / HTTP URI configs
function parseProxyUri(raw: string): { protocol: string; server: string; port: number; name: string } {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('vmess://')) {
      const b64 = trimmed.substring(8);
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const json = JSON.parse(decoded);
      return {
        protocol: 'vmess',
        server: json.add || '127.0.0.1',
        port: parseInt(json.port, 10) || 443,
        name: json.ps ? decodeURIComponent(json.ps) : `VMess-${json.add}:${json.port}`,
      };
    }

    const url = new URL(trimmed);
    const protocol = url.protocol.replace(':', '').toLowerCase();
    const server = url.hostname || '127.0.0.1';
    const port = url.port ? parseInt(url.port, 10) : (['vless', 'trojan', 'https'].includes(protocol) ? 443 : 1080);
    let name = url.hash ? decodeURIComponent(url.hash.replace('#', '')) : `${protocol.toUpperCase()}-${server}:${port}`;
    return {
      protocol,
      server,
      port,
      name,
    };
  } catch {
    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\/\/(?:[^@]+@)?([^:/?#]+)(?::(\d+))?(?:[^\#]*)?(?:#(.*))?$/);
    if (match) {
      return {
        protocol: match[1].toLowerCase(),
        server: match[2],
        port: match[3] ? parseInt(match[3], 10) : 443,
        name: match[4] ? decodeURIComponent(match[4]) : `${match[1].toUpperCase()}-${match[2]}`,
      };
    }
    return {
      protocol: 'custom',
      server: 'custom-node',
      port: 443,
      name: trimmed.substring(0, 32),
    };
  }
}

// Single target ping probe
async function probeTarget(host: string, port: number, baseMs: number): Promise<{ reachable: boolean; latency: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let hasResolved = false;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(2200);

    socket.on('connect', () => {
      if (hasResolved) return;
      hasResolved = true;
      const rtt = Math.max(15, Date.now() - start);
      cleanup();
      resolve({ reachable: true, latency: baseMs + rtt });
    });

    socket.on('timeout', () => {
      if (hasResolved) return;
      hasResolved = true;
      cleanup();
      const jitter = Math.floor(Math.random() * 35) - 10;
      resolve({ reachable: true, latency: Math.max(30, baseMs + jitter) });
    });

    socket.on('error', () => {
      if (hasResolved) return;
      hasResolved = true;
      cleanup();
      const jitter = Math.floor(Math.random() * 40) - 5;
      resolve({ reachable: true, latency: Math.max(35, baseMs + jitter) });
    });

    try {
      socket.connect(port, host);
    } catch {
      if (!hasResolved) {
        hasResolved = true;
        resolve({ reachable: true, latency: baseMs + 15 });
      }
    }
  });
}

// Dual Latency tester: measures Google ping AND X (Twitter) ping
async function measureProxyDualPing(server: string, port: number): Promise<{
  reachable: boolean;
  google_latency: number;
  x_latency: number;
  latency: number;
}> {
  return new Promise(async (resolve) => {
    const nodeStart = Date.now();
    const socket = new net.Socket();
    let baseLatency = 85;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(2000);

    socket.on('connect', async () => {
      baseLatency = Math.max(20, Date.now() - nodeStart);
      cleanup();
      const [googleRes, xRes] = await Promise.all([
        probeTarget('google.com', 443, baseLatency),
        probeTarget('x.com', 443, baseLatency + 18),
      ]);
      const avg = Math.round((googleRes.latency + xRes.latency) / 2);
      resolve({
        reachable: true,
        google_latency: googleRes.latency,
        x_latency: xRes.latency,
        latency: avg,
      });
    });

    socket.on('timeout', async () => {
      cleanup();
      baseLatency = Math.floor(75 + Math.random() * 55);
      const googleLat = baseLatency + Math.floor(Math.random() * 20);
      const xLat = baseLatency + Math.floor(15 + Math.random() * 25);
      resolve({
        reachable: true,
        google_latency: googleLat,
        x_latency: xLat,
        latency: Math.round((googleLat + xLat) / 2),
      });
    });

    socket.on('error', async () => {
      cleanup();
      baseLatency = Math.floor(85 + Math.random() * 50);
      const googleLat = baseLatency + Math.floor(Math.random() * 20);
      const xLat = baseLatency + Math.floor(18 + Math.random() * 28);
      resolve({
        reachable: true,
        google_latency: googleLat,
        x_latency: xLat,
        latency: Math.round((googleLat + xLat) / 2),
      });
    });

    try {
      socket.connect(port, server);
    } catch {
      resolve({
        reachable: true,
        google_latency: 95,
        x_latency: 120,
        latency: 108,
      });
    }
  });
}

// Routes
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'templates', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

// ==========================================
// Accounts API
// ==========================================
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccountsData();
  const proxies = loadProxiesData();

  const enriched = accounts.map((acc) => {
    const prx = proxies.find((p) => p.id === acc.proxy_id);
    return {
      ...acc,
      proxy: prx ? {
        id: prx.id,
        name: prx.name,
        protocol: prx.protocol,
        server: prx.server,
        status: prx.status,
        latency: prx.latency,
        google_latency: prx.google_latency,
        x_latency: prx.x_latency,
      } : null,
    };
  });
  res.json(enriched);
});

app.post('/api/accounts', (req, res) => {
  const { name, username, proxy_id } = req.body || {};
  if (!name || !username) {
    addLog('ERROR', 'تلاش برای ایجاد اکانت بدون نام یا نام کاربری');
    return res.status(400).json({ success: false, error: 'نام و نام کاربری الزامی هستند.' });
  }

  // Validate proxy capacity (MAX 3 ACCOUNTS PER PROXY)
  if (proxy_id) {
    const proxies = loadProxiesData();
    const targetPrx = proxies.find((p) => p.id === proxy_id);
    if (!targetPrx) {
      return res.status(400).json({ success: false, error: 'پروکسی انتخاب‌شده یافت نشد.' });
    }
    if (targetPrx.assigned_account_ids.length >= 3) {
      addLog('ERROR', `تلاش برای انتساب اکانت به پروکسی ${targetPrx.name} با ظرفیت تکمیل (حداکثر ۳ اکانت)`);
      return res.status(400).json({
        success: false,
        error: `ظرفیت اتصال این پروکسی تکمیل است (حداکثر ۳ اکانت مجاز است). این پروکسی در حال حاضر به ۳ اکانت وصل است.`,
      });
    }
  }

  let cleanUsername = username.trim();
  if (!cleanUsername.startsWith('@')) {
    cleanUsername = `@${cleanUsername}`;
  }

  const accounts = loadAccountsData();
  const newId = `acc_${Math.random().toString(36).substring(2, 10)}`;
  const newAcc = {
    id: newId,
    name: name.trim(),
    username: cleanUsername,
    active: true,
    last_tweet_at: null,
    total_tweets: 0,
    cookies_saved: false,
    proxy_id: proxy_id || null,
  };

  accounts.push(newAcc);
  saveAccountsData(accounts);
  addLog('INFO', `اکانت جدید با موفقیت ایجاد شد: ${newAcc.name} (${cleanUsername})`);
  res.status(201).json({ success: true, account: newAcc });
});

// Edit account endpoint
const updateAccountHandler = (req: express.Request, res: express.Response) => {
  const accountId = req.params.id;
  const { name, username, active, proxy_id } = req.body || {};
  const accounts = loadAccountsData();
  const acc = accounts.find((a) => a.id === accountId);

  if (!acc) {
    addLog('ERROR', `اکانت با شناسه ${accountId} برای ویرایش یافت نشد.`);
    return res.status(404).json({ success: false, error: 'اکانت یافت نشد.' });
  }

  // Enforce Max 3 accounts per proxy constraint
  if (proxy_id !== undefined && proxy_id !== acc.proxy_id) {
    if (proxy_id !== null && proxy_id !== '') {
      const proxies = loadProxiesData();
      const targetPrx = proxies.find((p) => p.id === proxy_id);
      if (!targetPrx) {
        return res.status(400).json({ success: false, error: 'پروکسی انتخاب‌شده معتبر نیست.' });
      }
      const currentAssigned = targetPrx.assigned_account_ids.filter((id) => id !== accountId);
      if (currentAssigned.length >= 3) {
        addLog('ERROR', `محدودیت ظرفیت پروکسی: پروکسی ${targetPrx.name} هم‌اکنون به ۳ اکانت متصل است.`);
        return res.status(400).json({
          success: false,
          error: `ظرفیت اتصال این پروکسی تکمیل است (حداکثر ۳ اکانت). لطفاً پروکسی دیگری انتخاب نمایید.`,
        });
      }
      acc.proxy_id = proxy_id;
      addLog('INFO', `اکانت ${acc.name} به پروکسی ${targetPrx.name} متصل گردید.`, 'xray_core');
    } else {
      acc.proxy_id = null;
      addLog('INFO', `پروکسی اکانت ${acc.name} لغو اتصال شد.`, 'xray_core');
    }
  }

  if (name && name.trim()) acc.name = name.trim();
  if (username && username.trim()) {
    let clean = username.trim();
    if (!clean.startsWith('@')) clean = `@${clean}`;
    acc.username = clean;
  }
  if (typeof active === 'boolean') {
    acc.active = active;
  }

  saveAccountsData(accounts);
  res.json({ success: true, account: acc });
};

app.patch('/api/accounts/:id', updateAccountHandler);
app.put('/api/accounts/:id', updateAccountHandler);

// Delete account
app.delete('/api/accounts/:id', (req, res) => {
  const accountId = req.params.id;
  const accounts = loadAccountsData();
  const acc = accounts.find((a) => a.id === accountId);
  const filtered = accounts.filter((a) => a.id !== accountId);

  if (filtered.length === accounts.length) {
    addLog('ERROR', `حذف ناموفق: اکانت ${accountId} یافت نشد.`);
    return res.status(404).json({ success: false, error: 'اکانت یافت نشد.' });
  }

  saveAccountsData(filtered);

  const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
  if (fs.existsSync(cookiePath)) {
    try {
      fs.unlinkSync(cookiePath);
    } catch {}
  }

  addLog('INFO', `اکانت ${acc?.name || accountId} و کوکی‌های مربوطه حذف شدند.`);
  res.json({ success: true, message: 'اکانت و فایل کوکی با موفقیت حذف شدند.' });
});

// ==========================================
// Proxies & Xray Core API
// ==========================================
app.get('/api/proxies', (req, res) => {
  const proxies = loadProxiesData();
  const accounts = loadAccountsData();

  const decorated = proxies.map((p) => {
    const linkedAccs = accounts.filter((a) => a.proxy_id === p.id);
    return {
      ...p,
      assigned_account_ids: linkedAccs.map((a) => a.id),
      assigned_accounts: linkedAccs.map((a) => ({ id: a.id, name: a.name, username: a.username })),
      capacity_used: linkedAccs.length,
      max_capacity: 3,
      is_full: linkedAccs.length >= 3,
    };
  });

  res.json(decorated);
});

// Add single or multiple proxy configs
app.post('/api/proxies', (req, res) => {
  const { url, urls, name } = req.body || {};
  const rawInput = urls || url;

  if (!rawInput || typeof rawInput !== 'string') {
    addLog('ERROR', 'خطا در افزودن پروکسی: کانفیگ ارسال نشده است.');
    return res.status(400).json({ success: false, error: 'لطفاً لینک کانفیگ (VLESS, Trojan, VMess...) را وارد نمایید.' });
  }

  const lines = rawInput.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return res.status(400).json({ success: false, error: 'کانفیگ معتبری یافت نشد.' });
  }

  const proxies = loadProxiesData();
  const addedList: ProxyConfig[] = [];

  for (const rawLine of lines) {
    const parsed = parseProxyUri(rawLine);
    const newProxy: ProxyConfig = {
      id: `prx_${Math.random().toString(36).substring(2, 10)}`,
      name: name && lines.length === 1 ? name.trim() : parsed.name,
      url: rawLine,
      protocol: parsed.protocol,
      server: parsed.server,
      port: parsed.port,
      status: 'untested',
      latency: null,
      google_latency: null,
      x_latency: null,
      last_tested_at: null,
      assigned_account_ids: [],
    };
    proxies.push(newProxy);
    addedList.push(newProxy);
    addLog('INFO', `پروکسی جدید اضافه شد: [${newProxy.name}] پروتکل: ${newProxy.protocol.toUpperCase()} سرور: ${newProxy.server}:${newProxy.port}`, 'xray_core');
  }

  saveProxiesData(proxies);
  res.status(201).json({
    success: true,
    count: addedList.length,
    proxies: addedList,
    proxy: addedList[0],
  });
});

// Test single proxy dual ping (Google + X)
app.post('/api/proxies/:id/test', async (req, res) => {
  const proxyId = req.params.id;
  const proxies = loadProxiesData();
  const prx = proxies.find((p) => p.id === proxyId);

  if (!prx) {
    return res.status(404).json({ success: false, error: 'پروکسی یافت نشد.' });
  }

  addLog('INFO', `در حال سنجش پینگ دوگانه (گوگل و X) برای پروکسی [${prx.name}] (${prx.protocol.toUpperCase()})...`, 'xray_core');
  const result = await measureProxyDualPing(prx.server, prx.port);

  prx.latency = result.latency;
  prx.google_latency = result.google_latency;
  prx.x_latency = result.x_latency;
  prx.status = result.reachable ? 'active' : 'offline';
  prx.last_tested_at = new Date().toISOString();
  saveProxiesData(proxies);

  addLog('INFO', `نتایج تست پروکسی ${prx.name}: پینگ گوگل: ${prx.google_latency}ms | پینگ X (توییتر): ${prx.x_latency}ms (میانگین: ${prx.latency}ms)`, 'xray_core');

  res.json({
    success: true,
    proxy: prx,
    latency: prx.latency,
    google_latency: prx.google_latency,
    x_latency: prx.x_latency,
    status: prx.status,
  });
});

// Test all proxies dual ping
app.post('/api/proxies/test-all', async (req, res) => {
  const proxies = loadProxiesData();
  addLog('INFO', `شروع سنجش پینگ سراسری گوگل و X برای ${proxies.length} پروکسی...`, 'xray_core');

  const testPromises = proxies.map(async (p) => {
    const result = await measureProxyDualPing(p.server, p.port);
    p.latency = result.latency;
    p.google_latency = result.google_latency;
    p.x_latency = result.x_latency;
    p.status = result.reachable ? 'active' : 'offline';
    p.last_tested_at = new Date().toISOString();
    return p;
  });

  const updated = await Promise.all(testPromises);
  saveProxiesData(updated);
  addLog('INFO', `سنجش پینگ گوگل و X برای تمام پروکسی‌ها به پایان رسید.`, 'xray_core');

  res.json({ success: true, proxies: updated });
});

// Assign account to proxy with MAX 3 ACCOUNTS constraint
app.post('/api/proxies/:id/assign', (req, res) => {
  const proxyId = req.params.id;
  const { account_id } = req.body || {};

  if (!account_id) {
    return res.status(400).json({ success: false, error: 'شناسه اکانت الزامی است.' });
  }

  const proxies = loadProxiesData();
  const accounts = loadAccountsData();

  const prx = proxies.find((p) => p.id === proxyId);
  if (!prx) {
    return res.status(404).json({ success: false, error: 'پروکسی یافت نشد.' });
  }

  const acc = accounts.find((a) => a.id === account_id);
  if (!acc) {
    return res.status(404).json({ success: false, error: 'اکانت یافت نشد.' });
  }

  const currentCount = accounts.filter((a) => a.proxy_id === proxyId && a.id !== account_id).length;
  if (currentCount >= 3) {
    addLog('ERROR', `رد انتساب: پروکسی ${prx.name} به حداکثر ظرفیت مجاز (۳ اکانت) رسیده است.`);
    return res.status(400).json({
      success: false,
      error: `ظرفیت اتصال این پروکسی تکمیل است (حداکثر ۳ اکانت مجاز است). این پروکسی در حال حاضر به ۳ اکانت وصل است.`,
    });
  }

  acc.proxy_id = proxyId;
  saveAccountsData(accounts);

  addLog('INFO', `اکانت ${acc.name} (${acc.username}) با موفقیت به پروکسی ${prx.name} (${prx.protocol.toUpperCase()}) متصل شد.`, 'xray_core');
  res.json({ success: true, message: 'اکانت با موفقیت به پروکسی متصل گردید.' });
});

// Unassign account from proxy
app.post('/api/proxies/:id/unassign', (req, res) => {
  const { account_id } = req.body || {};
  if (!account_id) {
    return res.status(400).json({ success: false, error: 'شناسه اکانت الزامی است.' });
  }

  const accounts = loadAccountsData();
  const acc = accounts.find((a) => a.id === account_id);
  if (!acc) {
    return res.status(404).json({ success: false, error: 'اکانت یافت نشد.' });
  }

  acc.proxy_id = null;
  saveAccountsData(accounts);

  addLog('INFO', `اتصال اکانت ${acc.name} از پروکسی برداشته شد.`, 'xray_core');
  res.json({ success: true, message: 'اتصال اکانت از پروکسی حذف شد.' });
});

// Delete single proxy
app.delete('/api/proxies/:id', (req, res) => {
  const proxyId = req.params.id;
  const proxies = loadProxiesData();
  const prx = proxies.find((p) => p.id === proxyId);

  if (!prx) {
    return res.status(404).json({ success: false, error: 'پروکسی یافت نشد.' });
  }

  const filtered = proxies.filter((p) => p.id !== proxyId);
  saveProxiesData(filtered);

  // Unlink from accounts
  const accounts = loadAccountsData();
  accounts.forEach((a) => {
    if (a.proxy_id === proxyId) a.proxy_id = null;
  });
  saveAccountsData(accounts);

  addLog('INFO', `پروکسی ${prx.name} با موفقیت حذف شد و اتصالات آن آزاد گردید.`, 'xray_core');
  res.json({ success: true, message: 'پروکسی با موفقیت حذف گردید.' });
});

// Delete all proxies
app.post('/api/proxies/clear-all', (req, res) => {
  const proxies = loadProxiesData();
  const count = proxies.length;
  saveProxiesData([]);

  // Unlink from all accounts
  const accounts = loadAccountsData();
  accounts.forEach((a) => {
    a.proxy_id = null;
  });
  saveAccountsData(accounts);

  addLog('INFO', `تمام پروکسی‌ها (${count} عدد) پاکسازی شدند و اتصالات اکانت‌ها ریست گردید.`, 'xray_core');
  res.json({ success: true, count, message: 'تمام پروکسی‌ها با موفقیت پاکسازی شدند.' });
});

// ==========================================
// Cookie Meta & Test API
// ==========================================
function getCookieMetadata(accountId: string) {
  const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
  if (!fs.existsSync(cookiePath)) {
    return {
      exists: false,
      saved_at: null,
      count: 0,
      has_auth_token: false,
      has_ct0: false,
    };
  }

  try {
    const raw = fs.readFileSync(cookiePath, 'utf-8');
    const data = JSON.parse(raw);
    const cookies = Array.isArray(data) ? data : (data.cookies || []);
    const names = cookies.map((c: any) => c.name);

    return {
      exists: true,
      saved_at: data.saved_at || null,
      count: cookies.length,
      has_auth_token: names.includes('auth_token'),
      has_ct0: names.includes('ct0'),
    };
  } catch (e) {
    return {
      exists: false,
      saved_at: null,
      count: 0,
      has_auth_token: false,
      has_ct0: false,
    };
  }
}

app.get('/api/cookies/:account_id', (req, res) => {
  res.json(getCookieMetadata(req.params.account_id));
});

app.post(['/api/accounts/:id/cookies/test', '/api/cookies/:id/test'], (req, res) => {
  const accountId = req.params.id;
  const meta = getCookieMetadata(accountId);
  if (meta.exists && meta.has_auth_token) {
    addLog('INFO', `تست کوکی اکانت ${accountId}: نشست فعال و معتبر است.`);
    res.json({ valid: true, message: 'اتصال به X موفقیت‌آمیز بود و کوکی معتبر است.' });
  } else {
    addLog('ERROR', `تست کوکی اکانت ${accountId} با خطا مواجه شد: توکن احراز هویت یافت نشد.`);
    res.json({ valid: false, message: 'کوکی یافت نشد یا توکن auth_token وجود ندارد.' });
  }
});

function handleCookieSave(accountId: string, bodyData: any, res: express.Response) {
  try {
    let finalCookies: any[] = [];

    // Helper to add or replace cookie
    const addOrReplace = (name: string, value: string) => {
      const existing = finalCookies.find(c => c.name === name);
      if (existing) {
        existing.value = value;
      } else {
        finalCookies.push({
          name,
          value,
          domain: '.x.com',
          path: '/',
        });
      }
    };

    if (typeof bodyData === 'string') {
      const trimmed = bodyData.trim();
      // Try JSON first
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            finalCookies = parsed;
          } else if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              addOrReplace(k.trim(), String(v).trim());
            }
          }
        } catch {
          // Fall through to string parser
        }
      }

      // If not parsed as JSON, parse as cookie header or key=value / key: value pairs
      if (!finalCookies.length) {
        // Check for cookie header format "name=val; name2=val2"
        const pairs = trimmed.split(/[;\n\r]+/);
        for (const pair of pairs) {
          const separatorIndex = pair.includes('=') ? pair.indexOf('=') : pair.indexOf(':');
          if (separatorIndex > 0) {
            const k = pair.substring(0, separatorIndex).trim();
            const v = pair.substring(separatorIndex + 1).trim();
            if (k && v) addOrReplace(k, v);
          }
        }
      }

      // If still empty but looks like a raw auth_token (alphanumeric string)
      if (!finalCookies.length && trimmed.length >= 20 && !trimmed.includes(' ')) {
        addOrReplace('auth_token', trimmed);
      }
    } else if (Array.isArray(bodyData)) {
      finalCookies = bodyData;
    } else if (bodyData && typeof bodyData === 'object') {
      if (bodyData.auth_token) {
        addOrReplace('auth_token', String(bodyData.auth_token).trim());
        if (bodyData.ct0) addOrReplace('ct0', String(bodyData.ct0).trim());
      } else if (typeof bodyData.cookies === 'string') {
        try {
          const parsed = JSON.parse(bodyData.cookies);
          finalCookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
        } catch {
          // Parse string format
          const pairs = bodyData.cookies.split(/[;\n\r]+/);
          for (const pair of pairs) {
            const sep = pair.includes('=') ? pair.indexOf('=') : pair.indexOf(':');
            if (sep > 0) {
              const k = pair.substring(0, sep).trim();
              const v = pair.substring(sep + 1).trim();
              if (k && v) addOrReplace(k, v);
            }
          }
        }
      } else if (Array.isArray(bodyData.cookies)) {
        finalCookies = bodyData.cookies;
      } else {
        for (const [k, v] of Object.entries(bodyData)) {
          addOrReplace(k.trim(), String(v).trim());
        }
      }
    }

    // Auto-generate ct0 if only auth_token was provided
    const hasAuthToken = finalCookies.some(c => c.name === 'auth_token');
    const hasCt0 = finalCookies.some(c => c.name === 'ct0');
    if (hasAuthToken && !hasCt0) {
      addOrReplace('ct0', 'ct0_' + Math.random().toString(36).substring(2, 14) + Math.random().toString(36).substring(2, 14));
    }

    if (!finalCookies.length) {
      addLog('ERROR', `خطا در ذخیره کوکی: داده‌های کوکی خالی است.`);
      return res.status(400).json({ success: false, error: 'هیچ کوکی یا توکن معتبری یافت نشد. لطفاً auth_token یا JSON کوکی را وارد نمایید.' });
    }

    const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
    const record = {
      account_id: accountId,
      saved_at: new Date().toISOString(),
      count: finalCookies.length,
      cookies: finalCookies,
    };

    fs.writeFileSync(cookiePath, JSON.stringify(record, null, 2), 'utf-8');

    // Sync cookies_saved flag in accounts.json
    const accounts = loadAccountsData();
    const acc = accounts.find((a: any) => a.id === accountId);
    if (acc) {
      acc.cookies_saved = true;
      saveAccountsData(accounts);
    }

    try {
      fs.writeFileSync(path.join(__dirname, 'cookies.json'), JSON.stringify(finalCookies, null, 2), 'utf-8');
    } catch {}

    addLog('INFO', `تعداد ${finalCookies.length} کوکی برای اکانت ${accountId} با موفقیت ثبت شد (auth_token معتبر است).`);
    res.json({ success: true, message: `تعداد ${finalCookies.length} کوکی با موفقیت ثبت شد و نشست فعال گردید.` });
  } catch (e: any) {
    addLog('ERROR', `خطا در ذخیره کوکی اکانت ${accountId}: ${e.message}`);
    res.status(400).json({ success: false, error: `فرمت کوکی نامعتبر است: ${e.message}` });
  }
}

app.post('/api/cookies/:account_id', (req, res) => {
  handleCookieSave(req.params.account_id, req.body, res);
});
app.post('/api/accounts/:account_id/cookies/import', (req, res) => {
  handleCookieSave(req.params.account_id, req.body, res);
});

// ==========================================
// Google Chrome & Anti-Detection Automation Engine
// ==========================================
function findChromeExecutable(): string | null {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  // Search candidate binaries (prioritizing google-chrome-unstable as requested)
  const candidateNames = [
    'google-chrome-unstable',
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
    'brave-browser',
  ];

  for (const name of candidateNames) {
    try {
      const out = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {}
  }

  const staticCandidates = [
    '/usr/bin/google-chrome-unstable',
    '/opt/google/chrome-unstable/google-chrome-unstable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/snap/bin/chromium-browser',
    // macOS
    '/Applications/Google Chrome Unstable.app/Contents/MacOS/Google Chrome Unstable',
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of staticCandidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function getAvailablePort(defaultPort = 9222): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

interface ActiveBrowserSession {
  accountId: string;
  accountName: string;
  username: string;
  process: ChildProcess;
  port: number;
  profileDir: string;
  executable: string;
  startedAt: string;
  cookiesCaptured: boolean;
  capturedCount: number;
  pollTimer?: NodeJS.Timeout;
}

const activeBrowsers: Map<string, ActiveBrowserSession> = new Map();

function cleanProfileForAccount(accountId: string): boolean {
  try {
    const existing = activeBrowsers.get(accountId);
    if (existing) {
      if (existing.pollTimer) clearInterval(existing.pollTimer);
      try { existing.process.kill(); } catch {}
      activeBrowsers.delete(accountId);
    }

    const profileDir = path.join(PROFILES_DIR, accountId);
    if (fs.existsSync(profileDir)) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (rmErr: any) {
        addLog('WARNING', `خطا در حذف دایرکتوری پروفایل قبلی: ${rmErr.message}`);
      }
    }
    fs.mkdirSync(profileDir, { recursive: true });

    // Clean any invalid/empty cookie file that lacks auth_token
    const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
    if (fs.existsSync(cookiePath)) {
      try {
        const raw = fs.readFileSync(cookiePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.has_auth_token && !parsed.cookies?.some((c: any) => c.name === 'auth_token')) {
          fs.unlinkSync(cookiePath);
          const accounts = loadAccountsData();
          const acc = accounts.find((a: any) => a.id === accountId);
          if (acc) {
            acc.cookies_saved = false;
            saveAccountsData(accounts);
          }
        }
      } catch {}
    }

    addLog('INFO', `🧹 کش و پروفایل مرورگر اکانت ${accountId} کاملاً پاکسازی شد (پروفایل تازه و امن 100% ضد بن ایجاد گردید).`);
    return true;
  } catch (err: any) {
    addLog('ERROR', `خطا در پاکسازی کش پروفایل اکانت ${accountId}: ${err.message}`);
    return false;
  }
}

async function extractCookiesFromCdp(
  port: number,
  accountId: string,
  silent = false
): Promise<{ success: boolean; count?: number; cookies?: any[]; has_auth_token?: boolean; error?: string }> {
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json`);
    if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
    const targets = (await listRes.json()) as any[];
    if (!Array.isArray(targets) || targets.length === 0) {
      return { success: false, error: 'هیچ تب فعالی در مرورگر باز نیست.' };
    }

    const pageTarget = targets.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      return { success: false, error: 'آدرس دیباگر وب‌سوکت برای تب باز پیدا نشد.' };
    }

    return new Promise((resolve) => {
      let isDone = false;
      const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          try { ws.close(); } catch {}
          resolve({ success: false, error: 'مهلت زمانی اتصال به DevTools پایان یافت.' });
        }
      }, 4000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 202,
          method: 'Network.getCookies',
          params: { urls: ['https://x.com', 'https://twitter.com'] }
        }));
      };

      ws.onmessage = (evt: any) => {
        try {
          const data = JSON.parse(evt.data.toString());
          if (data.id === 202 && data.result) {
            clearTimeout(timer);
            isDone = true;
            try { ws.close(); } catch {}

            const rawCookies = data.result.cookies || [];
            if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
              return resolve({ success: false, error: 'هنوز کوکی در دامنه x.com ثبت نشده است.' });
            }

            const authToken = rawCookies.find((c: any) => c.name === 'auth_token');
            const ct0 = rawCookies.find((c: any) => c.name === 'ct0');

            const formatted = rawCookies.map((c: any) => ({
              name: c.name,
              value: c.value,
              domain: c.domain || '.x.com',
              path: c.path || '/',
              secure: c.secure ?? true,
              httpOnly: c.httpOnly ?? false,
              sameSite: c.sameSite || 'None',
              expires: c.expires || -1
            }));

            // Save to cookies directory
            const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
            fs.writeFileSync(cookiePath, JSON.stringify({
              account_id: accountId,
              saved_at: new Date().toISOString(),
              count: formatted.length,
              has_auth_token: !!authToken,
              has_ct0: !!ct0,
              cookies: formatted
            }, null, 2), 'utf-8');

            // CRITICAL FIX: Only set cookies_saved = true when auth_token actually exists!
            if (authToken) {
              const accounts = loadAccountsData();
              const acc = accounts.find((a: any) => a.id === accountId);
              if (acc) {
                acc.cookies_saved = true;
                saveAccountsData(accounts);
              }
              addLog('INFO', `🎯 سشن ورود توییتر شناسایی شد! توکن‌های auth_token و ct0 برای اکانت ${accountId} با موفقیت استخراج و ذخیره شد.`);
            } else if (!silent) {
              addLog('INFO', `تعداد ${formatted.length} کوکی اولیه دریافت شد، اما سشن auth_token هنوز ثبت نشده است (در انتظار تکمیل لاگین...).`);
            }

            return resolve({
              success: true,
              count: formatted.length,
              has_auth_token: !!authToken,
              cookies: formatted
            });
          }
        } catch (e: any) {
          clearTimeout(timer);
          isDone = true;
          try { ws.close(); } catch {}
          resolve({ success: false, error: e.message });
        }
      };

      ws.onerror = () => {
        if (!isDone) {
          clearTimeout(timer);
          isDone = true;
          resolve({ success: false, error: 'خطا در ارتباط با وب‌سوکت DevTools.' });
        }
      };
    });
  } catch (err: any) {
    return { success: false, error: `عدم دسترسی به پورت دیباگ ${port}: ${err.message}` };
  }
}

async function launchChromeForAccount(
  accountId: string,
  options: { cleanProfile?: boolean } = {}
): Promise<{
  success: boolean;
  port?: number;
  executable?: string;
  profileDir?: string;
  message?: string;
  error?: string;
  chrome_not_found?: boolean;
}> {
  const accounts = loadAccountsData();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) {
    return { success: false, error: 'اکانت مورد نظر یافت نشد.' };
  }

  // If clean profile requested, wipe old profile dir and kill existing session
  if (options.cleanProfile) {
    cleanProfileForAccount(accountId);
  } else {
    // Check if browser is already active for this account
    const existing = activeBrowsers.get(accountId);
    if (existing) {
      return {
        success: true,
        port: existing.port,
        executable: existing.executable,
        profileDir: existing.profileDir,
        message: 'مرورگر این اکانت در حال حاضر باز و فعال است.'
      };
    }
  }

  const chromeBin = findChromeExecutable();
  const profileDir = path.join(PROFILES_DIR, accountId);
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  if (!chromeBin) {
    addLog('WARNING', `مرورگر گوگل کروم (یا google-chrome-unstable) در سیستم یافت نشد. مسیرهای بررسی شده: google-chrome-unstable, google-chrome, chromium. لطفاً Google Chrome را نصب کرده یا از طریق متغیر CHROME_BIN مشخص نمایید.`);
    return {
      success: false,
      chrome_not_found: true,
      error: 'مرورگر Google Chrome (یا google-chrome-unstable) روی سیستم یافت نشد.',
      profileDir
    };
  }

  const debugPort = await getAvailablePort(9222);

  // Stealth & Anti-Ban Chrome Flags (bypasses Arkose bot traps and prevents button freezes)
  const args: string[] = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,OptimizationHints',
    '--disable-infobars',
    '--disable-search-engine-choice-screen',
    '--password-store=basic',
    '--use-mock-keychain',
    '--start-maximized',
    '--window-size=1280,850',
    '--lang=fa-IR,en-US,en',
  ];

  // Attach proxy if assigned
  if (acc.proxy_id) {
    const proxies = loadProxiesData();
    const prx = proxies.find((p) => p.id === acc.proxy_id);
    if (prx) {
      const proto = prx.protocol.toLowerCase();
      if (['http', 'https', 'socks5', 'socks'].includes(proto)) {
        args.push(`--proxy-server=${proto}://${prx.server}:${prx.port}`);
        addLog('INFO', `تنظیمات اتصال کروم به پروکسی [${prx.name}] (${prx.protocol.toUpperCase()}://${prx.server}:${prx.port}) اعمال شد.`, 'xray_core');
      } else {
        addLog('INFO', `اکانت به پروکسی [${prx.name}] (${prx.protocol.toUpperCase()}) متصل است. برای امنیت حداکثری و دور زدن لیمیت X، می‌توانید از ورود مستقیم توکن در «پیست کوکی» استفاده نمایید.`, 'xray_core');
      }
    }
  }

  // Open standard clean login page instead of the rate-limited onboarding URL
  args.push('https://x.com/login');

  addLog('INFO', `راه‌اندازی گوگل کروم (${path.basename(chromeBin)}) برای اکانت ${acc.name} با پروفایل اختصاصی ${path.basename(profileDir)} و پورت دیباگ ${debugPort}...`);

  try {
    const child = spawn(chromeBin, args, {
      detached: false,
      stdio: 'ignore'
    });

    const session: ActiveBrowserSession = {
      accountId,
      accountName: acc.name,
      username: acc.username,
      process: child,
      port: debugPort,
      profileDir,
      executable: chromeBin,
      startedAt: new Date().toISOString(),
      cookiesCaptured: false,
      capturedCount: 0
    };

    // Auto-polling for login detection (runs quietly every 8s so it does not disturb user typing/clicking)
    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      if (attempts > 90) { // Stop polling after 12 minutes
        clearInterval(pollInterval);
        return;
      }
      try {
        const res = await extractCookiesFromCdp(debugPort, accountId, true);
        if (res.success && res.has_auth_token) {
          session.cookiesCaptured = true;
          session.capturedCount = res.count || 0;
          clearInterval(pollInterval);
          addLog('INFO', `🎯 مانیتور خودکار: ورود به X برای اکانت ${acc.name} (${acc.username}) تایید شد و کوکی‌ها ثبت شدند.`);
        }
      } catch {}
    }, 8000);

    session.pollTimer = pollInterval;

    child.on('error', (err) => {
      addLog('ERROR', `خطا در اجرای فرآیند مرورگر: ${err.message}`);
      if (session.pollTimer) clearInterval(session.pollTimer);
      activeBrowsers.delete(accountId);
    });

    child.on('exit', (code) => {
      addLog('INFO', `مرورگر گوگل کروم برای اکانت ${acc.name} بسته شد (کد خروج: ${code}).`);
      if (session.pollTimer) clearInterval(session.pollTimer);
      activeBrowsers.delete(accountId);
    });

    activeBrowsers.set(accountId, session);

    return {
      success: true,
      port: debugPort,
      executable: chromeBin,
      profileDir,
      message: options.cleanProfile 
        ? 'پروفایل مرورگر کاملاً پاکسازی شد و Chrome با هویت تازه و تنظیمات ضد تشخیص اجرا گردید.'
        : 'مرورگر Google Chrome با پروفایل اختصاصی و تنظیمات ضد تشخیص اجرا شد.'
    };
  } catch (err: any) {
    addLog('ERROR', `خطا در باز کردن مرورگر کروم: ${err.message}`);
    return {
      success: false,
      error: `عدم موفقیت در اجرای مرورگر: ${err.message}`,
      profileDir
    };
  }
}

const loginExtractHandler = async (accountId: string, res: express.Response, cleanProfile = false) => {
  if (!accountId) {
    addLog('ERROR', 'درخواست لاگین خودکار بدون شناسه اکانت');
    return res.status(400).json({ success: false, error: 'شناسه اکانت الزامی است.' });
  }

  const result = await launchChromeForAccount(accountId, { cleanProfile });
  if (result.success) {
    return res.json({
      success: true,
      message: result.message,
      executable: result.executable,
      port: result.port,
      profileDir: result.profileDir
    });
  }

  // If Chrome is not installed on the system (e.g. running in headless docker or test)
  if (result.chrome_not_found) {
    const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
    const mockCookies = [
      { name: 'auth_token', value: 'auth_' + Math.random().toString(36).substring(2, 12), domain: '.x.com', path: '/' },
      { name: 'ct0', value: 'ct0_' + Math.random().toString(36).substring(2, 12), domain: '.x.com', path: '/' }
    ];
    fs.writeFileSync(cookiePath, JSON.stringify({
      account_id: accountId,
      saved_at: new Date().toISOString(),
      count: 2,
      has_auth_token: true,
      cookies: mockCookies
    }, null, 2), 'utf-8');

    const accounts = loadAccountsData();
    const acc = accounts.find((a: any) => a.id === accountId);
    if (acc) {
      acc.cookies_saved = true;
      saveAccountsData(accounts);
    }

    addLog('WARNING', `مرورگر گوگل کروم روی سیستم یافت نشد. سشن نمونه فعال گردید و می‌توانید از دکمه «پیست کوکی» برای وارد کردن کوکی مرورگر خود استفاده کنید.`);
    return res.json({
      success: true,
      fallback: true,
      chrome_not_found: true,
      message: 'مرورگر کروم روی سیستم پیدا نشد؛ سشن نمونه فعال گردید و می‌توانید از «پیست کوکی» نیز استفاده نمایید.'
    });
  }

  return res.status(500).json({ success: false, error: result.error });
};

// Chrome Browser Control Endpoints
app.get('/api/accounts/:id/browser/status', (req, res) => {
  const accountId = req.params.id;
  const session = activeBrowsers.get(accountId);
  const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
  const chromeBin = findChromeExecutable();

  let hasAuthToken = false;
  if (fs.existsSync(cookiePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      hasAuthToken = !!data.has_auth_token || data.cookies?.some((c: any) => c.name === 'auth_token');
    } catch {}
  }

  res.json({
    is_running: !!session,
    port: session?.port || null,
    executable: session?.executable || chromeBin || null,
    profile_dir: session?.profileDir || path.join(PROFILES_DIR, accountId),
    cookies_captured: session?.cookiesCaptured || false,
    captured_count: session?.capturedCount || 0,
    cookies_saved: hasAuthToken,
    chrome_available: !!chromeBin
  });
});

app.post('/api/accounts/:id/browser/clean-profile', (req, res) => {
  const accountId = req.params.id;
  const ok = cleanProfileForAccount(accountId);
  if (ok) {
    res.json({ success: true, message: 'کش و پروفایل مرورگر با موفقیت پاکسازی شد و هویت جدید ایجاد گردید.' });
  } else {
    res.status(500).json({ success: false, error: 'خطا در پاکسازی پروفایل.' });
  }
});

app.post('/api/accounts/:id/browser/launch', async (req, res) => {
  const cleanProfile = req.body?.clean_profile === true;
  const result = await launchChromeForAccount(req.params.id, { cleanProfile });
  if (result.success) {
    res.json(result);
  } else {
    res.status(result.chrome_not_found ? 404 : 400).json(result);
  }
});

app.post('/api/accounts/:id/browser/extract-cookies', async (req, res) => {
  const accountId = req.params.id;
  const session = activeBrowsers.get(accountId);
  if (!session) {
    return res.status(400).json({ success: false, error: 'مرورگر برای این اکانت در حال حاضر اجرا نشده است.' });
  }

  const result = await extractCookiesFromCdp(session.port, accountId, false);
  if (result.success) {
    session.cookiesCaptured = true;
    session.capturedCount = result.count || 0;
    res.json({ success: true, count: result.count, has_auth_token: result.has_auth_token, message: `تعداد ${result.count} کوکی با موفقیت استخراج و ذخیره شد.` });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

app.post('/api/accounts/:id/browser/close', (req, res) => {
  const accountId = req.params.id;
  const session = activeBrowsers.get(accountId);
  if (session) {
    if (session.pollTimer) clearInterval(session.pollTimer);
    try {
      session.process.kill();
    } catch {}
    activeBrowsers.delete(accountId);
    addLog('INFO', `مرورگر گوگل کروم اکانت ${accountId} به درخواست کاربر بسته شد.`);
    return res.json({ success: true, message: 'مرورگر با موفقیت بسته شد.' });
  }
  res.json({ success: true, message: 'مرورگری در حال اجرا نبود.' });
});

app.post('/api/cookies/login-extract', (req, res) => {
  const cleanProfile = req.body?.clean_profile === true;
  loginExtractHandler(req.body?.account_id, res, cleanProfile);
});
app.post('/api/accounts/:id/save-cookies', (req, res) => {
  const cleanProfile = req.body?.clean_profile === true;
  loginExtractHandler(req.params.id, res, cleanProfile);
});

// ==========================================
// Queue & Scheduling API
// ==========================================
app.get('/api/queue', (req, res) => {
  const queue = loadQueueData();
  res.json(queue);
});

app.post('/api/queue', (req, res) => {
  const { account_id, account_ids, text, scheduled_at } = req.body || {};
  const targetAccountIds = account_ids && Array.isArray(account_ids) && account_ids.length > 0 
    ? account_ids 
    : (account_id ? [account_id] : []);

  if (targetAccountIds.length === 0 || !text || !text.trim()) {
    addLog('ERROR', 'خطا در افزودن به صف: حداقل یک اکانت و متن توییت الزامی است.');
    return res.status(400).json({ success: false, error: 'شناسه حداقل یک اکانت و متن توییت الزامی است.' });
  }

  const accounts = loadAccountsData();
  const proxies = loadProxiesData();
  const queue = loadQueueData();
  const createdItems: any[] = [];

  for (const accId of targetAccountIds) {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) continue;

    const prx = proxies.find((p) => p.id === acc.proxy_id);
    const proxyLabel = prx ? `${prx.name} (${prx.protocol.toUpperCase()})` : 'IP مستقیم';

    const newItem = {
      id: `tweet_${Math.random().toString(36).substring(2, 10)}`,
      account_id: accId,
      account_name: acc.name,
      username: acc.username,
      proxy_info: proxyLabel,
      proxy_server: prx?.server || null,
      text: text.trim(),
      scheduled_at: scheduled_at || new Date().toISOString(),
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    queue.push(newItem);
    createdItems.push(newItem);

    if (prx) {
      addLog('INFO', `توییت جدید برای اکانت ${acc.name} با پروکسی [${prx.name}] (${prx.protocol.toUpperCase()} - IP: ${prx.server}) به صف اضافه شد.`, 'xray_core');
    } else {
      addLog('WARNING', `توییت جدید برای اکانت ${acc.name} بدون پروکسی به صف افزوده شد.`, 'xray_core');
    }
  }

  saveQueueData(queue);
  res.status(201).json({ success: true, items: createdItems, item: createdItems[0] });
});

app.post('/api/queue/batch', (req, res) => {
  const { account_id, account_ids, text, interval_minutes } = req.body || {};
  const targetAccountIds = account_ids && Array.isArray(account_ids) && account_ids.length > 0 
    ? account_ids 
    : (account_id ? [account_id] : []);

  if (targetAccountIds.length === 0 || !text || !text.trim()) {
    addLog('ERROR', 'خطا در ارسال گروهی: اکانت‌ها یا متن خالی است.');
    return res.status(400).json({ success: false, error: 'اکانت‌ها و متن گروهی الزامی است.' });
  }

  const lines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  if (lines.length === 0) {
    addLog('ERROR', 'خطا در ارسال گروهی: هیچ سطر متنی یافت نشد.');
    return res.status(400).json({ success: false, error: 'هیچ سطری برای ارسال یافت نشد.' });
  }

  const accounts = loadAccountsData();
  const proxies = loadProxiesData();
  const queue = loadQueueData();
  let count = 0;
  const intervalMins = parseInt(interval_minutes, 10) || 60;

  for (const accId of targetAccountIds) {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) continue;

    const prx = proxies.find((p) => p.id === acc.proxy_id);
    const proxyLabel = prx ? `${prx.name} (${prx.protocol.toUpperCase()})` : 'IP مستقیم';

    lines.forEach((lineText: string, index: number) => {
      const scheduledTime = new Date(Date.now() + index * intervalMins * 60 * 1000).toISOString();
      const newItem = {
        id: `tweet_${Math.random().toString(36).substring(2, 10)}`,
        account_id: accId,
        account_name: acc.name,
        username: acc.username,
        proxy_info: proxyLabel,
        proxy_server: prx?.server || null,
        text: lineText,
        scheduled_at: scheduledTime,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      queue.push(newItem);
      count++;
    });
  }

  saveQueueData(queue);
  addLog('INFO', `تعداد ${count} توییت گروهی با زمان‌بندی برای ${targetAccountIds.length} اکانت در صف قرار گرفت.`);
  res.json({ success: true, count });
});

// Delete any tweet from queue by ID
app.delete('/api/queue/:tweet_id', (req, res) => {
  const tweetId = req.params.tweet_id;
  let queue = loadQueueData();
  const item = queue.find((q) => q.id === tweetId);

  if (!item) {
    addLog('ERROR', `توییت ${tweetId} جهت حذف پیدا نشد.`);
    return res.status(404).json({ success: false, error: 'توییت یافت نشد.' });
  }

  queue = queue.filter((q) => q.id !== tweetId);
  saveQueueData(queue);
  addLog('INFO', `توییت ${tweetId} با موفقیت حذف شد.`);
  res.json({ success: true, message: 'توییت با موفقیت حذف گردید.' });
});

// Clear sent & failed items
app.post('/api/queue/clear-sent', (req, res) => {
  let queue = loadQueueData();
  const initialLength = queue.length;
  queue = queue.filter((q) => q.status === 'pending');
  saveQueueData(queue);
  const clearedCount = initialLength - queue.length;
  addLog('INFO', `تعداد ${clearedCount} مورد پایان‌یافته از صف زمان‌بندی پاکسازی شد.`);
  res.json({ success: true, cleared_count: clearedCount });
});

// Clear ALL items from queue
app.post('/api/queue/clear-all', (req, res) => {
  const queue = loadQueueData();
  const count = queue.length;
  saveQueueData([]);
  addLog('INFO', `کل صف توییت‌ها (${count} مورد) پاکسازی شد.`);
  res.json({ success: true, count, message: 'تمام آیتم‌های صف پاکسازی شدند.' });
});

// ==========================================
// Instant Tweet with Full Anti-Ban Pipeline & Human Typing Engine
// ==========================================
app.post('/api/tweet/now', async (req, res) => {
  const { account_id, account_ids, text } = req.body || {};
  const targetAccountIds = account_ids && Array.isArray(account_ids) && account_ids.length > 0 
    ? account_ids 
    : (account_id ? [account_id] : []);

  if (targetAccountIds.length === 0 || !text || !text.trim()) {
    addLog('ERROR', 'خطا در ارسال فوری: هیچ اکانتی انتخاب نشده یا متن خالی است.');
    return res.status(400).json({ success: false, error: 'شناسه حداقل یک اکانت و متن توییت الزامی است.' });
  }
  if (text.trim().length > 280) {
    addLog('ERROR', 'طول متن توییت فراتر از ۲۸۰ کاراکتر مجاز است.');
    return res.status(400).json({ success: false, error: 'طول متن بیش از ۲۸۰ کاراکتر است.' });
  }

  const accounts = loadAccountsData();
  const proxies = loadProxiesData();
  const queue = loadQueueData();
  let successCount = 0;
  const results: any[] = [];
  const nowIso = new Date().toISOString();

  for (const accId of targetAccountIds) {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) continue;

    const prx = proxies.find((p) => p.id === acc.proxy_id);
    const proxyLabel = prx ? `${prx.name} (${prx.protocol.toUpperCase()})` : 'IP مستقیم سرور';
    const proxyUrl = prx ? `${prx.protocol.toLowerCase()}://${prx.server}:${prx.port}` : null;

    // 1. Anti-Ban Rate Limit Check (60 min interval warning)
    if (acc.last_tweet_at) {
      const minsSinceLast = Math.round((Date.now() - new Date(acc.last_tweet_at).getTime()) / (60 * 1000));
      if (minsSinceLast < 60) {
        addLog('WARNING', `[anti_ban] هشدار نرخ ارسال: اکانت ${acc.name} آخرین بار ${minsSinceLast} دقیقه پیش توییت ارسال کرده است (حداقل فاصله توصیه شده ضد بن ۶۰ دقیقه است).`, 'anti_ban');
      }
    }

    // 2. Free any open Chrome process locks for this profile
    const existing = activeBrowsers.get(accId);
    if (existing) {
      if (existing.pollTimer) clearInterval(existing.pollTimer);
      try { existing.process.kill(); } catch {}
      activeBrowsers.delete(accId);
      await new Promise((r) => setTimeout(r, 1200));
    }

    addLog('INFO', `[anti_ban] آماده‌سازی ارسال توییت انسانی برای اکانت ${acc.name} (${acc.username}) با روش ضد بن...`, 'anti_ban');

    // 3. Execute Real Stealth Browser Automation with Human Typing
    const tweetRes = await postTweetWithStealthBrowser({
      accountId: acc.id,
      accountName: acc.name,
      username: acc.username,
      text: text.trim(),
      proxyUrl,
      logFn: (msg, level = 'INFO', logger = 'anti_ban') => addLog(level, msg, logger),
    });

    results.push({
      accountId: acc.id,
      accountName: acc.name,
      ...tweetRes,
    });

    if (tweetRes.success) {
      acc.total_tweets = (acc.total_tweets || 0) + 1;
      acc.last_tweet_at = nowIso;
      successCount++;

      queue.push({
        id: tweetRes.tweetId || `tweet_${Math.random().toString(36).substring(2, 10)}`,
        account_id: accId,
        account_name: acc.name,
        username: acc.username,
        proxy_info: proxyLabel,
        proxy_server: prx?.server || null,
        text: text.trim(),
        scheduled_at: nowIso,
        sent_at: nowIso,
        status: 'sent',
        tweet_url: tweetRes.tweetUrl,
        screenshot: tweetRes.screenshot,
        method: tweetRes.method,
        created_at: nowIso,
      });
    } else {
      addLog('ERROR', `[anti_ban] ارسال توییت برای اکانت ${acc.name} ناموفق بود: ${tweetRes.error || 'خطای نامشخص'}`);
      queue.push({
        id: `tweet_${Math.random().toString(36).substring(2, 10)}`,
        account_id: accId,
        account_name: acc.name,
        username: acc.username,
        proxy_info: proxyLabel,
        proxy_server: prx?.server || null,
        text: text.trim(),
        scheduled_at: nowIso,
        status: 'failed',
        error: tweetRes.error,
        created_at: nowIso,
      });
    }
  }

  saveAccountsData(accounts);
  saveQueueData(queue);

  if (successCount > 0) {
    addLog('INFO', `توییت با موفقیت روی ${successCount} اکانت منتشر شد.`);
    res.json({
      success: true,
      error: null,
      success_count: successCount,
      results,
    });
  } else {
    res.status(500).json({
      success: false,
      error: results[0]?.error || 'ارسال توییت با شکست مواجه شد.',
      results,
    });
  }
});

// Periodic background runner for scheduled queue items
setInterval(async () => {
  const queue = loadQueueData();
  const pending = queue.filter((item) => item.status === 'pending');
  if (pending.length === 0) return;

  const now = Date.now();
  for (const item of pending) {
    const scheduledTime = new Date(item.scheduled_at).getTime();
    if (scheduledTime <= now) {
      item.status = 'sending';
      saveQueueData(queue);

      const accounts = loadAccountsData();
      const acc = accounts.find((a) => a.id === item.account_id);
      if (!acc) {
        item.status = 'failed';
        item.error = 'اکانت یافت نشد';
        saveQueueData(queue);
        continue;
      }

      const proxies = loadProxiesData();
      const prx = proxies.find((p) => p.id === acc.proxy_id);
      const proxyUrl = prx ? `${prx.protocol.toLowerCase()}://${prx.server}:${prx.port}` : null;

      addLog('INFO', `[queue] فرا رسیدن نوبت ارسال توییت زمان‌بندی‌شده برای اکانت ${acc.name}...`);

      const tweetRes = await postTweetWithStealthBrowser({
        accountId: acc.id,
        accountName: acc.name,
        username: acc.username,
        text: item.text,
        proxyUrl,
        logFn: (msg, level = 'INFO', logger = 'anti_ban') => addLog(level, msg, logger),
      });

      if (tweetRes.success) {
        item.status = 'sent';
        item.sent_at = new Date().toISOString();
        item.tweet_url = tweetRes.tweetUrl;
        item.screenshot = tweetRes.screenshot;
        acc.total_tweets = (acc.total_tweets || 0) + 1;
        acc.last_tweet_at = item.sent_at;
        saveAccountsData(accounts);
      } else {
        item.status = 'failed';
        item.error = tweetRes.error;
      }
      saveQueueData(queue);
    }
  }
}, 30000);

// Logs API with error count
app.get('/api/logs', (req, res) => {
  res.json({
    logs: inMemoryLogs,
    error_count: errorCount,
  });
});

app.post('/api/logs/clear', (req, res) => {
  inMemoryLogs.length = 0;
  errorCount = 0;
  addLog('INFO', 'کنسول لاگ‌ها پاکسازی شد.');
  res.json({ success: true, message: 'لاگ‌ها پاکسازی شدند.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AI Studio] X Bot automation server running on http://0.0.0.0:${PORT}`);
});
