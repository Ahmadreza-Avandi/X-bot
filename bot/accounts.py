"""
ماژول مدیریت اکانت‌های توییتر (Accounts Manager)
خواندن، نوشتن، ایجاد، به‌روزرسانی و حذف اکانت‌ها در فایل data/accounts.json
"""

import os
import json
import uuid
import logging
from typing import Any, Optional
from .cookie_manager import cookies_exist, _get_cookie_file_path

logger = logging.getLogger("x_bot.accounts")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
ACCOUNTS_FILE = os.path.join(DATA_DIR, "accounts.json")


def _ensure_data_dir() -> None:
    """اطمینان از وجود پوشه داده‌ها و فایل اکانت‌ها."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(ACCOUNTS_FILE):
        with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
            json.dump([], f, ensure_ascii=False, indent=2)


def load_accounts() -> list[dict[str, Any]]:
    """
    خواندن فهرست تمام اکانت‌ها از فایل accounts.json همراه با بررسی وضعیت واقعی کوکی.
    """
    _ensure_data_dir()
    try:
        with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
            accounts = json.load(f)

        # به‌روزرسانی فیلد cookies_saved بر اساس وضعیت واقعی فایل در دیسک
        for acc in accounts:
            acc["cookies_saved"] = cookies_exist(acc.get("id", ""))
        return accounts
    except Exception as e:
        logger.error(f"خطا در خواندن فایل اکانت‌ها: {e}")
        return []


def save_accounts(accounts: list[dict[str, Any]]) -> bool:
    """
    ذخیره‌سازی فهرست اکانت‌ها در فایل accounts.json.
    """
    _ensure_data_dir()
    try:
        with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
            json.dump(accounts, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.error(f"خطا در ذخیره‌سازی فایل اکانت‌ها: {e}")
        return False


def get_account_by_id(account_id: str) -> Optional[dict[str, Any]]:
    """یافتن اکانت بر اساس شناسه."""
    accounts = load_accounts()
    for acc in accounts:
        if acc.get("id") == account_id:
            return acc
    return None


def add_account(name: str, username: str) -> dict[str, Any]:
    """
    افزودن یک اکانت جدید به سیستم با مقادیر پیش‌فرض.
    """
    # تصحیح فرمت یوزرنیم تا با @ شروع شود
    clean_username = username.strip()
    if not clean_username.startswith("@"):
        clean_username = f"@{clean_username}"

    accounts = load_accounts()
    new_id = f"acc_{uuid.uuid4().hex[:8]}"

    new_account = {
        "id": new_id,
        "name": name.strip(),
        "username": clean_username,
        "active": True,
        "last_tweet_at": None,
        "total_tweets": 0,
        "cookies_saved": False,
    }

    accounts.append(new_account)
    save_accounts(accounts)
    logger.info(f"اکانت جدید با شناسه {new_id} ({clean_username}) ایجاد شد.")
    return new_account


def remove_account(account_id: str) -> bool:
    """
    حذف اکانت و پاک کردن فایل کوکی مربوط به آن در صورت وجود.
    """
    accounts = load_accounts()
    filtered = [acc for acc in accounts if acc.get("id") != account_id]

    if len(filtered) == len(accounts):
        logger.warning(f"اکانت با شناسه {account_id} برای حذف یافت نشد.")
        return False

    save_accounts(filtered)

    # حذف فایل کوکی مربوطه
    try:
        cookie_path = _get_cookie_file_path(account_id)
        if os.path.isfile(cookie_path):
            os.remove(cookie_path)
            logger.info(f"فایل کوکی اکانت {account_id} حذف شد.")
    except Exception as e:
        logger.error(f"خطا در حذف فایل کوکی اکانت {account_id}: {e}")

    logger.info(f"اکانت {account_id} با موفقیت حذف شد.")
    return True


def update_account(account_id: str, fields_dict: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    به‌روزرسانی فیلدهای دلخواه یک اکانت (مانند total_tweets، last_tweet_at و...).
    """
    accounts = load_accounts()
    target = None

    for acc in accounts:
        if acc.get("id") == account_id:
            acc.update(fields_dict)
            target = acc
            break

    if target:
        save_accounts(accounts)
        logger.info(f"اکانت {account_id} با مقادیر جدید به‌روزرسانی شد.")
        return target

    logger.warning(f"اکانت {account_id} جهت به‌روزرسانی یافت نشد.")
    return None
