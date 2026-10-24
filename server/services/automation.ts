import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { startProxy, type ProxyLease } from './xray.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const DATA_DIR = path.join(ROOT_DIR, 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const COOKIES_DIR = path.join(DATA_DIR, 'cookies');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

export interface TweetResult {
  success: boolean;
  tweetId?: string;
  tweetUrl?: string;
  method: 'browser_human_typing' | 'session_api';
  error?: string;
  screenshot?: string;
}

// Find available Chrome or Chromium binary
export function findChromeExecutable(): string | null {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

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
    '/Applications/Google Chrome Unstable.app/Contents/MacOS/Google Chrome Unstable',
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of staticCandidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// Human delay utility
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Random jitter generator
function randomDelay(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

// Natural human keystroke typing simulation
async function humanType(page: Page, text: string, logFn: (msg: string) => void): Promise<void> {
  const chars = Array.from(text);
  logFn(`[human_typing] شروع تایپ انسانی: ${chars.length} کاراکتر با ریتم ارگانیک و تاخیر متغیر کلیدها...`);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === '\n') await page.keyboard.press('Enter');
    else await page.keyboard.type(char);

    // Natural keystroke delay between 55ms and 150ms
    let delay = randomDelay(55, 150);

    // After punctuation, comma, space or newline, add cognitive thinking pause
    if (char === ' ' || char === '\n') {
      delay += randomDelay(120, 280);
    } else if (['.', '!', '؟', '?', '،', ':'].includes(char)) {
      delay += randomDelay(250, 480);
    }

    // Occasional natural hesitation (about 1 in 25 characters)
    if (i > 0 && i % 25 === 0) {
      delay += randomDelay(350, 650);
    }

    await sleep(delay);
  }
  logFn(`[human_typing] تایپ انسانی تمام کاراکترها با موفقیت پایان یافت.`);
}

// Dismiss only named consent/notification actions. Generic close buttons can
// belong to the compose dialog itself.
async function dismissPopups(page: Page) {
  await page.evaluate(() => {
    const dismissLabels = ['refuse non-essential cookies', 'accept all cookies', 'not now', 'dismiss', 'got it'];
    for (const button of document.querySelectorAll<HTMLElement>('button, div[role="button"]')) {
      if (dismissLabels.includes((button.textContent || '').trim().toLowerCase()) && button.getClientRects().length > 0) {
        button.click();
      }
    }
  }).catch(() => {});
}

// A cleared composer or a screenshot is not proof of publication.
export function readTweetConfirmation(status: number, body: any): string {
  if (status < 200 || status >= 300) throw new Error(`سرور X ارسال را رد کرد (HTTP ${status}).`);
  if (body?.errors?.length) throw new Error(`سرور X ارسال را رد کرد: ${body.errors.map((e: any) => e.message || 'خطای نامشخص').join('؛ ')}`);
  const result = body?.data?.create_tweet?.tweet_results?.result;
  const id = result?.rest_id || result?.tweet?.rest_id;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('پاسخ سرور فاقد شناسه تأییدشده توییت است.');
  return id;
}

