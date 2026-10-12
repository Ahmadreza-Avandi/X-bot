"""
اسکریپت مستقل ذخیره‌سازی کوکی‌های X (توییتر) با Playwright Persistent Context
می‌توانید بدون آرگومان اجرا کنید (پیش‌فرض: cookies.json) یا شناسه اکانت را ارسال کنید:
  python save_cookies.py
  python save_cookies.py acc1
"""

import sys
import os
import json
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

CHROME_PATH = os.getenv("CHROME_PATH", "/usr/bin/google-chrome-unstable")


async def save_cookies(account_id: str = None):
    # تعیین مسیر پروفایل موقت و فایل ذخیره کوکی
    if account_id:
        user_data_dir = f"/tmp/temp-profile-{account_id}"
        cookie_file = f"data/cookies/cookies_{account_id}.json"
        os.makedirs("data/cookies", exist_ok=True)
    else:
        user_data_dir = "/tmp/temp-profile"
        cookie_file = "cookies.json"

    print(f"🌐 در حال باز کردن مرورگر کروم جهت لاگین (پروفایل: {user_data_dir})...")

    launch_kwargs = {
        "user_data_dir": user_data_dir,
        "headless": False,
        "args": ["--disable-blink-features=AutomationControlled"],
    }
    # استفاده از مسیر باینری در صورت وجود
    if os.path.exists(CHROME_PATH):
        launch_kwargs["executable_path"] = CHROME_PATH

    async with async_playwright() as p:
        browser = await p.chromium.launch_persistent_context(**launch_kwargs)

        page = browser.pages[0] if browser.pages else await browser.new_page()
        print("🔗 در حال باز کردن https://x.com/login ...")
        await page.goto("https://x.com/login")

        print("\n" + "=" * 50)
        print("⏳ لطفاً در پنجره مرورگر لاگین کنید، سپس دکمه Enter را در ترمینال بزنید...")
        print("=" * 50)
        input()  # صبر میکنه تا لاگین کنی

        # ذخیره کوکیها
        cookies = await browser.cookies()
        with open(cookie_file, "w", encoding="utf-8") as f:
            json.dump(cookies, f, indent=2, ensure_ascii=False)

        # اگر اکانت مشخص بود، در صورت وجود فایل اصلی هم کپی کنیم
        if not account_id:
            # ذخیره یک نسخه در data/cookies/ برای سازگاری با داشبورد
            os.makedirs("data/cookies", exist_ok=True)
            with open("data/cookies/cookies_acc1.json", "w", encoding="utf-8") as f:
                json.dump(cookies, f, indent=2, ensure_ascii=False)

        print(f"✅ {len(cookies)} کوکی در '{cookie_file}' ذخیره شد!")
        await browser.close()


if __name__ == "__main__":
    acc = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(save_cookies(acc))
