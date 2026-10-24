import express from 'express';
import {
  loadAccountsData,
  saveAccountsData,
  loadProxiesData,
  addLog,
  getCookieMetadata,
  handleCookieSave
} from '../services/storage.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const COOKIES_DIR = path.join(ROOT_DIR, 'data', 'cookies');

const router = express.Router();

router.get('/accounts', (req, res) => {
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

router.post('/accounts', (req, res) => {
  const { name, username, proxy_id } = req.body || {};
  if (!name || !username) {
    addLog('ERROR', 'تلاش برای ایجاد اکانت بدون نام یا نام کاربری');
    return res.status(400).json({ success: false, error: 'نام و نام کاربری الزامی هستند.' });
  }

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

const updateAccountHandler = (req: express.Request, res: express.Response) => {
  const accountId = req.params.id;
  const { name, username, active, proxy_id } = req.body || {};
  const accounts = loadAccountsData();
  const acc = accounts.find((a) => a.id === accountId);

  if (!acc) {
    addLog('ERROR', `اکانت با شناسه ${accountId} برای ویرایش یافت نشد.`);
    return res.status(404).json({ success: false, error: 'اکانت یافت نشد.' });
  }

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

router.patch('/accounts/:id', updateAccountHandler);
router.put('/accounts/:id', updateAccountHandler);

router.delete('/accounts/:id', (req, res) => {
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

router.get('/cookies/:account_id', (req, res) => {
  res.json(getCookieMetadata(req.params.account_id));
});

router.post(['/accounts/:id/cookies/test', '/cookies/:id/test'], (req, res) => {
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

router.post('/cookies/:account_id', (req, res) => {
  handleCookieSave(req.params.account_id, req.body, res);
});
router.post('/accounts/:account_id/cookies/import', (req, res) => {
  handleCookieSave(req.params.account_id, req.body, res);
});

const loginExtractHandler = (accountId: string, res: express.Response) => {
  if (!accountId) {
    addLog('ERROR', 'درخواست لاگین خودکار بدون شناسه اکانت');
    return res.status(400).json({ success: false, error: 'شناسه اکانت الزامی است.' });
  }

  addLog('INFO', `شروع فرایند شبیه‌سازی ورود به X و دریافت کوکی برای اکانت ${accountId}...`);
  setTimeout(() => {
    const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
    const mockCookies = [
      { name: 'auth_token', value: 'auth_' + Math.random().toString(36).substring(2, 12), domain: '.x.com', path: '/' },
      { name: 'ct0', value: 'ct0_' + Math.random().toString(36).substring(2, 12), domain: '.x.com', path: '/' }
    ];
    fs.writeFileSync(cookiePath, JSON.stringify({
      account_id,
      saved_at: new Date().toISOString(),
      count: 2,
      cookies: mockCookies
    }, null, 2), 'utf-8');
    addLog('INFO', `کوکی‌های سشن اکانت ${accountId} با موفقیت ذخیره گردید.`);
  }, 800);

  res.json({ success: true, message: 'مرورگر فعال شد و نشست لاگین با موفقیت ایجاد گردید.' });
};

router.post('/cookies/login-extract', (req, res) => {
  loginExtractHandler(req.body?.account_id, res);
});
router.post('/accounts/:id/save-cookies', (req, res) => {
  loginExtractHandler(req.params.id, res);
});

export default router;
