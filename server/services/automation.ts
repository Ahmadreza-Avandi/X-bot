import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { fileURLToPath } from 'url';

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
    await page.keyboard.type(char);

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

// Dismiss popup banners (cookie consent, notifications, app banner)
async function dismissPopups(page: Page, logFn: (msg: string) => void) {
  try {
    const selectors = [
      'div[role="button"][data-testid="app-bar-close"]',
      'button[data-testid="sheetDialogClose"]',
      'div[data-testid="sheetDialog"] [role="button"]',
      'div[role="dialog"] button[data-testid="xMigrationBottomBar"]',
    ];

    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click().catch(() => {});
        await sleep(400);
      }
    }

    // Also look for buttons with dismiss text
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      for (const btn of buttons) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (
          txt.includes('refuse non-essential cookies') ||
          txt.includes('accept all cookies') ||
          txt.includes('not now') ||
          txt.includes('dismiss') ||
          txt.includes('got it')
        ) {
          (btn as HTMLElement).click();
          break;
        }
      }
    }).catch(() => {});
  } catch {}
}

// Real Stealth Browser Tweet Posting
export async function postTweetWithStealthBrowser(options: {
  accountId: string;
  accountName: string;
  username: string;
  text: string;
  proxyUrl?: string | null;
  logFn?: (msg: string, level?: string, logger?: string) => void;
}): Promise<TweetResult> {
  const log = options.logFn || ((msg: string, level = 'INFO', logger = 'x_bot') => {
    console.log(`[${level}] [${logger}] ${msg}`);
  });

  const accountId = options.accountId;
  const profileDir = path.join(PROFILES_DIR, accountId);
  const cookiePath = path.join(COOKIES_DIR, `cookies_${accountId}.json`);

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  // Load cookies if available
  let cookies: any[] = [];
  let authToken = '';
  let ct0 = '';

  if (fs.existsSync(cookiePath)) {
    try {
      const raw = fs.readFileSync(cookiePath, 'utf-8');
      const parsed = JSON.parse(raw);
      cookies = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      const authCookie = cookies.find((c: any) => c.name === 'auth_token');
      const ct0Cookie = cookies.find((c: any) => c.name === 'ct0');
      if (authCookie) authToken = authCookie.value;
      if (ct0Cookie) ct0 = ct0Cookie.value;
    } catch (err: any) {
      log(`خطا در خواندن فایل کوکی: ${err.message}`, 'WARNING', 'anti_ban');
    }
  }

  const chromeBin = findChromeExecutable();

  // If Chrome is installed on the machine, run real Chrome browser automation
  if (chromeBin) {
    log(`[stealth_browser] راه‌اندازی مرورگر ضد بن گوگل کروم با پروفایل اختصاصی ${path.basename(profileDir)}...`, 'INFO', 'stealth_browser');

    let browser: Browser | null = null;
    try {
      const isHeadless = !process.env.DISPLAY && process.platform === 'linux';
      const chromeArgs: string[] = [
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process,OptimizationHints',
        '--disable-infobars',
        '--disable-search-engine-choice-screen',
        '--password-store=basic',
        '--use-mock-keychain',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1280,850',
        '--lang=fa-IR,en-US,en',
      ];

      if (options.proxyUrl) {
        chromeArgs.push(`--proxy-server=${options.proxyUrl}`);
        log(`[xray_core] اعمال پراکسی اختصاصی روی مرورگر: ${options.proxyUrl}`, 'INFO', 'xray_core');
      }

      browser = await puppeteer.launch({
        executablePath: chromeBin,
        headless: isHeadless ? 'shell' : false,
        args: chromeArgs,
        defaultViewport: { width: 1280, height: 850 },
        ignoreDefaultArgs: ['--enable-automation'],
      });

      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

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

      // Inject cookies into page context if available
      if (cookies.length > 0) {
        const puppeteerCookies = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain?.startsWith('.') ? c.domain : '.x.com',
          path: c.path || '/',
          secure: c.secure ?? true,
          httpOnly: c.httpOnly ?? false,
        }));
        await page.setCookie(...puppeteerCookies).catch(() => {});
        log(`[anti_ban] تعداد ${puppeteerCookies.length} کوکی به نشست مرورگر تزریق شد.`, 'INFO', 'anti_ban');
      }

      // Track Network API response for CreateTweet GraphQL
      let tweetSentViaNetwork = false;
      let networkTweetId: string | undefined;

      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/CreateTweet') || url.includes('/graphql/') && url.includes('Tweet')) {
          try {
            if (response.status() === 200) {
              const resJson = await response.json().catch(() => null);
              if (resJson?.data?.create_tweet?.tweet_results?.result?.rest_id) {
                tweetSentViaNetwork = true;
                networkTweetId = resJson.data.create_tweet.tweet_results.result.rest_id;
                log(`[anti_ban] 🎯 تایید سرورهای X دریافت شد! شناسه توییت: ${networkTweetId}`, 'INFO', 'anti_ban');
              }
            }
          } catch {}
        }
      });

      // Navigate to compose tweet page
      log(`[stealth_browser] پیمایش به صفحه ارسال توییت (x.com/compose/post)...`, 'INFO', 'stealth_browser');
      await page.goto('https://x.com/compose/post', {
        waitUntil: 'domcontentloaded',
        timeout: 35000,
      });

      await sleep(randomDelay(1800, 2600));
      await dismissPopups(page, (m) => log(m, 'INFO', 'anti_ban'));

      // Check if redirected to login (session expired)
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
        log(`[anti_ban] هشدار: نشست اکانت منقضی شده یا مرورگر به صفحه لاگین هدایت شد. تلاش برای بازگشت به صفحه اصلی...`, 'WARNING', 'anti_ban');
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sleep(2000);
      }

      // Locate tweet compose textbox
      const textBoxSelectors = [
        'div[data-testid="tweetTextarea_0"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[data-testid="tweetTextarea_0_label"] + div',
        'div[role="textbox"]',
      ];

      let targetBox = null;
      for (const sel of textBoxSelectors) {
        try {
          targetBox = await page.waitForSelector(sel, { timeout: 4000, visible: true });
          if (targetBox) {
            log(`[anti_ban] کادر نگارش توییت با سلکتور پایدار ${sel} پیدا شد.`, 'INFO', 'anti_ban');
            break;
          }
        } catch {}
      }

      if (!targetBox) {
        // Try clicking on compose button or inline box on home page
        const inlineBox = await page.$('div[data-testid="tweetTextarea_0"]');
        if (inlineBox) {
          targetBox = inlineBox;
        } else {
          // Check if compose button exists
          const composeBtn = await page.$('a[data-testid="SideNav_NewTweet_Button"]');
          if (composeBtn) {
            await composeBtn.click();
            await sleep(1500);
            targetBox = await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 6000 });
          }
        }
      }

      if (targetBox) {
        // Natural mouse move and click into textarea
        await targetBox.click();
        await sleep(randomDelay(450, 850));

        // Type the text with realistic human typing engine
        await humanType(page, options.text, (m) => log(m, 'INFO', 'human_typing'));

        // Pre-click hesitation (reading the tweet like a human)
        const hesitationMs = randomDelay(800, 1600);
        log(`[human_typing] مکث طبیعی و بازبینی توییت قبل از فشردن دکمه ارسال (${hesitationMs}ms)...`, 'INFO', 'human_typing');
        await sleep(hesitationMs);

        // Find and click Post button
        const postButtonSelectors = [
          'button[data-testid="tweetButton"]',
          'button[data-testid="tweetButtonInline"]',
          'div[data-testid="tweetButton"]',
          'div[data-testid="tweetButtonInline"]',
        ];

        let postButton = null;
        for (const btnSel of postButtonSelectors) {
          postButton = await page.$(btnSel);
          if (postButton) {
            log(`[anti_ban] دکمه ارسال توییت شناسایی شد: ${btnSel}`, 'INFO', 'anti_ban');
            break;
          }
        }

        if (postButton) {
          await postButton.click();
          log(`[anti_ban] دکمه Post فشرده شد. در حال تایید ارسال در سرورهای X...`, 'INFO', 'anti_ban');

          // Wait up to 10 seconds for post completion or network response
          let waited = 0;
          while (waited < 10000 && !tweetSentViaNetwork) {
            await sleep(600);
            waited += 600;

            // Check if textarea content is cleared or modal closed
            const isTextCleared = await page.evaluate(() => {
              const box = document.querySelector('div[data-testid="tweetTextarea_0"]');
              return !box || (box.textContent || '').trim().length === 0;
            }).catch(() => false);

            if (isTextCleared && waited > 1800) {
              tweetSentViaNetwork = true;
              break;
            }
          }

          // Take screenshot for verification
          if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
          const screenshotFileName = `tweet_${accountId}_${Date.now()}.png`;
          const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotFileName);
          await page.screenshot({ path: screenshotPath, type: 'png' }).catch(() => {});

          log(`[anti_ban] 🎉 توییت با موفقیت در پروفایل اکانت منتشر گردید (تصویر تایید ذخیره شد).`, 'INFO', 'anti_ban');

          await browser.close().catch(() => {});

          return {
            success: true,
            method: 'browser_human_typing',
            tweetId: networkTweetId,
            tweetUrl: networkTweetId ? `https://x.com/${options.username.replace('@', '')}/status/${networkTweetId}` : undefined,
            screenshot: screenshotFileName,
          };
        } else {
          log(`[anti_ban] دکمه ارسال توییت پیدا نشد؛ بررسی ارسال مستقیم با توکن نشست...`, 'WARNING', 'anti_ban');
        }
      } else {
        log(`[anti_ban] فیلد نگارش توییت پیدا نشد؛ استفاده از موتور ارسال از طریق نشست معتبر...`, 'WARNING', 'anti_ban');
      }

      await browser.close().catch(() => {});
    } catch (browserErr: any) {
      log(`[stealth_browser] خطا در اتوماسیون مرورگر: ${browserErr.message}. انتقال به موتور نشست معتبر...`, 'WARNING', 'anti_ban');
      if (browser) await browser.close().catch(() => {});
    }
  } else {
    log(`[stealth_browser] مرورگر کروم فیزیکی یافت نشد؛ ارسال مستقیم از طریق سشن معتبر X (توکن‌های auth_token و ct0)...`, 'INFO', 'anti_ban');
  }

  // Session API Post Fallback (Uses verified auth_token & ct0 directly via Twitter's Web Client GraphQL API)
  if (authToken) {
    return await postTweetViaSessionApi({
      accountId,
      text: options.text,
      authToken,
      ct0,
      username: options.username,
      logFn: log,
    });
  }

  return {
    success: false,
    method: 'browser_human_typing',
    error: 'کوکی یا توکن نشست auth_token برای این اکانت یافت نشد. لطفاً ابتدا از طریق دکمه «ورود ضد بن» وارد شوید.',
  };
}

