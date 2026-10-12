"""
ماژول ارسال توییت (Tweeter) با زنجیره فال‌بک (Fallback Chain) سه‌مرحله‌ای و سیستم ضد بن
شامل رد کردن پاپ‌آپ کوکی، انتخاب دکمه Post با .last و اسکرین‌شات خطا
"""

import os
import random
import asyncio
import logging
from datetime import datetime
from typing import Any
from playwright.async_api import Page
from .browser import human_delay, human_type

logger = logging.getLogger("x_bot.tweeter")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENSHOTS_DIR = os.path.join(BASE_DIR, "data", "screenshots")


async def post_tweet(page: Page, tweet_text: str) -> dict[str, Any]:
    """
    ارسال توییت با بررسی مراحل کامل، رفتارهای ضد بن و بازگشت دیکشنری نتیجه.
    فیلدهای خروجی:
      - success: bool
      - error: Optional[str]
      - screenshot_path: Optional[str]
    """
    screenshot_path: str = ""

    try:
        # ۱. لود صفحه اصلی
        logger.info("در حال لود https://x.com/home ...")
        await page.goto("https://x.com/home", wait_until="domcontentloaded", timeout=60000)

        # ۲. صبر کن صفحه کامل render بشه
        await asyncio.sleep(5)

        # ۳. چک لاگین
        if "login" in page.url:
            print("❌ لاگین نیست! کوکیها رو دوباره ذخیره کن")
            logger.warning("نشست کاربر منقضی شده یا لاگین نیست.")
            return {
                "success": False,
                "error": "session_expired",
                "screenshot_path": None,
            }

        print(f"🔗 URL: {page.url}")
        logger.info(f"URL جاری: {page.url}")

        # ۴. رد کردن cookie popup اگه بود
        try:
            cookie_btn = page.get_by_text("Refuse non-essential cookies")
            await cookie_btn.wait_for(state="visible", timeout=5000)
            await cookie_btn.click()
            await asyncio.sleep(2)
            print("🍪 cookie popup بسته شد")
            logger.info("پاپ‌آپ کوکی با موفقیت بسته شد.")
        except Exception:
            pass  # اگه popup نبود مهم نیست

        # ۵. پیدا کردن tweet box با زنجیره ۳ مرحله‌ای
        tweet_box_found = False

        # روش ۱: کلیک روی "What is happening?!" placeholder
        try:
            placeholder = page.get_by_placeholder("What is happening?!")
            await placeholder.wait_for(state="visible", timeout=15000)
            await placeholder.click()
            await human_delay(800, 1500)
            print("✅ روش ۱: placeholder پیدا شد")
            logger.info("روش ۱: کادر placeholder پیدا و فوکوس شد.")
            tweet_box_found = True
        except Exception:
            # روش ۲: data-testid
            try:
                tweet_box = page.locator('[data-testid="tweetTextarea_0"]').first
                await tweet_box.wait_for(state="visible", timeout=15000)
                await tweet_box.click()
                await human_delay(800, 1500)
                print("✅ روش ۲: data-testid پیدا شد")
                logger.info("روش ۲: سلکتور tweetTextarea_0 پیدا و کلیک شد.")
                tweet_box_found = True
            except Exception:
                # روش ۳: کلیک روی compose button اگه موبایل-like باشه
                try:
                    compose_btn = page.locator('[data-testid="SideNav_NewTweet_Button"]').first
                    await compose_btn.wait_for(state="visible", timeout=15000)
                    await compose_btn.click()
                    await asyncio.sleep(2)
                    tweet_box = page.locator('[data-testid="tweetTextarea_0"]').first
                    await tweet_box.wait_for(state="visible", timeout=15000)
                    await tweet_box.click()
                    print("✅ روش ۳: compose button پیدا شد")
                    logger.info("روش ۳: دکمه شناور ایجاد توییت کلیک و کادر باز شد.")
                    tweet_box_found = True
                except Exception as e3:
                    raise RuntimeError(f"هیچ‌یک از ۳ روش پیدا کردن کادر توییت موفق نبود: {e3}")

        # ۶. تایپ متن به شیوه انسانی
        target_textarea = page.locator('[data-testid="tweetTextarea_0"]').first
        await human_type(target_textarea, tweet_text)
        await human_delay(1000, 2000)

        # ۷. دکمه ارسال (آخرین instance که داخل compose box است)
        send_btn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').last
        await send_btn.wait_for(state="visible", timeout=10000)
        await send_btn.scroll_into_view_if_needed()
        await human_delay(500, 800)
        await send_btn.click()

        # ۸. صبر برای confirm
        await asyncio.sleep(3)
        print(f"✅ تویت ارسال شد: {tweet_text[:50]}...")
        logger.info(f"توییت ارسال شد: {tweet_text[:40]}...")

        return {
            "success": True,
            "error": None,
            "screenshot_path": None,
        }

    except Exception as e:
        # screenshot برای debug
        err_id = random.randint(1000, 9999)
        os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
        screenshot_path = os.path.join(SCREENSHOTS_DIR, f"error_{err_id}.png")
        try:
            await page.screenshot(path=screenshot_path)
            print(f"📸 screenshot ذخیره شد: {screenshot_path}")
        except Exception:
            pass

        print(f"❌ خطا: {e}")
        logger.error(f"خطا در ارسال توییت: {e}")

        return {
            "success": False,
            "error": str(e),
            "screenshot_path": screenshot_path,
        }
