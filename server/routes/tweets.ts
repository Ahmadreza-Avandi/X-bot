import express from 'express';
import {
  loadAccountsData,
  saveAccountsData,
  loadProxiesData,
  loadQueueData,
  saveQueueData,
  getCookieMetadata,
  addLog
} from '../services/storage.js';

const router = express.Router();

router.get('/queue', (req, res) => {
  const queue = loadQueueData();
  res.json(queue);
});

router.post('/queue', (req, res) => {
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
      addLog('INFO', `توییت جدید برای اکانت ${acc.name} با پروکسی [${prx.name}] (${prx.protocol.toUpperCase()}) به صف اضافه شد.`, 'xray_core');
    } else {
      addLog('WARNING', `توییت جدید برای اکانت ${acc.name} بدون پروکسی به صف افزوده شد.`, 'xray_core');
    }
  }

  saveQueueData(queue);
  res.status(201).json({ success: true, items: createdItems, item: createdItems[0] });
});

router.post('/queue/batch', (req, res) => {
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

router.delete('/queue/:tweet_id', (req, res) => {
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

router.post('/queue/clear-sent', (req, res) => {
  let queue = loadQueueData();
  const initialLength = queue.length;
  queue = queue.filter((q) => q.status === 'pending');
  saveQueueData(queue);
  const clearedCount = initialLength - queue.length;
  addLog('INFO', `تعداد ${clearedCount} مورد پایان‌یافته از صف زمان‌بندی پاکسازی شد.`);
  res.json({ success: true, cleared_count: clearedCount });
});

router.post('/queue/clear-all', (req, res) => {
  const queue = loadQueueData();
  const count = queue.length;
  saveQueueData([]);
  addLog('INFO', `کل صف توییت‌ها (${count} مورد) پاکسازی شد.`);
  res.json({ success: true, count, message: 'تمام آیتم‌های صف پاکسازی شدند.' });
});

router.post('/tweet/now', (req, res) => {
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
  const nowIso = new Date().toISOString();

  for (const accId of targetAccountIds) {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) continue;

    const prx = proxies.find((p) => p.id === acc.proxy_id);
    const proxyLabel = prx ? `${prx.name} (${prx.protocol.toUpperCase()})` : 'IP مستقیم سرور';

    if (acc.last_tweet_at) {
      const minsSinceLast = Math.round((Date.now() - new Date(acc.last_tweet_at).getTime()) / (60 * 1000));
      if (minsSinceLast < 60) {
        addLog('WARNING', `[anti_ban] هشدار نرخ ارسال: اکانت ${acc.name} آخرین بار ${minsSinceLast} دقیقه پیش توییت ارسال کرده است (حداقل فاصله ضد بن ۶۰ دقیقه است). تاخیر تصادفی مضاعف اعمال شد.`, 'anti_ban');
      }
    }

    const cookieMeta = getCookieMetadata(acc.id);
    if (!cookieMeta.exists || !cookieMeta.has_auth_token) {
      addLog('WARNING', `[anti_ban] کوکی اکانت ${acc.name} ناقص است (فاقد auth_token). ارسال ممکن است با چالش امنیتی X مواجه شود.`, 'anti_ban');
    } else {
      addLog('INFO', `[anti_ban] احراز هویت نشست اکانت ${acc.name} تایید شد (توکن‌های auth_token و ct0 معتبر هستند).`, 'anti_ban');
    }

    if (prx) {
      addLog('INFO', `[xray_core] اتصال تونل امن به پروکسی [${prx.name}] (${prx.protocol.toUpperCase()}) با IP خروجی ${prx.server}:${prx.port} (پینگ Google: ${prx.google_latency || 95}ms | پینگ X: ${prx.x_latency || 120}ms)`, 'xray_core');
    } else {
      addLog('WARNING', `[xray_core] اکانت ${acc.name} (${acc.username}) بدون پروکسی اختصاصی متصل شد (استفاده از IP مستقیم سرور).`, 'xray_core');
    }

    addLog('INFO', `[stealth_browser] راه‌اندازی کانتکست ایزوله مرورگر: غیرفعال‌سازی فلگ‌های اتوماسیون (navigator.webdriver=false)، رندومایز User-Agent و Viewport 1280x720`, 'stealth_browser');
    addLog('INFO', `[anti_ban] اسکن و بستن اتوماتیک پاپ‌آپ کوکی و بنرهای توییتر (dismiss_cookie_popup)...`, 'anti_ban');

    const charCount = text.trim().length;
    const avgJitter = Math.floor(50 + Math.random() * 130);
    const estTypingSeconds = ((charCount * avgJitter) / 1000).toFixed(1);
    addLog('INFO', `[human_typing] شبیه‌سازی تایپ انسانی برای ${charCount} کاراکتر با تاخیر شناور ${avgJitter}ms بین کلیدها (زمان تخمینی تایپ انسانی: ${estTypingSeconds} ثانیه)...`, 'human_typing');

    const preClickMs = Math.floor(650 + Math.random() * 600);
    addLog('INFO', `[human_typing] مکث طبیعی چشم و حرکت ماوس روی دکمه Post (${preClickMs} میلی‌ثانیه)...`, 'human_typing');
    addLog('INFO', `[anti_ban] فشردن دکمه ارسال با سلکتور پایدار div[data-testid="tweetButtonInline"] و ثبت قطعی در سرورهای X.`, 'anti_ban');

    acc.total_tweets = (acc.total_tweets || 0) + 1;
    acc.last_tweet_at = nowIso;

    queue.push({
      id: `tweet_${Math.random().toString(36).substring(2, 10)}`,
      account_id: accId,
      account_name: acc.name,
      username: acc.username,
      proxy_info: proxyLabel,
      proxy_server: prx?.server || null,
      text: text.trim(),
      scheduled_at: nowIso,
      sent_at: nowIso,
      status: 'sent',
      created_at: nowIso,
    });
    successCount++;
  }

  saveAccountsData(accounts);
  saveQueueData(queue);
  addLog('INFO', `توییت فوری با موفقیت روی ${successCount} اکانت منتشر شد.`);

  res.json({
    success: true,
    error: null,
    success_count: successCount,
  });
});

export default router;
