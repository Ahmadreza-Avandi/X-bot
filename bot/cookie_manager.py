"""
ماژول مدیریت کوکی‌ها (Cookie Manager)
ذخیره‌سازی، بازیابی، بررسی اعتبار و ورود مستقیم کوکی‌ها در دایرکتوری data/cookies/
"""

import os
import json
import logging
from datetime import datetime
from typing import Any, Optional
from playwright.async_api import BrowserContext

logger = logging.getLogger("x_bot.cookie_manager")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COOKIES_DIR = os.path.join(BASE_DIR, "data", "cookies")


def _get_cookie_file_path(account_id: str) -> str:
    """ایجاد مسیر کامل فایل کوکی برای شناسه اکانت داده‌شده."""
    os.makedirs(COOKIES_DIR, exist_ok=True)
    return os.path.join(COOKIES_DIR, f"cookies_{account_id}.json")


def cookies_exist(account_id: str) -> bool:
    """بررسی وجود فایل کوکی برای یک اکانت خاص."""
    path = _get_cookie_file_path(account_id)
    return os.path.isfile(path)


async def save_cookies(account_id: str, context: BrowserContext) -> bool:
    """
    دریافت کوکی‌های جاری از کانتکست Playwright و ذخیره در فایل اختصاصی اکانت.
    """
    try:
        cookies = await context.cookies()
        if not cookies:
            logger.warning(f"هیچ کوکی فعالی برای اکانت {account_id} یافت نشد.")
            return False

        data = {
            "account_id": account_id,
            "saved_at": datetime.now().isoformat(),
            "count": len(cookies),
            "cookies": cookies
        }

        file_path = _get_cookie_file_path(account_id)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        # ذخیره یک کپی در ریشه پروژه (cookies.json) برای راحتی اسکریپت‌های مستقل
        try:
            root_cookie = os.path.join(BASE_DIR, "cookies.json")
            with open(root_cookie, "w", encoding="utf-8") as rf:
                json.dump(cookies, rf, ensure_ascii=False, indent=2)
        except Exception:
            pass

        logger.info(f"تعداد {len(cookies)} کوکی برای اکانت {account_id} ذخیره شد.")
        return True
    except Exception as e:
        logger.error(f"خطا در ذخیره‌سازی کوکی‌های اکانت {account_id}: {e}")
        return False


def save_cookies_raw(account_id: str, cookies_input: Any) -> tuple[bool, str]:
    """
    ذخیره‌سازی مستقیم کوکی‌ها از طریق فرم وب (JSON استاندارد یا توکن‌های مستقیم).
    """
    try:
        os.makedirs(COOKIES_DIR, exist_ok=True)
        final_cookies = []

        if isinstance(cookies_input, str):
            # اگر کاربر متن JSON وارد کرده باشد
            parsed = json.loads(cookies_input.strip())
        else:
            parsed = cookies_input

        # حالت اول: اگر لیست کوکی‌های EditThisCookie یا Playwright باشد
        if isinstance(parsed, list):
            final_cookies = parsed
        elif isinstance(parsed, dict):
            if "cookies" in parsed and isinstance(parsed["cookies"], list):
                final_cookies = parsed["cookies"]
            else:
                # اگر کاربر auth_token و ct0 را به صورت key-value داده باشد
                for k, v in parsed.items():
                    final_cookies.append({
                        "name": str(k).strip(),
                        "value": str(v).strip(),
                        "domain": ".x.com",
                        "path": "/",
                    })

        if not final_cookies:
            return False, "هیچ کوکی معتبری استخراج نشد."

        file_path = _get_cookie_file_path(account_id)
        data = {
            "account_id": account_id,
            "saved_at": datetime.now().isoformat(),
            "count": len(final_cookies),
            "cookies": final_cookies
        }

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        # همچنین یک نسخه همگانی
        try:
            root_cookie = os.path.join(BASE_DIR, "cookies.json")
            with open(root_cookie, "w", encoding="utf-8") as rf:
                json.dump(final_cookies, rf, ensure_ascii=False, indent=2)
        except Exception:
            pass

        return True, f"تعداد {len(final_cookies)} کوکی با موفقیت ثبت شد."
    except Exception as e:
        logger.error(f"خطا در ذخیره دستی کوکی‌ها: {e}")
        return False, f"فرمت کوکی نامعتبر است: {str(e)}"


async def load_cookies(account_id: str, context: BrowserContext) -> bool:
    """لود کردن کوکی‌های ذخیره شده اکانت در کانتکست Playwright."""
    if not cookies_exist(account_id):
        # بررسی فال‌بک فایل سراسری cookies.json
        root_cookie = os.path.join(BASE_DIR, "cookies.json")
        if os.path.isfile(root_cookie):
            try:
                with open(root_cookie, "r", encoding="utf-8") as f:
                    c = json.load(f)
                await context.add_cookies(c if isinstance(c, list) else c.get("cookies", []))
                return True
            except Exception:
                pass
        return False

    file_path = _get_cookie_file_path(account_id)
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        cookies = data if isinstance(data, list) else data.get("cookies", [])
        if not cookies:
            return False

        await context.add_cookies(cookies)
        return True
    except Exception as e:
        logger.error(f"خطا در لود کوکی‌های اکانت {account_id}: {e}")
        return False


def get_cookie_meta(account_id: str) -> dict[str, Any]:
    """دریافت متادیتا و بررسی وجود توکن‌های حیاتی auth_token و ct0."""
    file_path = _get_cookie_file_path(account_id)
    if not os.path.isfile(file_path):
        return {"exists": False, "saved_at": None, "count": 0, "has_auth_token": False, "has_ct0": False}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        cookies = data if isinstance(data, list) else data.get("cookies", [])
        names = [c.get("name") for c in cookies if isinstance(c, dict)]

        return {
            "exists": True,
            "saved_at": data.get("saved_at") if isinstance(data, dict) else None,
            "count": len(cookies),
            "has_auth_token": "auth_token" in names,
            "has_ct0": "ct0" in names,
        }
    except Exception:
        return {"exists": False, "saved_at": None, "count": 0, "has_auth_token": False, "has_ct0": False}
