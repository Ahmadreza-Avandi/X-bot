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
import { postTweetWithStealthBrowser } from '../services/automation.js';

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

router.post('/tweet/now', async (req, res) => {
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

    if (acc.last_tweet_at) {
      const minsSinceLast = Math.round((Date.now() - new Date(acc.last_tweet_at).getTime()) / (60 * 1000));
      if (minsSinceLast < 60) {
        addLog('WARNING', `[anti_ban] هشدار نرخ ارسال: اکانت ${acc.name} آخرین بار ${minsSinceLast} دقیقه پیش توییت ارسال کرده است (حداقل فاصله توصیه شده ۶۰ دقیقه است).`, 'anti_ban');
      }
    }

    addLog('INFO', `[anti_ban] آماده‌سازی ارسال توییت انسانی برای اکانت ${acc.name} (${acc.username}) با متد ضد بن...`, 'anti_ban');

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
    addLog('INFO', `توییت فوری با موفقیت روی ${successCount} اکانت منتشر شد.`);
    res.json({
      success: true,
      error: null,
      success_count: successCount,
      results,
    });
  } else {
    res.status(500).json({
      success: false,
      error: results[0]?.error || 'ارسال توییت با خطا مواجه گردید.',
      results,
    });
  }
});

export default router;
