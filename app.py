"""
سرور Flask و ارائه‌دهنده REST API برای ربات اتوماسیون X (توییتر)
شامل روت‌های مدیریت اکانت‌ها، لاگین و استخراج کوکی، صف زمان‌بندی و ارسال توییت.
"""

import os
import sys
import logging
import asyncio
from datetime import datetime
from collections import deque
from flask import Flask, render_template, request, jsonify
from playwright.async_api import async_playwright

from bot.browser import create_browser_context, human_delay, dismiss_cookie_popup
from bot.cookie_manager import save_cookies, cookies_exist, get_cookie_meta, save_cookies_raw, load_cookies
from bot.accounts import (
    load_accounts,
    add_account,
    remove_account,
    update_account,
    get_account_by_id,
)
from bot.scheduler import (
    add_to_queue,
    get_queue,
    delete_from_queue,
    clear_sent,
    execute_tweet_sync,
)

# تنظیم صف نگهداری ۵۰ لاگ اخیر در حافظه
MAX_LOG_ENTRIES = 50
in_memory_logs: deque[dict] = deque(maxlen=MAX_LOG_ENTRIES)


class ListLogHandler(logging.Handler):
    """ثبت لاگ‌های سیستم در حافظه جهت ارائه به داشبورد وب از طریق API."""
    def emit(self, record):
        try:
            log_entry = {
                "timestamp": datetime.fromtimestamp(record.created).strftime("%H:%M:%S"),
                "level": record.levelname,
                "message": record.getMessage(),
                "logger": record.name,
            }
            in_memory_logs.appendleft(log_entry)
        except Exception:
            pass


# راه‌اندازی لاگر اصلی برنامه
logger = logging.getLogger("x_bot")
logger.setLevel(logging.INFO)

# افزودن هندلر کنسول و هندلر حافظه
stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
logger.addHandler(stream_handler)
logger.addHandler(ListLogHandler())

# ایجاد اپلیکیشن Flask
app = Flask(__name__, template_folder="templates", static_folder="static")


@app.route("/")
def index():
    """نمایش داشبورد وب تک‌صفحه‌ای مدیریت ربات."""
    return render_template("index.html")


@app.route("/api/accounts", methods=["GET"])
def api_get_accounts():
    """دریافت لیست تمام اکانت‌های ثبت شده همراه با اطلاعات کامل."""
    accounts = load_accounts()
    return jsonify(accounts)


@app.route("/api/accounts", methods=["POST"])
def api_add_account():
    """ثبت اکانت جدید با نام و نام کاربری."""
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    username = data.get("username", "").strip()

    if not name or not username:
        return jsonify({"success": False, "error": "نام و نام کاربری الزامی هستند."}), 400

    new_acc = add_account(name, username)
    logger.info(f"اکانت جدید اضافه شد: {name} ({username})")
    return jsonify({"success": True, "account": new_acc}), 201


@app.route("/api/accounts/<account_id>", methods=["DELETE"])
def api_delete_account(account_id):
    """حذف اکانت مشخص شده و فایل کوکی‌های ذخیره شده آن."""
    success = remove_account(account_id)
    if success:
        return jsonify({"success": True, "message": "اکانت و فایل کوکی با موفقیت حذف شدند."})
    return jsonify({"success": False, "error": "اکانت یافت نشد."}), 404


