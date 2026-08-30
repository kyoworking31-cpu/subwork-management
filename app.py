import csv
import hmac
import os
import sqlite3
import socket
import threading
import time
from datetime import datetime, timedelta, timezone, date
from pathlib import Path

import icalendar
import recurring_ical_events
import requests
from flask import Flask, Response, g, jsonify, request

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "subwork.db"
ARCHIVE_PATH = DATA_DIR / "deleted_archive.csv"

STATUSES = ["応募中", "面談予定", "進行中", "納品・完了"]
PLATFORMS = ["CrowdWorks", "ランサーズ", "ココナラ"]
DONE_STATUS = "納品・完了"
AUTO_DELETE_AFTER_DAYS = 7
CLEANUP_INTERVAL_SECONDS = 6 * 60 * 60  # 6時間ごとに確認

GCAL_URL_SETTING_KEY = "gcal_ics_url"
GCAL_CACHE_TTL_SECONDS = 15 * 60

FIELDS = [
    "platform", "genre", "status", "client_name", "client_contact",
    "applied_date", "interview_at", "due_date", "amount", "memo", "url",
]

app = Flask(__name__, static_folder="static", static_url_path="")

APP_USERNAME = os.environ.get("APP_USERNAME", "")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


@app.before_request
def require_login():
    # APP_PASSWORD が設定されていない場合(ローカル/自宅LAN利用時)は認証をスキップする
    if not APP_PASSWORD:
        return None
    auth = request.authorization
    valid = (
        auth
        and hmac.compare_digest(auth.username or "", APP_USERNAME)
        and hmac.compare_digest(auth.password or "", APP_PASSWORD)
    )
    if not valid:
        return Response(
            "認証が必要です",
            401,
            {"WWW-Authenticate": 'Basic realm="Subwork Board"'},
        )
    return None


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            genre TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT '応募中',
            client_name TEXT,
            client_contact TEXT,
            applied_date TEXT,
            interview_at TEXT,
            due_date TEXT,
            amount INTEGER,
            memo TEXT,
            url TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    conn.commit()
    conn.close()


def get_setting(key, default=None):
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row[0] if row else default
    finally:
        conn.close()


