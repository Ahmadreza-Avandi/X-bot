import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const COOKIES_DIR = path.join(DATA_DIR, 'cookies');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.json');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

export interface ProxyConfig {
  id: string;
  name: string;
  url: string;
  protocol: string;
  server: string;
  port: number;
  status: 'active' | 'offline' | 'untested';
  latency: number | null;
  google_latency: number | null;
  x_latency: number | null;
  last_tested_at: string | null;
  assigned_account_ids: string[];
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  logger: string;
}

export const inMemoryLogs: LogEntry[] = [];
export let errorCount = 0;

export function addLog(level: string, message: string, loggerName = 'x_bot') {
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
  if (inMemoryLogs.length > 150) inMemoryLogs.pop();
  console.log(`[${timeStr}] [${level}] [${loggerName}] ${message}`);
}

export function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  if (!fs.existsSync(ACCOUNTS_FILE)) {
    const defaultAccounts = [
      {
        id: 'acc1',
        name: 'اکانت اصلی',
        username: '@example',
        active: true,
        last_tweet_at: new Date().toISOString(),
        total_tweets: 1,
        cookies_saved: true,
        proxy_id: 'prx_fra_vless',
      },
    ];
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(defaultAccounts, null, 2), 'utf-8');
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
        assigned_account_ids: [],
      },
    ];
    fs.writeFileSync(PROXIES_FILE, JSON.stringify(defaultProxies, null, 2), 'utf-8');
  }
}

export function loadAccountsData(): any[] {
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

export function saveAccountsData(accounts: any[]) {
  ensureDirs();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
}

export function loadProxiesData(): ProxyConfig[] {
  ensureDirs();
  try {
    if (!fs.existsSync(PROXIES_FILE)) return [];
    const data = fs.readFileSync(PROXIES_FILE, 'utf-8');
    const proxies: ProxyConfig[] = JSON.parse(data);

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

export function saveProxiesData(proxies: ProxyConfig[]) {
  ensureDirs();
  fs.writeFileSync(PROXIES_FILE, JSON.stringify(proxies, null, 2), 'utf-8');
}

export function loadQueueData(): any[] {
  ensureDirs();
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

export function saveQueueData(queue: any[]) {
  ensureDirs();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

export function getCookieMetadata(accountId: string) {
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

export function handleCookieSave(accountId: string, bodyData: any, res: any) {
  try {
    let finalCookies: any[] = [];
    if (typeof bodyData === 'string') {
      const parsed = JSON.parse(bodyData);
      finalCookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
    } else if (Array.isArray(bodyData)) {
      finalCookies = bodyData;
    } else if (bodyData && typeof bodyData === 'object') {
      if (typeof bodyData.cookies === 'string') {
        const parsed = JSON.parse(bodyData.cookies);
        finalCookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      } else if (Array.isArray(bodyData.cookies)) {
        finalCookies = bodyData.cookies;
      } else {
        for (const [k, v] of Object.entries(bodyData)) {
          finalCookies.push({
            name: k.trim(),
            value: String(v).trim(),
            domain: '.x.com',
            path: '/',
          });
        }
      }
    }

    if (!finalCookies.length) {
      addLog('ERROR', `خطا در ذخیره کوکی: داده‌های کوکی خالی است.`);
      return res.status(400).json({ success: false, error: 'هیچ کوکی معتبری یافت نشد.' });
    }

    const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
    const record = {
      account_id: accountId,
      saved_at: new Date().toISOString(),
      count: finalCookies.length,
      cookies: finalCookies,
    };

    fs.writeFileSync(cookiePath, JSON.stringify(record, null, 2), 'utf-8');

    try {
      fs.writeFileSync(path.join(ROOT_DIR, 'cookies.json'), JSON.stringify(finalCookies, null, 2), 'utf-8');
    } catch {}

    addLog('INFO', `تعداد ${finalCookies.length} کوکی برای اکانت ${accountId} با موفقیت ثبت شد.`);
    res.json({ success: true, message: `تعداد ${finalCookies.length} کوکی با موفقیت ثبت شد.` });
  } catch (e: any) {
    addLog('ERROR', `خطا در ذخیره کوکی اکانت ${accountId}: ${e.message}`);
    res.status(400).json({ success: false, error: `فرمت کوکی نامعتبر است: ${e.message}` });
  }
}