async def _perform_save_cookies_async(account_id: str) -> dict:
    """
    باز کردن مرورگر با حالت گرافیکی (headless=False) با launch_persistent_context جهت لاگین توسط کاربر
    و استخراج کوکی‌ها پس از ورود موفق به توییتر طبق مشخصات پروژه.
    """
    logger.info(f"شروع فرایند ورود و ذخیره کوکی برای اکانت {account_id}...")
    user_data_dir = f"/tmp/temp-profile-{account_id}"
    is_headless = os.getenv("HEADLESS_SAVE", "false").lower() == "true"
    chrome_path = os.getenv("CHROME_PATH", "/usr/bin/google-chrome-unstable")

    launch_kwargs = {
        "user_data_dir": user_data_dir,
        "headless": is_headless,
        "args": ["--disable-blink-features=AutomationControlled"],
    }
    if os.path.exists(chrome_path):
        launch_kwargs["executable_path"] = chrome_path

    async with async_playwright() as p:
        try:
            context = await p.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as e:
            logger.error(f"امکان راه‌اندازی مرورگر گرافیکی وجود ندارد: {e}")
            return {
                "success": False,
                "message": f"خطا در اجرای مرورگر (اطمینان حاصل کنید محیط گرافیکی در دسترس است): {str(e)}",
            }

        try:
            page = context.pages[0] if context.pages else await context.new_page()
            logger.info("در حال هدایت به صفحه لاگین x.com/login ...")
            await page.goto("https://x.com/login", wait_until="domcontentloaded", timeout=60000)

            await dismiss_cookie_popup(page)
            logger.info("منتظر لاگین کاربر و ورود به صفحه اصلی (حداکثر ۹۰ ثانیه / ۱.۵ دقیقه مهلت)...")

            # حلقه بررسی فعال تا ۹۰ ثانیه (۴۵ بررسی ۲ ثانیه‌ای)
            # به محض لاگین، بدون اتلاف وقت فورا شناسایی و ذخیره می‌شود
            logged_in = False
            for attempt in range(45):
                await asyncio.sleep(2)
                try:
                    cur_url = page.url.lower()
                    if "/home" in cur_url:
                        logger.info(f"ورود کاربر به صفحه اصلی در ثانیه {(attempt + 1) * 2} تشخیص داده شد.")
                        logged_in = True
                        break

                    # بررسی کوکی‌های احراز هویت
                    cookies = await context.cookies()
                    has_auth = any(c.get("name") == "auth_token" for c in cookies)
                    if has_auth:
                        logger.info(f"کوکی auth_token در ثانیه {(attempt + 1) * 2} شناسایی شد.")
                        logged_in = True
                        break
                except Exception:
                    pass

            if not logged_in:
                cookies = await context.cookies()
                auth_cookies = [c for c in cookies if c.get("name") in ("auth_token", "ct0", "twid")]
                if not auth_cookies:
                    logger.warning("کاربر در مهلت ۱.۵ دقیقه‌ای (۹۰ ثانیه) لاگین نکرد یا کوکی احراز هویت ثبت نشد.")
                    return {
                        "success": False,
                        "message": "مهلت ۱.۵ دقیقه تمام شد یا ورود ناموفق بود. لطفاً مجدداً امتحان کنید یا از دکمه پیست کوکی استفاده نمایید.",
                    }

            # ذخیره‌سازی کوکی‌ها
            saved = await save_cookies(account_id, context)
            if saved:
                update_account(account_id, {"cookies_saved": True})
                logger.info(f"کوکی‌های اکانت {account_id} با موفقیت ذخیره شدند.")
                return {
                    "success": True,
                    "message": "کوکی‌های نشست با موفقیت ذخیره و ثبت شدند.",
                }
            else:
                return {
                    "success": False,
                    "message": "خطا در استخراج کوکی‌ها از کانتکست مرورگر.",
                }

        finally:
            try:
                await context.close()
            except Exception:
                pass


@app.route("/api/accounts/<account_id>/save-cookies", methods=["POST"])
def api_save_cookies(account_id):
    """آغاز پروسه لاگین و ذخیره‌سازی کوکی برای اکانت داده‌شده."""
    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"success": False, "message": "اکانت یافت نشد."}), 404

    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(_perform_save_cookies_async(account_id))
        status_code = 200 if result.get("success") else 400
        return jsonify(result), status_code
    finally:
        loop.close()