def set_setting(key, value):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row):
    return {key: row[key] for key in row.keys()}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def archive_rows(rows):
    """削除前に案件の内容をCSVへ追記保存する(報酬記録を失わないため)。"""
    is_new_file = not ARCHIVE_PATH.exists()
    deleted_at = now_iso()
    with open(ARCHIVE_PATH, "a", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        if is_new_file:
            writer.writerow(["id"] + FIELDS + ["created_at", "updated_at", "deleted_at"])
        for row in rows:
            writer.writerow(
                [row["id"]] + [row[field] for field in FIELDS]
                + [row["created_at"], row["updated_at"], deleted_at]
            )


def cleanup_old_completed_cards():
    """納品・完了のまま更新がなく一定日数経った案件を、CSVに退避してから削除する。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=AUTO_DELETE_AFTER_DAYS)).isoformat()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT * FROM cards WHERE status = ? AND updated_at < ?",
            (DONE_STATUS, cutoff),
        ).fetchall()
        if not rows:
            return 0
        archive_rows(rows)
        conn.executemany("DELETE FROM cards WHERE id = ?", [(row["id"],) for row in rows])
        conn.commit()
        return len(rows)
    finally:
        conn.close()


def cleanup_loop():
    while True:
        try:
            count = cleanup_old_completed_cards()
            if count:
                print(f"[自動削除] 納品・完了から{AUTO_DELETE_AFTER_DAYS}日経過した案件を{count}件アーカイブして削除しました")
        except Exception as e:
            print(f"[自動削除] エラー: {e}")
        time.sleep(CLEANUP_INTERVAL_SECONDS)


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/api/meta")
def api_meta():
    return jsonify({"statuses": STATUSES, "platforms": PLATFORMS})


@app.route("/api/cards", methods=["GET"])
def list_cards():
    db = get_db()
    rows = db.execute("SELECT * FROM cards ORDER BY created_at ASC").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/api/cards", methods=["POST"])
def create_card():
    data = request.get_json(force=True) or {}

    platform = (data.get("platform") or "").strip()
    genre = (data.get("genre") or "").strip()
    status = (data.get("status") or STATUSES[0]).strip()

    if not platform or not genre:
        return jsonify({"error": "プラットフォームと案件ジャンルは必須です"}), 400
    if status not in STATUSES:
        return jsonify({"error": "不正なステータスです"}), 400

    values = {field: data.get(field) for field in FIELDS}
    values["platform"] = platform
    values["genre"] = genre
    values["status"] = status
    amount = values.get("amount")
    values["amount"] = int(amount) if amount not in (None, "") else None

    ts = now_iso()
    db = get_db()
    cur = db.execute(
        f"""
        INSERT INTO cards ({', '.join(FIELDS)}, created_at, updated_at)
        VALUES ({', '.join('?' for _ in FIELDS)}, ?, ?)
        """,
        [values[f] for f in FIELDS] + [ts, ts],
    )
    db.commit()
    row = db.execute("SELECT * FROM cards WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/api/cards/<int:card_id>", methods=["PUT"])
def update_card(card_id):
    db = get_db()
    existing = db.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if existing is None:
        return jsonify({"error": "案件が見つかりません"}), 404

    data = request.get_json(force=True) or {}

    if "status" in data and data["status"] not in STATUSES:
        return jsonify({"error": "不正なステータスです"}), 400

    updates = {}
    for field in FIELDS:
        if field in data:
            value = data[field]
            if field == "amount":
                value = int(value) if value not in (None, "") else None
            elif isinstance(value, str):
                value = value.strip()
            updates[field] = value

    if "platform" in updates and not updates["platform"]:
        return jsonify({"error": "プラットフォームは必須です"}), 400
    if "genre" in updates and not updates["genre"]:
        return jsonify({"error": "案件ジャンルは必須です"}), 400

    if updates:
        updates["updated_at"] = now_iso()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        db.execute(
            f"UPDATE cards SET {set_clause} WHERE id = ?",
            list(updates.values()) + [card_id],
        )
        db.commit()

    row = db.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    return jsonify(row_to_dict(row))


@app.route("/api/cards/<int:card_id>", methods=["DELETE"])
def delete_card(card_id):
    db = get_db()
    db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
    db.commit()
    return "", 204


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify({"gcal_ics_url": get_setting(GCAL_URL_SETTING_KEY, "") or ""})


@app.route("/api/settings", methods=["POST"])
def update_settings():
    data = request.get_json(force=True) or {}
    if "gcal_ics_url" in data:
        set_setting(GCAL_URL_SETTING_KEY, (data.get("gcal_ics_url") or "").strip())
    return jsonify({"gcal_ics_url": get_setting(GCAL_URL_SETTING_KEY, "") or ""})


_gcal_cache = {"url": None, "fetched_at": 0, "ics_text": None}


def fetch_gcal_ics(url, force=False):
    """GoogleカレンダーのiCal URLを取得する(15分キャッシュ)。失敗時は (キャッシュがあればそれ, エラー文言) を返す。"""
    now = time.time()
    fresh = (
        not force
        and _gcal_cache["url"] == url
        and _gcal_cache["ics_text"] is not None
        and now - _gcal_cache["fetched_at"] < GCAL_CACHE_TTL_SECONDS
    )
    if fresh:
        return _gcal_cache["ics_text"], None
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        _gcal_cache.update(url=url, fetched_at=now, ics_text=resp.text)
        return resp.text, None
    except Exception as e:
        error = f"Googleカレンダーの取得に失敗しました({e})"
        if _gcal_cache["url"] == url and _gcal_cache["ics_text"] is not None:
            return _gcal_cache["ics_text"], error
        return None, error


def parse_date_param(value, fallback):
    if not value:
        return fallback
    try:
        return date.fromisoformat(value)
    except ValueError:
        return fallback


@app.route("/api/calendar/events")
def calendar_events():
    today = date.today()
    start = parse_date_param(request.args.get("start"), today.replace(day=1))
    end = parse_date_param(request.args.get("end"), start + timedelta(days=31))
    force_refresh = request.args.get("refresh") == "1"

    events = []

    db = get_db()
    rows = db.execute(
        "SELECT id, genre, status, platform, interview_at, due_date FROM cards"
    ).fetchall()
    for row in rows:
        if row["interview_at"]:
            try:
                dt = datetime.fromisoformat(row["interview_at"])
            except ValueError:
                dt = None
            if dt and start <= dt.date() < end:
                events.append({
                    "type": "interview",
                    "card_id": row["id"],
                    "title": row["genre"],
                    "date": dt.date().isoformat(),
                    "time": dt.strftime("%H:%M"),
                    "all_day": False,
                })
        if row["due_date"]:
            try:
                d = date.fromisoformat(row["due_date"])
            except ValueError:
                d = None
            if d and start <= d < end:
                events.append({
                    "type": "due",
                    "card_id": row["id"],
                    "title": row["genre"],
                    "date": d.isoformat(),
                    "time": None,
                    "all_day": True,
                })

    gcal_error = None
    ics_url = get_setting(GCAL_URL_SETTING_KEY)
    if ics_url:
        ics_text, gcal_error = fetch_gcal_ics(ics_url, force=force_refresh)
        if ics_text:
            try:
                cal = icalendar.Calendar.from_ical(ics_text)
                occurrences = recurring_ical_events.of(cal).between(start, end)
                for occ in occurrences:
                    dtstart = occ.get("dtstart").dt
                    all_day = not isinstance(dtstart, datetime)
                    if all_day:
                        ev_date = dtstart
                        ev_time = None
                    else:
                        ev_date = dtstart.date()
                        ev_time = dtstart.strftime("%H:%M")
                    events.append({
                        "type": "personal",
                        "card_id": None,
                        "title": str(occ.get("summary", "(無題)")),
                        "date": ev_date.isoformat(),
                        "time": ev_time,
                        "all_day": all_day,
                    })
            except Exception as e:
                gcal_error = f"Googleカレンダーの解析に失敗しました({e})"

    events.sort(key=lambda e: (e["date"], e["time"] or ""))
    return jsonify({"events": events, "gcal_error": gcal_error})


def get_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# init_db()と自動削除スレッドは、ローカルで直接実行した場合(python app.py)だけでなく、
# PythonAnywhere等のWSGI経由でこのモジュールがimportされた場合にも実行されるよう、
# モジュールレベルで呼び出す。
init_db()
threading.Thread(target=cleanup_loop, daemon=True).start()


if __name__ == "__main__":
    ip = get_lan_ip()
    print("=" * 50)
    print(" 副業案件ボード を起動しました")
    print(f"  PCから      : http://localhost:5000")
    print(f"  スマホから  : http://{ip}:5000  (同じWi-Fiに接続時のみ)")
    print(f" 納品・完了から{AUTO_DELETE_AFTER_DAYS}日更新がない案件は自動削除されます(削除前にCSVへ記録)")
    print(" 終了するにはこのウィンドウで Ctrl+C")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5000, debug=False)