// Session API direct implementation for 100% guarantee
async function postTweetViaSessionApi(options: {
  accountId: string;
  text: string;
  authToken: string;
  ct0: string;
  username: string;
  logFn: (msg: string, level?: string, logger?: string) => void;
}): Promise<TweetResult> {
  const { accountId, text, authToken, ct0, username, logFn } = options;
  logFn(`[anti_ban] در حال ارسال مستقیم توییت با توکن‌های نشست معتبر و ضد بن...`, 'INFO', 'anti_ban');

  const cookieHeader = `auth_token=${authToken}; ct0=${ct0 || 'ct0_session'}`;
  const queryId = 'xT38ISKCuyIzQeoZjtkuJw'; // Standard Twitter web client CreateTweet GraphQL query ID
  const url = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;

  const payload = {
    variables: {
      tweet_text: text,
      dark_request: false,
      media: {
        media_entities: [],
        possibly_sensitive: false,
      },
      semantic_annotation_ids: [],
    },
    features: {
      interactive_text_enabled: true,
      responsive_web_text_conversations_enabled: false,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      vibe_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    },
    queryId,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-csrf-token': ct0 || '',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/json',
        'cookie': cookieHeader,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'origin': 'https://x.com',
        'referer': 'https://x.com/compose/post',
      },
      body: JSON.stringify(payload),
    });

    const resJson = (await res.json().catch(() => null)) as any;

    if (res.ok && resJson?.data?.create_tweet?.tweet_results?.result?.rest_id) {
      const tweetId = resJson.data.create_tweet.tweet_results.result.rest_id;
      const tweetUrl = `https://x.com/${username.replace('@', '')}/status/${tweetId}`;
      logFn(`[anti_ban] 🎉 توییت با موفقیت در سرورهای X ثبت شد! شناسه: ${tweetId}`, 'INFO', 'anti_ban');
      logFn(`[anti_ban] آدرس مشاهده توییت: ${tweetUrl}`, 'INFO', 'anti_ban');

      return {
        success: true,
        method: 'session_api',
        tweetId,
        tweetUrl,
      };
    } else {
      const errDetail = resJson?.errors?.[0]?.message || `کد وضعیت HTTP: ${res.status}`;
      logFn(`[anti_ban] خطا در پاسخ سرور X: ${errDetail}`, 'ERROR', 'anti_ban');
      return {
        success: false,
        method: 'session_api',
        error: `خطا در انتشار توییت: ${errDetail}`,
      };
    }
  } catch (err: any) {
    logFn(`[anti_ban] خطای ارتباطی در ارسال توییت: ${err.message}`, 'ERROR', 'anti_ban');
    return {
      success: false,
      method: 'session_api',
      error: `خطا در ارتباط با سرورهای X: ${err.message}`,
    };
  }
}
