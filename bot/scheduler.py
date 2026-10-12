"""
ماژول صف و زمان‌بندی توییت‌ها (Scheduler) با استفاده از APScheduler
دارای انطباق سخت‌گیرانه با قوانین ضد بن:
۱. حداقل فاصله ۳۶۰۰ ثانیه (۱ ساعت) بین دو توییت متوالی هر اکانت
۲. سقف حداکثر ۱۵ توییت در روز برای هر اکانت
"""

import os
import uuid
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Optional
from apscheduler.schedulers.background import BackgroundScheduler
from playwright.async_api import async_playwright

from .browser import create_browser_context
from .cookie_manager import load_cookies, cookies_exist
from .tweeter import post_tweet
from .accounts import get_account_by_id, update_account, load_accounts

logger = logging.getLogger("x_bot.scheduler")

# صف درون‌حافظه‌ای
_tweet_queue: list[dict[str, Any]] = []

# صف زمان‌بندی APScheduler
_scheduler = BackgroundScheduler()
_scheduler.start()


def get_queue(account_id: Optional[str] = None) -> list[dict[str, Any]]:
    """
    دریافت کل صف توییت‌ها یا فیلتر شده بر اساس شناسه یک اکانت خاص.
    """
    if account_id:
        return [t for t in _tweet_queue if t.get("account_id") == account_id]
    return list(_tweet_queue)


def delete_from_queue(tweet_id: str) -> bool:
    """
    حذف یک آیتم از صف در صورتی که هنوز در وضعیت pending باشد.
    """
    global _tweet_queue
    for item in _tweet_queue:
        if item.get("id") == tweet_id and item.get("status") == "pending":
            _tweet_queue = [t for t in _tweet_queue if t.get("id") != tweet_id]
            # حذف جاب مربوطه از اسکجولر در صورت وجود
            try:
                if _scheduler.get_job(tweet_id):
                    _scheduler.remove_job(tweet_id)
            except Exception:
                pass
            logger.info(f"توییت با شناسه {tweet_id} از صف حذف شد.")
            return True
    return False


def clear_sent() -> int:
    """
    پاک‌سازی توییت‌های ارسال شده (sent) یا شکست‌خورده (failed) از حافظه.
    """
    global _tweet_queue
    initial_len = len(_tweet_queue)
    _tweet_queue = [t for t in _tweet_queue if t.get("status") == "pending"]
    removed_count = initial_len - len(_tweet_queue)
    logger.info(f"تعداد {removed_count} آیتم ارسال‌شده یا خطادار از حافظه صف پاکسازی شد.")
    return removed_count


def _count_tweets_today(account_id: str) -> int:
    """محاسبه تعداد توییت‌های موفق ارسال شده توسط این اکانت در ۲۴ ساعت گذشته."""
    now = datetime.now()
    cutoff = now - timedelta(hours=24)
    count = 0
    for t in _tweet_queue:
        if t.get("account_id") == account_id and t.get("status") == "sent":
            sent_at_str = t.get("sent_at")
            if sent_at_str:
                try:
                    sent_dt = datetime.fromisoformat(sent_at_str)
                    if sent_dt >= cutoff:
                        count += 1
                except Exception:
                    pass
    return count


def _check_antiban_rules(account_id: str) -> tuple[bool, Optional[str]]:
    """
    بررسی قوانین ضد بن:
    - قانون ۱: حداقل ۳۶۰۰ ثانیه (۱ ساعت) بین هر دو توییت یک اکانت
    - قانون ۲: حداکثر ۱۵ توییت در روز
    """
    account = get_account_by_id(account_id)
    if not account:
        return False, "اکانت مورد نظر یافت نشد."

    # بررسی قانون فاصله ۱ ساعته
    last_tweet_str = account.get("last_tweet_at")
    if last_tweet_str:
        try:
            last_dt = datetime.fromisoformat(last_tweet_str)
            seconds_passed = (datetime.now() - last_dt).total_seconds()
            if seconds_passed < 3600:
                remaining_sec = int(3600 - seconds_passed)
                minutes = remaining_sec // 60
                return False, (
                    f"قانون ضد بن: از آخرین توییت این اکانت کمتر از ۱ ساعت گذشته است. "
                    f"لطفاً {minutes} دقیقه دیگر مجدداً تلاش کنید."
                )
        except Exception as e:
            logger.error(f"خطا در پارس زمان آخرین توییت: {e}")

    # بررسی قانون حداکثر ۱۵ توییت در ۲۴ ساعت
    tweets_today = _count_tweets_today(account_id)
    if tweets_today >= 15:
        return False, "قانون ضد بن: سقف مجاز روزانه (۱۵ توییت در ۲۴ ساعت) برای این اکانت تکمیل شده است."

    return True, None


