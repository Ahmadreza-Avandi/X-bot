"""
اسکریپت ارسال گروهی یا تکی توییت‌ها با فایل متنی tweets.txt
پشتیبانی از انتخاب اکانت و فایل کوکی اختصاصی
اجرا:
  python send_tweets.py             (پیش‌فرض: cookies.json یا data/cookies/cookies_acc1.json)
  python send_tweets.py acc1        (انتخاب اکانت مشخص)
"""

import sys
import os
import asyncio
import random
import json
from pathlib import Path
from playwright.async_api import async_playwright

CHROME_PATH = os.getenv("CHROME_PATH", "/usr/bin/google-chrome-unstable")
TWEETS_FILE = "tweets.txt"
MIN_DELAY = 3600
MAX_DELAY = 7200


async def human_delay(min_ms=800, max_ms=2500):
    await asyncio.sleep(random.uniform(min_ms, max_ms) / 1000)


async def human_type(element, text: str):
    for char in text:
        await element.type(char, delay=random.randint(50, 180))
        if random.random() < 0.1:
            await asyncio.sleep(random.uniform(0.3, 0.8))


async def load_cookies(context, cookies_file: str):
    with open(cookies_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    # پشتیبانی از لیست مستقیم یا دیکشنری حاوی کلید cookies
    cookies = data if isinstance(data, list) else data.get("cookies", [])
    await context.add_cookies(cookies)
    print(f"✅ {len(cookies)} کوکی لود شد")


async def post_tweet(page, tweet_text: str) -> bool:
    try:
        # لود صفحه
        await page.goto("https://x.com/home", wait_until="domcontentloaded", timeout=60000)

        # صبر کن صفحه کامل render بشه
        await asyncio.sleep(5)

        # چک لاگین
        if "login" in page.url:
            print("❌ لاگین نیست! کوکیها رو دوباره ذخیره کن")
            return False

        print(f"🔗 URL: {page.url}")

        # رد کردن cookie popup اگه بود
        try:
            cookie_btn = page.get_by_text("Refuse non-essential cookies")
            await cookie_btn.wait_for(state="visible", timeout=5000)
            await cookie_btn.click()
            await asyncio.sleep(2)
            print("🍪 cookie popup بسته شد")
        except:
            pass  # اگه popup نبود مهم نیست

        # روش ۱: کلیک روی "What is happening?!" placeholder
        try:
            placeholder = page.get_by_placeholder("What is happening?!")
            await placeholder.wait_for(state="visible", timeout=15000)
            await placeholder.click()
            await human_delay(800, 1500)
            print("✅ روش ۱: placeholder پیدا شد")
        except:
            # روش ۲: data-testid
            try:
                tweet_box = page.locator('[data-testid="tweetTextarea_0"]').first
                await tweet_box.wait_for(state="visible", timeout=15000)
                await tweet_box.click()
                await human_delay(800, 1500)
                print("✅ روش ۲: data-testid پیدا شد")
            except:
                # روش ۳: کلیک روی compose button اگه موبایل-like باشه
                compose_btn = page.locator('[data-testid="SideNav_NewTweet_Button"]').first
                await compose_btn.wait_for(state="visible", timeout=15000)
                await compose_btn.click()
                await asyncio.sleep(2)
                tweet_box = page.locator('[data-testid="tweetTextarea_0"]').first
                await tweet_box.wait_for(state="visible", timeout=15000)
                await tweet_box.click()
                print("✅ روش ۳: compose button پیدا شد")

        # تایپ متن
        await human_type(page.locator('[data-testid="tweetTextarea_0"]').first, tweet_text)
        await human_delay(1000, 2000)

        # دکمه ارسال (آخرین instance که داخل compose box است)
        send_btn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').last
        await send_btn.wait_for(state="visible", timeout=10000)
        await send_btn.scroll_into_view_if_needed()
        await human_delay(500, 800)
        await send_btn.click()

        # صبر برای confirm
        await asyncio.sleep(3)
        print(f"✅ تویت ارسال شد: {tweet_text[:50]}...")
        return True

    except Exception as e:
        # screenshot برای debug
        err_id = random.randint(1000, 9999)
        os.makedirs("data/screenshots", exist_ok=True)
        screenshot_path = f"error_{err_id}.png"
        try:
            await page.screenshot(path=screenshot_path)
            print("📸 screenshot ذخیره شد:", screenshot_path)
        except Exception:
            pass
        print(f"❌ خطا: {e}")
        return False


async def main(account_id: str = None):
    # تعیین فایل کوکی بر اساس اکانت
    if account_id:
        cookie_file = f"data/cookies/cookies_{account_id}.json"
        if not Path(cookie_file).exists():
            cookie_file = "cookies.json"
    else:
        cookie_file = "cookies.json"
        if not Path(cookie_file).exists():
            cookie_file = "data/cookies/cookies_acc1.json"

    if not Path(cookie_file).exists():
        print(f"❌ فایل کوکی '{cookie_file}' نیست! اول save_cookies.py رو اجرا کن")
        return

    if not Path(TWEETS_FILE).exists():
        # ساخت نمونه اگر فایل نبود
        with open(TWEETS_FILE, "w", encoding="utf-8") as f:
            f.write("اولین توییت تستی ربات X با سیستم ضد بن 🚀 #Bot\nدومین توییت آزمایشی با فاصله زمانی امن 🛡️\n")
        print(f"فایل نمونه {TWEETS_FILE} ساخته شد.")

    tweets = Path(TWEETS_FILE).read_text(encoding="utf-8").strip().splitlines()
    tweets = [t for t in tweets if t.strip()]

    if not tweets:
        print(f"فایل {TWEETS_FILE} خالیه!")
        return

    launch_kwargs = {
        "headless": False,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
    }
    if os.path.exists(CHROME_PATH):
        launch_kwargs["executable_path"] = CHROME_PATH

    async with async_playwright() as p:
        browser = await p.chromium.launch(**launch_kwargs)

        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )

        await load_cookies(context, cookie_file)
        page = await context.new_page()

        # anti-detection
        await page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
        """)

        for i, tweet in enumerate(tweets):
            print(f"\n📤 ارسال تویت {i+1}/{len(tweets)}")
            success = await post_tweet(page, tweet)

            if success and i < len(tweets) - 1:
                delay = random.uniform(MIN_DELAY, MAX_DELAY)
                print(f"⏳ صبر {delay/60:.1f} دقیقه تا تویت بعدی...")
                await asyncio.sleep(delay)

        await browser.close()
        print("\n✅ همه تویتها ارسال شدند!")


if __name__ == "__main__":
    acc = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(main(acc))
