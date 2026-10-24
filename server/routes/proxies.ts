import express from 'express';
import {
  loadProxiesData,
  saveProxiesData,
  loadAccountsData,
  saveAccountsData,
  addLog,
  ProxyConfig
} from '../services/storage.js';
import { parseProxyUri, measureProxyDualPing } from '../services/xray.js';

const router = express.Router();

router.get('/proxies', (req, res) => {
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

router.post('/proxies', (req, res) => {
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
  try { lines.forEach(parseProxyUri); }
  catch (err: any) { return res.status(400).json({ success: false, error: err.message }); }
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

router.post('/proxies/:id/test', async (req, res) => {
  const proxyId = req.params.id;
  const proxies = loadProxiesData();
  const prx = proxies.find((p) => p.id === proxyId);

  if (!prx) {
    return res.status(404).json({ success: false, error: 'پروکسی یافت نشد.' });
  }

  addLog('INFO', `در حال سنجش پینگ دوگانه (گوگل و X) برای پروکسی [${prx.name}] (${prx.protocol.toUpperCase()})...`, 'xray_core');
  const result = await measureProxyDualPing(prx.url);

  prx.latency = result.latency;
  prx.google_latency = result.google_latency;
  prx.x_latency = result.x_latency;
  prx.status = result.reachable ? 'active' : 'offline';
  prx.last_tested_at = new Date().toISOString();
  saveProxiesData(proxies);

  addLog('INFO', `نتایج تست پروکسی ${prx.name}: پینگ گوگل: ${prx.google_latency}ms | پینگ X: ${prx.x_latency}ms`, 'xray_core');

  res.json({
    success: true,
    proxy: prx,
    latency: prx.latency,
    google_latency: prx.google_latency,
    x_latency: prx.x_latency,
    status: prx.status,
  });
});

router.post('/proxies/test-all', async (req, res) => {
  const proxies = loadProxiesData();
  addLog('INFO', `شروع سنجش پینگ سراسری گوگل و X برای ${proxies.length} پروکسی...`, 'xray_core');

  const testPromises = proxies.map(async (p) => {
    const result = await measureProxyDualPing(p.url);
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

router.post('/proxies/:id/assign', (req, res) => {
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

  addLog('INFO', `اکانت ${acc.name} (${acc.username}) با موفقیت به پروکسی ${prx.name} متصل شد.`, 'xray_core');
  res.json({ success: true, message: 'اکانت با موفقیت به پروکسی متصل گردید.' });
});

router.post('/proxies/:id/unassign', (req, res) => {
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

router.delete('/proxies/:id', (req, res) => {
  const proxyId = req.params.id;
  const proxies = loadProxiesData();
  const prx = proxies.find((p) => p.id === proxyId);

  if (!prx) {
    return res.status(404).json({ success: false, error: 'پروکسی یافت نشد.' });
  }

  const filtered = proxies.filter((p) => p.id !== proxyId);
  saveProxiesData(filtered);

  const accounts = loadAccountsData();
  accounts.forEach((a) => {
    if (a.proxy_id === proxyId) a.proxy_id = null;
  });
  saveAccountsData(accounts);

  addLog('INFO', `پروکسی ${prx.name} با موفقیت حذف شد و اتصالات آن آزاد گردید.`, 'xray_core');
  res.json({ success: true, message: 'پروکسی با موفقیت حذف گردید.' });
});

router.post('/proxies/clear-all', (req, res) => {
  const proxies = loadProxiesData();
  const count = proxies.length;
  saveProxiesData([]);

  const accounts = loadAccountsData();
  accounts.forEach((a) => {
    a.proxy_id = null;
  });
  saveAccountsData(accounts);

  addLog('INFO', `تمام پروکسی‌ها (${count} عدد) پاکسازی شدند و اتصالات اکانت‌ها ریست گردید.`, 'xray_core');
  res.json({ success: true, count, message: 'تمام پروکسی‌ها با موفقیت پاکسازی شدند.' });
});

export default router;
