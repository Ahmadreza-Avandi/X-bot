"""
ماژول مدیریت مرورگر Playwright و تکنیک‌های ضد بن (Anti-Detection)
این ماژول مرورگر را با هویت طبیعی، اسکریپت‌های دور زدن تشخیص ربات و الگوهای رفتاری شبه‌انسان راه‌اندازی می‌کند.
"""

import os
import random
import asyncio
import logging
from typing import Optional
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, ElementHandle, Locator

# تنظیم لاگر
logger = logging.getLogger("x_bot.browser")

# تنظیمات پیش‌فرض ضد بن مرورگر
DEFAULT_CHROME_PATH = os.getenv("CHROME_PATH", "/usr/bin/google-chrome-unstable")
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# آرگومان‌های خط فرمان برای غیرفعال‌سازی نشانه‌های اتوماسیون
BROWSER_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-infobars",
    "--disable-extensions",
]

# اسکریپت تزریقی جهت مخفی‌سازی فلگ‌های اتوماسیون و مرورگر بدون سربرگ
STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => false });
window.chrome = { runtime: {} };
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
"""


async def human_delay(min_ms: int = 800, max_ms: int = 2500) -> None:
    """
    ایجاد تاخیر تصادفی شبه‌انسانی به میلی‌ثانیه برای طبیعی جلوه دادن تعاملات.
    """
    await asyncio.sleep(random.uniform(min_ms, max_ms) / 1000)


async def human_type(element: Locator | ElementHandle, text: str) -> None:
    """
    تایپ متن کاراکتر به کاراکتر با تاخیرهای متغیر انسانی.
    هرگز از element.fill استفاده نمی‌شود تا رویدادهای کیبورد مرورگر شبیه‌سازی شوند.
    شامل ۱۰٪ احتمال مکث اضافه بین ۰.۳ تا ۰.۸ ثانیه به عنوان زمان فکر کردن کاربر.
    """
    logger.info(f"در حال تایپ متنی با طول {len(text)} کاراکتر به سبک انسانی...")
    for char in text:
        # تاخیر متغیر بین ۵۰ تا ۱۸۰ میلی‌ثانیه برای هر کاراکتر
        char_delay = random.uniform(0.050, 0.180)
        await element.type(char, delay=int(char_delay * 1000))

        # احتمال ۱۰٪ مکث شبه‌تفکر انسانی
        if random.random() < 0.10:
            thinking_pause = random.uniform(0.3, 0.8)
            await asyncio.sleep(thinking_pause)


async def dismiss_cookie_popup(page: Page) -> None:
    """
    بررسی و بستن پنجره پذیرش کوکی در توییتر/ایکس در صورت ظاهر شدن.
    اگر دکمه رد کوکی‌های غیرضروری پیدا نشد، بدون خطا عبور می‌کند.
    """
    try:
        # جستجوی دکمه بر اساس متن انگلیسی و سلکتورهای رایج توییتر
        cookie_button = page.locator(
            'text="Refuse non-essential cookies", '
            'text="رد کوکی‌های غیرضروری", '
            '[data-testid="CookieBannerClose"], '
            'button:has-text("Refuse non-essential")'
        ).first
        
        # اگر در بازه ۴ ثانیه قابل مشاهده بود، کلیک شود
        await cookie_button.wait_for(state="visible", timeout=4000)
        await cookie_button.click()
        logger.info("پنجره کوکی با موفقیت بسته شد.")
        await human_delay(400, 800)
    except Exception:
        # در صورت نبودن پاپ‌آپ، بدون هیچ مشکلی ادامه می‌دهیم
        logger.debug("پاپ‌آپ کوکی مشاهده نشد یا قبلاً بسته شده است.")
        pass


async def create_browser_context(playwright_instance, headless: bool = True) -> tuple[Browser, BrowserContext]:
    """
    ایجاد کانتکست مرورگر ضد بن با تنظیمات استاندارد و ویوپورت ۱۲۸۰x۸۰۰.
    """
    launch_kwargs = {
        "headless": headless,
        "args": BROWSER_ARGS,
    }

    # در صورتی که فایل باینری اختصاصی کروم وجود داشته باشد از آن استفاده می‌شود
    if os.path.exists(DEFAULT_CHROME_PATH):
        launch_kwargs["executable_path"] = DEFAULT_CHROME_PATH
        logger.info(f"استفاده از مسیر اجرایی کروم: {DEFAULT_CHROME_PATH}")
    else:
        logger.info("مسیر اختصاصی کروم یافت نشد؛ راه‌اندازی با موتور پیش‌فرض Chromium پلی‌رایت.")

    browser = await playwright_instance.chromium.launch(**launch_kwargs)

    # ساخت کانتکست با User-Agent واقعی و اندازه صفحه مشخص
    context = await browser.new_context(
        user_agent=USER_AGENT,
        viewport={"width": 1280, "height": 800},
        locale="fa-IR",
        timezone_id="Asia/Tehran",
    )

    # تزریق اسکریپت ضد شناسایی برای مخفی‌سازی ردپای اتوماسیون
    await context.add_init_script(STEALTH_INIT_SCRIPT)
    logger.info("کانتکست مرورگر با ویژگی‌های ضد بن با موفقیت ایجاد شد.")

    return browser, context