@app.route("/api/accounts/<account_id>/status", methods=["GET"])
def api_account_status(account_id):
    """دریافت وضعیت کوکی‌ها، زمان آخرین توییت و آمار کلی اکانت."""
    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"error": "اکانت یافت نشد."}), 404

    meta = get_cookie_meta(account_id)
    return jsonify({
        "cookies_saved": meta.get("exists", False),
        "cookies_saved_at": meta.get("saved_at"),
        "cookies_count": meta.get("count", 0),
        "has_auth_token": meta.get("has_auth_token", False),
        "has_ct0": meta.get("has_ct0", False),
        "last_tweet_at": acc.get("last_tweet_at"),
        "total_tweets": acc.get("total_tweets", 0),
    })


@app.route("/api/accounts/<account_id>/cookies/import", methods=["POST"])
def api_import_cookies(account_id):
    """ثبت یا پیست مستقیم کوکی‌ها در قالب JSON یا توکن‌ها از طریق داشبورد وب."""
    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"success": False, "error": "اکانت یافت نشد."}), 404

    data = request.get_json(silent=True) or {}
    raw_input = data.get("cookies")
    if not raw_input:
        return jsonify({"success": False, "error": "متن یا داده‌های کوکی خالی است."}), 400

    success, msg = save_cookies_raw(account_id, raw_input)
    if success:
        update_account(account_id, {"cookies_saved": True})
        logger.info(f"کوکی‌ها به صورت دستی برای اکانت {account_id} وارد و ذخیره شدند.")
        return jsonify({"success": True, "message": msg})
    return jsonify({"success": False, "error": msg}), 400


async def _test_account_cookies_async(account_id: str) -> dict:
    """تست اعتبار واقعی کوکی‌ها با مراجعه به x.com/home بدون ارسال توییت."""
    if not cookies_exist(account_id):
        return {"valid": False, "message": "هیچ فایل کوکی برای این اکانت یافت نشد."}

    async with async_playwright() as p:
        try:
            browser, context = await create_browser_context(p, headless=True)
            loaded = await load_cookies(account_id, context)
            if not loaded:
                await browser.close()
                return {"valid": False, "message": "لود کوکی‌ها در مرورگر ناموفق بود."}

            page = await context.new_page()
            await page.goto("https://x.com/home", wait_until="domcontentloaded", timeout=40000)
            await asyncio.sleep(4)

            current_url = page.url.lower()
            await browser.close()

            if "login" in current_url:
                return {"valid": False, "message": "نشست منقضی شده یا لاگین نامعتبر است (صفحه لاگین باز شد)."}
            return {"valid": True, "message": "کوکی‌ها کاملاً معتبر و فعال هستند! اتصال به صفحه اصلی برقرار است."}
        except Exception as e:
            return {"valid": False, "message": f"خطا در بررسی کوکی: {str(e)}"}


@app.route("/api/accounts/<account_id>/cookies/test", methods=["POST"])
def api_test_cookies(account_id):
    """تست اعتبار زنده نشست کوکی‌ها برای اکانت."""
    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"success": False, "message": "اکانت یافت نشد."}), 404

    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(_test_account_cookies_async(account_id))
        status_code = 200 if result.get("valid") else 400
        return jsonify(result), status_code
    finally:
        loop.close()


@app.route("/api/queue/batch", methods=["POST"])
def api_batch_queue():
    """افزودن دسته‌ای چند توییت از یک متن چندخطی به صف اکانت با زمان‌بندی ایمن."""
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    raw_text = data.get("text", "")
    interval_minutes = int(data.get("interval_minutes", 60))

    if not account_id or not raw_text.strip():
        return jsonify({"success": False, "error": "اکانت و متن توییت‌ها الزامی است."}), 400

    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"success": False, "error": "اکانت یافت نشد."}), 404

    lines = [line.strip() for line in raw_text.strip().splitlines() if line.strip()]
    if not lines:
        return jsonify({"success": False, "error": "هیچ سطری برای توییت یافت نشد."}), 400

    added_items = []
    now = datetime.now()
    from datetime import timedelta

    for idx, tweet_line in enumerate(lines):
        if len(tweet_line) > 280:
            continue
        # محاسبه زمان برنامه‌ریزی شده با فاصله انتخابی (حداقل ۶۰ دقیقه ضد بن)
        scheduled_dt = now + timedelta(minutes=idx * max(interval_minutes, 60))
        sched_iso = scheduled_dt.isoformat() if idx > 0 else None
        item = add_to_queue(account_id, tweet_line, sched_iso)
        added_items.append(item)

    logger.info(f"تعداد {len(added_items)} توییت به صورت گروهی برای اکانت {acc.get('name')} به صف اضافه شدند.")
    return jsonify({"success": True, "count": len(added_items), "items": added_items}), 201