async def _execute_tweet_async(account_id: str, text: str) -> dict[str, Any]:
    """
    اجرای پروسه ارسال توییت با Playwright و مرورگر Headless طبق استانداردهای ضد بن.
    """
    if not cookies_exist(account_id):
        return {
            "success": False,
            "error": "کوکی ذخیره شده برای این اکانت یافت نشد. لطفاً ابتدا لاگین کرده و کوکی را ذخیره کنید.",
        }

    async with async_playwright() as p:
        browser = None
        try:
            # ایجاد کانتکست با ویژگی‌های ضد بن
            browser, context = await create_browser_context(p, headless=True)

            # لود کوکی‌های حساب کاربری
            loaded = await load_cookies(account_id, context)
            if not loaded:
                return {
                    "success": False,
                    "error": "خطا در بارگذاری کوکی‌های حساب کاربری.",
                }

            page = await context.new_page()
            result = await post_tweet(page, text)

            # اگر ارسال موفق بود، مشخصات اکانت را به‌روزرسانی کن
            if result.get("success"):
                acc = get_account_by_id(account_id)
                current_count = (acc.get("total_tweets", 0) if acc else 0) + 1
                now_iso = datetime.now().isoformat()
                update_account(account_id, {
                    "last_tweet_at": now_iso,
                    "total_tweets": current_count,
                })

            return result

        except Exception as e:
            logger.error(f"خطای سیستمی حین اجرای Playwright برای توییت: {e}")
            return {
                "success": False,
                "error": f"خطای سیستمی: {str(e)}",
            }
        finally:
            if browser:
                try:
                    await browser.close()
                except Exception:
                    pass


def execute_tweet_sync(account_id: str, text: str) -> dict[str, Any]:
    """
    پوشش همگام (Synchronous Wrapper) برای فراخوانی متد آسنکرون Playwright در یک حلقه رویداد مستقل.
    """
    # ابتدا بررسی قوانین ضد بن
    allowed, antiban_error = _check_antiban_rules(account_id)
    if not allowed:
        logger.warning(f"مانع ضد بن: {antiban_error}")
        return {"success": False, "error": antiban_error}

    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(_execute_tweet_async(account_id, text))
        return result
    finally:
        loop.close()


def process_next(account_id: str) -> Optional[dict[str, Any]]:
    """
    پردازش و ارسال اولین توییت در وضعیت pending مربوط به اکانت مورد نظر.
    """
    target_item = None
    for item in _tweet_queue:
        if item.get("account_id") == account_id and item.get("status") == "pending":
            target_item = item
            break

    if not target_item:
        logger.info(f"هیچ توییت معلقی برای اکانت {account_id} در صف وجود ندارد.")
        return None

    logger.info(f"در حال پردازش توییت {target_item['id']} از صف برای اکانت {account_id}...")
    res = execute_tweet_sync(account_id, target_item["text"])

    if res.get("success"):
        target_item["status"] = "sent"
        target_item["sent_at"] = datetime.now().isoformat()
        target_item["error"] = None
    else:
        target_item["status"] = "failed"
        target_item["error"] = res.get("error", "خطای ناشناخته")

    return target_item


def _scheduled_job_runner(tweet_id: str, account_id: str, text: str) -> None:
    """تابع اجرایی داخلی توسط جاب زمان‌بندی شده در APScheduler."""
    logger.info(f"آغاز اجرای جاب زمان‌بندی شده برای توییت {tweet_id}...")
    for item in _tweet_queue:
        if item.get("id") == tweet_id:
            res = execute_tweet_sync(account_id, text)
            if res.get("success"):
                item["status"] = "sent"
                item["sent_at"] = datetime.now().isoformat()
                item["error"] = None
            else:
                item["status"] = "failed"
                item["error"] = res.get("error", "خطای زمان‌بندی")
            break


def add_to_queue(account_id: str, text: str, scheduled_at: Optional[str] = None) -> dict[str, Any]:
    """
    افزودن توییت به صف.
    اگر scheduled_at مشخص نشده باشد، توییت در صف قرار گرفته و برای پردازش بعدی آماده می‌شود.
    اگر زمان مشخص شده باشد، با APScheduler زمان‌بندی می‌گردد.
    """
    tweet_id = str(uuid.uuid4())
    now_iso = datetime.now().isoformat()

    item = {
        "id": tweet_id,
        "account_id": account_id,
        "text": text,
        "scheduled_at": scheduled_at,
        "status": "pending",
        "created_at": now_iso,
        "sent_at": None,
        "error": None,
    }

    _tweet_queue.append(item)
    logger.info(f"توییت جدید {tweet_id} به صف اضافه شد. (زمان‌بندی: {scheduled_at or 'فوری'})")

    if scheduled_at:
        try:
            run_date = datetime.fromisoformat(scheduled_at)
            _scheduler.add_job(
                _scheduled_job_runner,
                trigger="date",
                run_date=run_date,
                args=[tweet_id, account_id, text],
                id=tweet_id,
                replace_existing=True,
            )
            logger.info(f"جاب {tweet_id} با موفقیت در APScheduler برای تاریخ {run_date} تنظیم شد.")
        except Exception as e:
            logger.error(f"خطا در ایجاد جاب APScheduler برای توییت {tweet_id}: {e}")
            item["status"] = "failed"
            item["error"] = f"خطا در فرمت زمان‌بندی: {str(e)}"

    return item