export async function submitComposer(page: Page, text: string, timeout = 45000): Promise<string> {
  const boxSelector = '[data-testid="tweetTextarea_0"][contenteditable="true"]';
  // Wait for React to commit the text and enable the button in this composer.
  await page.waitForFunction((selector, expected) => {
    const box = document.querySelector(selector);
    const scope = box?.closest('[role="dialog"]') || box?.closest('main') || document;
    const buttons = Array.from(scope.querySelectorAll<HTMLElement>('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'));
    const button = buttons.find(b => b.getClientRects().length > 0 && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true');
    return !!box && ((box as HTMLElement).innerText || box.textContent || '').replace(/\r\n/g, '\n').trim() === expected.trim() && !!button;
  }, { timeout: 30000 }, boxSelector, text);

  const button = await page.evaluateHandle((selector) => {
    const box = document.querySelector(selector);
    const scope = box?.closest('[role="dialog"]') || box?.closest('main') || document;
    return Array.from(scope.querySelectorAll<HTMLElement>('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'))
      .find(b => b.getClientRects().length > 0 && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true');
  }, boxSelector);
  const postButton = button.asElement();
  if (!postButton) { await button.dispose(); throw new Error('دکمه فعال ارسال پیدا نشد.'); }

  // Subscribe before clicking so a fast response cannot be missed. Never retry a
  // submission automatically: a timeout may mean the server already accepted it.
  const confirmation = page.waitForResponse(response => {
    try {
      const url = new URL(response.url());
      return url.hostname === 'x.com' && url.pathname.endsWith('/CreateTweet') && response.request().method() === 'POST';
    } catch { return false; }
  }, { timeout }).then(async response => {
    return { id: readTweetConfirmation(response.status(), await response.json()) };
  }).catch((err: Error) => ({ error: err.message }));
  try { await postButton.click(); }
  finally { await button.dispose(); }
  const result = await confirmation;
  if ('error' in result) throw new Error(`تأیید انتشار دریافت نشد: ${result.error} پیش از ارسال دوباره، پروفایل را بررسی کنید.`);
  return result.id;
}

const postingAccounts = new Set<string>();

export async function postTweetWithStealthBrowser(options: {
  accountId: string;
  accountName: string;
  username: string;
  text: string;
  proxyUrl?: string | null;
  logFn?: (msg: string, level?: string, logger?: string) => void;
}): Promise<TweetResult> {
  const log = options.logFn || ((msg: string) => console.log(msg));
  const accountId = options.accountId;
  if (postingAccounts.has(accountId)) return { success: false, method: 'browser_human_typing', error: 'ارسال دیگری برای این اکانت در حال انجام است.' };
  postingAccounts.add(accountId);
  let browser: Browser | undefined;
  let proxyLease: ProxyLease | undefined;
  let page: Page | undefined;
  const screenshot = async (prefix: string): Promise<string | undefined> => {
    if (!page || page.isClosed()) return;
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const name = `${prefix}_${accountId}_${Date.now()}.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, name), type: 'png' });
      return name;
    } catch { return; }
  };
  try {
    const chromeBin = findChromeExecutable();
    if (!chromeBin) throw new Error('مرورگر Chrome یافت نشد. آن را نصب کنید یا CHROME_BIN را تنظیم کنید.');
    const profileDir = path.join(PROFILES_DIR, accountId);
    fs.mkdirSync(profileDir, { recursive: true });
    const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);
    const parsed = fs.existsSync(cookiePath) ? JSON.parse(fs.readFileSync(cookiePath, 'utf8')) : [];
    const cookies = Array.isArray(parsed) ? parsed : parsed.cookies || [];
    if (!cookies.some((c: any) => c.name === 'auth_token' && c.value)) throw new Error('کوکی auth_token یافت نشد؛ ابتدا وارد اکانت شوید.');
    const args = ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--disable-search-engine-choice-screen', '--password-store=basic', '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,850', '--lang=fa-IR,en-US,en'];
    if (options.proxyUrl) {
      proxyLease = await startProxy(options.proxyUrl);
      args.push(`--proxy-server=${proxyLease.url}`, '--disable-quic');
      log('پراکسی اختصاصی اکانت برای ارسال آماده شد.', 'INFO', 'xray_core');
    }
    browser = await puppeteer.launch({ executablePath: chromeBin, userDataDir: profileDir,
      headless: !process.env.DISPLAY && process.platform === 'linux', args,
      defaultViewport: { width: 1280, height: 850 }, ignoreDefaultArgs: ['--enable-automation'] });
    page = (await browser.pages())[0] || await browser.newPage();
    // Stealth anti-detection evasion script
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['fa-IR', 'fa', 'en-US', 'en'] });
      (window as any).chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
      };
    });

    // Legacy twitter.com cookies must apply to the current x.com session.
    const sessionCookies = cookies.filter((c: any) => !c.domain || /(^|\.)(x|twitter)\.com$/.test(c.domain)).map((c: any) => ({
      name: c.name, value: c.value, domain: '.x.com', path: c.path || '/',
      secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
    }));
    await browser.defaultBrowserContext().setCookie(...sessionCookies);
    log(`تعداد ${sessionCookies.length} کوکی به مرورگر منتقل شد.`, 'INFO', 'x_bot');
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/\/(login|i\/flow\/login|account\/access)(?:[/?]|$)/.test(new URL(page.url()).pathname)) throw new Error('نشست نیازمند ورود مجدد یا تأیید حساب است.');
    await dismissPopups(page);
    const box = await page.waitForSelector('[data-testid="tweetTextarea_0"][contenteditable="true"]', { visible: true, timeout: 30000 });
    if (!box) throw new Error('کادر نگارش آماده نشد.');
    // Avoid publishing an old draft together with the requested text.
    const draft = await box.evaluate(el => el.textContent || '');
    if (draft.trim()) throw new Error('پیش‌نویس قبلی در کادر وجود دارد؛ ابتدا آن را بررسی و پاک کنید.');
    await box.click();
    await humanType(page, options.text, m => log(m, 'INFO', 'human_typing'));
    await sleep(randomDelay(1200, 2500));
    log('متن وارد شد؛ در انتظار آماده‌شدن دکمه و تأیید سرور X...', 'INFO', 'x_bot');
    const id = await submitComposer(page, options.text);
    const proof = await screenshot('tweet');
    log(`انتشار با پاسخ سرور تأیید شد. شناسه توییت: ${id}`, 'INFO', 'x_bot');
    return { success: true, method: 'browser_human_typing', tweetId: id,
      tweetUrl: `https://x.com/i/status/${id}`, screenshot: proof };
  } catch (err: any) {
    log(`ارسال توییت ناموفق بود: ${err.message}`, 'ERROR', 'x_bot');
    return { success: false, method: 'browser_human_typing', error: err.message, screenshot: await screenshot('error') };
  } finally {
    if (browser) await browser.close().catch(() => {});
    proxyLease?.release();
    postingAccounts.delete(accountId);
  }
}