@app.route("/api/queue", methods=["GET"])
def api_get_queue():
    """دریافت فهرست صف توییت‌ها (امکان فیلتر با پارامتر account_id)."""
    account_id = request.args.get("account_id")
    queue_list = get_queue(account_id)
    return jsonify(queue_list)


@app.route("/api/queue", methods=["POST"])
def api_add_queue():
    """افزودن توییت به صف ارسال یا زمان‌بندی."""
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    text = data.get("text", "").strip()
    scheduled_at = data.get("scheduled_at")  # ممکن است خالی یا None باشد

    if not account_id or not text:
        return jsonify({"success": False, "error": "انتخاب اکانت و متن توییت الزامی است."}), 400

    if len(text) > 280:
        return jsonify({"success": False, "error": "طول توییت نمی‌تواند بیش از ۲۸۰ کاراکتر باشد."}), 400

    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"success": False, "error": "اکانت مورد نظر معتبر نیست."}), 404

    item = add_to_queue(account_id, text, scheduled_at)
    logger.info(f"توییت جدید برای اکانت {acc.get('name')} به صف افزوده شد.")
    return jsonify({"success": True, "item": item}), 201


@app.route("/api/queue/<tweet_id>", methods=["DELETE"])
def api_delete_queue_item(tweet_id):
    """حذف توییت از صف (تنها در صورتی که هنوز ارسال نشده باشد)."""
    success = delete_from_queue(tweet_id)
    if success:
        return jsonify({"success": True, "message": "توییت از صف حذف گردید."})
    return jsonify({"success": False, "error": "توییت یافت نشد یا در وضعیت pending نیست."}), 400


@app.route("/api/queue/clear-sent", methods=["POST"])
def api_clear_sent_queue():
    """پاکسازی موارد ارسال شده یا خطادار از صف."""
    count = clear_sent()
    return jsonify({"success": True, "cleared_count": count})


@app.route("/api/tweet/now", methods=["POST"])
def api_tweet_now():
    """ارسال فوری توییت خارج از صف معمول با اعمال قوانین ضد بن."""
    data = request.get_json(silent=True) or {}
    account_id = data.get("account_id")
    text = data.get("text", "").strip()

    if not account_id or not text:
        return jsonify({"success": False, "error": "شناسه اکانت و متن الزامی است."}), 400

    if len(text) > 280:
        return jsonify({"success": False, "error": "طول متن بیش از ۲۸۰ کاراکتر است."}), 400

    acc = get_account_by_id(account_id)
    if not acc:
        return jsonify({"success": False, "error": "اکانت یافت نشد."}), 404

    logger.info(f"درخواست ارسال فوری توییت برای اکانت {acc.get('name')} دریافت شد.")
    result = execute_tweet_sync(account_id, text)

    status_code = 200 if result.get("success") else 400
    return jsonify({
        "success": result.get("success", False),
        "error": result.get("error"),
        "screenshot_path": result.get("screenshot_path"),
    }), status_code


@app.route("/api/logs", methods=["GET"])
def api_get_logs():
    """دریافت آخرین ۵۰ لاگ عملیاتی ربات جهت نمایش در داشبورد وب."""
    return jsonify(list(in_memory_logs))


if __name__ == "__main__":
    logger.info("در حال اجرای سرور ربات X روی پورت 5000 با threading=True...")
    app.run(host="0.0.0.0", port=5000, threaded=True, debug=False)
