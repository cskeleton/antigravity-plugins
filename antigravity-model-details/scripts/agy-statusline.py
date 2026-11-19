#!/usr/bin/env python3
"""Antigravity CLI (agy) — Enhanced Model Details & Usage Status Line Script (Main Session Only)
Row 1 (left):  responseModel (displayName) · state · cwd
Row 1 (right): context (actual/max & est%) · main-session cache hit% · quota
Row 2:         current turn breakdown (new input + cached + hit% | output [🧠thinking / 💬response])
Row 3:         main-session cumulative tokens (calls) · main-session cache hit% · main-session avg TTFT & E2E TPS
               (Falls back to 2 rows with rotating 💡 Tip before the first model call in a new session)
"""
import sys
import json
import time
import os
import random
import select
import re
import sqlite3
import subprocess
import http.client
import ssl
import unicodedata
from datetime import datetime, timezone

# ── ANSI Colors ────────────────────────────────────────────────────────────────
RESET        = "\033[0m"
BOLD         = "\033[1m"
GRAY         = "\033[90m"
WHITE        = "\033[37m"
GREEN        = "\033[32m"
YELLOW       = "\033[33m"
ORANGE       = "\033[38;5;208m"
LIGHT_ORANGE = "\033[38;5;214m"
RED          = "\033[31m"
MAGENTA      = "\033[35m"
CYAN         = "\033[36m"
BLUE         = "\033[34m"
PURPLE       = "\033[38;5;141m"

TIPS = [
    "Run !agy-stats to view full step-by-step token table & context breakdown.",
    "Use /model-details to generate a complete markdown usage report.",
    "Use /goal for complex, multi-step tasks that need deep focus.",
    "Press Ctrl+O to expand tool output details inline.",
    "Try /grill-me to refine your implementation plan interactively.",
    "Use /agents to see all active sub-agents and their status.",
    "Prefix a message with ! to run it as a shell command directly.",
]

HOME = os.path.expanduser("~")
AGY_CLI_DIR = os.path.join(HOME, ".gemini", "antigravity-cli")
AGY_APP_DIR = os.path.join(HOME, ".gemini", "antigravity")

TIP_CACHE_FILE = "/tmp/agy_status_tip.json"
TIP_MIN_SECONDS = 3.0
QUOTA_CACHE_FILE = os.environ.get(
    "AGY_QUOTA_CACHE",
    os.path.expanduser("~/.antigravity/quota-cache.json"),
)
STATUS_STATE_FILE = os.environ.get(
    "AGY_STATUS_STATE",
    os.path.expanduser("~/.antigravity/status-state.json"),
)
QUOTA_MAX_AGE_SECONDS = float(os.environ.get("AGY_QUOTA_MAX_AGE_SECONDS", "900"))
QUOTA_REFRESH_INTERVAL_SECONDS = float(os.environ.get("AGY_QUOTA_REFRESH_INTERVAL_SECONDS", "30"))
USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus"

# In-memory cache for SQLite stats keyed by (session_id, db_mtime)
_DB_STATS_CACHE = {}


# ── Lightweight Protobuf Wire Decoder for `gen_metadata` ───────────────────────
def _read_varint(buf: bytes, pos: int):
    result = 0
    shift = 0
    n = len(buf)
    while pos < n:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return result, pos
        shift += 7
        if shift > 70:
            break
    raise ValueError("varint")


def _scan_fields(buf: bytes):
    pos = 0
    n = len(buf)
    while pos < n:
        try:
            tag, pos = _read_varint(buf, pos)
        except ValueError:
            break
        field_no = tag >> 3
        wire_type = tag & 7
        if field_no <= 0:
            break
        if wire_type == 0:
            try:
                val, pos = _read_varint(buf, pos)
            except ValueError:
                break
            yield field_no, wire_type, val
        elif wire_type == 1:
            if pos + 8 > n:
                break
            yield field_no, wire_type, buf[pos:pos + 8]
            pos += 8
        elif wire_type == 2:
            try:
                length, pos = _read_varint(buf, pos)
            except ValueError:
                break
            if length < 0 or pos + length > n:
                break
            yield field_no, wire_type, buf[pos:pos + length]
            pos += length
        elif wire_type == 5:
            if pos + 4 > n:
                break
            yield field_no, wire_type, buf[pos:pos + 4]
            pos += 4
        else:
            break


def _decode_usage(buf: bytes) -> dict:
    u = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, "think": 0, "resp": 0}
    has_resp = False
    for f, wt, v in _scan_fields(buf):
        if wt == 0:
            if f == 2:
                u["in"] = int(v)
            elif f == 3:
                u["out"] = int(v)
            elif f == 4:
                u["cache_write"] = int(v)
            elif f == 5:
                u["cache_read"] = int(v)
            elif f == 9:
                u["think"] = int(v)
            elif f == 10:
                u["resp"] = int(v)
                has_resp = True
    if not has_resp:
        u["resp"] = max(0, u["out"] - u["think"])
    return u


def _decode_duration(buf: bytes) -> float:
    secs = 0
    nanos = 0
    for f, wt, v in _scan_fields(buf):
        if wt == 0:
            if f == 1:
                secs = int(v)
                if secs >= (1 << 63):
                    secs -= (1 << 64)
            elif f == 2:
                nanos = int(v)
                if nanos >= (1 << 31):
                    nanos -= (1 << 32)
    return float(secs) + float(nanos) / 1e9


def _decode_gen_metadata_blob(blob: bytes) -> dict:
    step_indices = []
    chat_model = None
    exec_id = ""
    for f, wt, v in _scan_fields(blob):
        if wt == 2 and f == 1:
            cm = {
                "usage": {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0, "think": 0, "resp": 0},
                "est_ctx": 0,
                "max_ctx": 0,
                "response_model": "",
                "display_name": "",
                "ttft": None,
                "streaming": None,
            }
            for cf, cwt, cv in _scan_fields(v):
                if cwt == 2 and cf == 4:
                    cm["usage"] = _decode_usage(cv)
                elif cwt == 2 and cf == 9:
                    for sf, swt, sv in _scan_fields(cv):
                        if swt == 2 and sf == 10:
                            for xf, xwt, xv in _scan_fields(sv):
                                if xwt == 0 and xf == 1:
                                    cm["est_ctx"] = int(xv)
                                elif xwt == 0 and xf == 4:
                                    cm["max_ctx"] = int(xv)
                elif cwt == 2 and cf == 11:
                    cm["ttft"] = _decode_duration(cv)
                elif cwt == 2 and cf == 12:
                    cm["streaming"] = _decode_duration(cv)
                elif cwt == 2 and cf == 19:
                    cm["response_model"] = cv.decode("utf-8", "replace")
                elif cwt == 2 and cf == 21:
                    cm["display_name"] = cv.decode("utf-8", "replace")
            chat_model = cm
        elif wt == 0 and f == 2:
            step_indices.append(int(v))
        elif wt == 2 and f == 2:
            pos = 0
            while pos < len(v):
                try:
                    s_idx, pos = _read_varint(v, pos)
                    step_indices.append(int(s_idx))
                except ValueError:
                    break
        elif wt == 2 and f == 4:
            exec_id = v.decode("utf-8", "replace")
    return {"steps": step_indices, "cm": chat_model, "exec_id": exec_id}


def _find_conv_db(conv_id: str) -> str:
    for base in (AGY_CLI_DIR, AGY_APP_DIR):
        p = os.path.join(base, "conversations", f"{conv_id}.db")
        if os.path.exists(p):
            return p
    return ""


def _analyze_single_db(conv_id: str) -> dict:
    db_path = _find_conv_db(conv_id)
    if not db_path:
        return None
    try:
        wal_path = db_path + "-wal"
        mtime = os.path.getmtime(wal_path) if os.path.exists(wal_path) else os.path.getmtime(db_path)
    except Exception:
        mtime = 0

    cached = _DB_STATS_CACHE.get(conv_id)
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.5)
        user_steps = [r[0] for r in conn.execute("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC").fetchall()]
        gen_rows = conn.execute("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").fetchall()
        conn.close()
    except Exception:
        return None

    tot = {
        "calls": 0, "in": 0, "cache_read": 0, "cache_write": 0,
        "out": 0, "think": 0, "resp": 0, "total": 0,
        "ttft_calls": 0, "ttft_sum": 0.0, "timed_out": 0, "timed_sec": 0.0,
    }
    last_user_step = user_steps[-1] if user_steps else 0
    turn_num = max(1, len(user_steps))
    latest_turn = {"turn": turn_num, "calls": 0, "in": 0, "cache_read": 0, "cache_write": 0, "out": 0, "think": 0, "resp": 0, "total": 0}

    last_cm = None
    for _, blob in gen_rows:
        if not blob:
            continue
        item = _decode_gen_metadata_blob(blob)
        cm = item["cm"]
        if not cm:
            continue
        u = cm["usage"]
        c_in = u["in"]
        c_cr = u["cache_read"]
        c_cw = u["cache_write"]
        c_out = u["out"]
        c_tot = c_in + c_cr + c_cw + c_out
        first_step = item["steps"][0] if item["steps"] else 0

        tot["calls"] += 1
        tot["in"] += c_in
        tot["cache_read"] += c_cr
        tot["cache_write"] += c_cw
        tot["out"] += c_out
        tot["think"] += u["think"]
        tot["resp"] += u["resp"]
        tot["total"] += c_tot

        ttft_val = cm.get("ttft")
        stream_val = cm.get("streaming")
        if ttft_val is not None:
            tot["ttft_calls"] += 1
            tot["ttft_sum"] += ttft_val
        if ttft_val is not None or stream_val is not None:
            e2e_sec = (ttft_val or 0.0) + (stream_val or 0.0)
            if e2e_sec > 0.2 and c_out > 0:
                tot["timed_out"] += c_out
                tot["timed_sec"] += e2e_sec

        if first_step >= last_user_step:
            latest_turn["calls"] += 1
            latest_turn["in"] += c_in
            latest_turn["cache_read"] += c_cr
            latest_turn["cache_write"] += c_cw
            latest_turn["out"] += c_out
            latest_turn["think"] += u["think"]
            latest_turn["resp"] += u["resp"]
            latest_turn["total"] += c_tot

        if cm["max_ctx"] > 0 or c_tot > 0:
            last_cm = cm

    result = {
        "tot": tot,
        "latest_turn": latest_turn if latest_turn["calls"] > 0 else None,
        "last_cm": last_cm,
    }
    _DB_STATS_CACHE[conv_id] = (mtime, result)
    return result


def get_rich_session_stats(conv_id: str) -> dict:
    if not conv_id:
        return None
    main = _analyze_single_db(conv_id)
    if not main or main["tot"]["calls"] == 0:
        return None

    mt = main["tot"]
    main_in_total = mt["in"] + mt["cache_read"] + mt["cache_write"]
    main_hit_pct = (mt["cache_read"] / main_in_total * 100.0) if main_in_total > 0 else 0.0
    avg_ttft = (mt["ttft_sum"] / mt["ttft_calls"]) if mt["ttft_calls"] > 0 else None
    avg_e2e_tps = (mt["timed_out"] / mt["timed_sec"]) if (mt["timed_sec"] > 0.2 and mt["timed_out"] > 0) else None

    return {
        "main": main,
        "main_in_total": main_in_total,
        "main_hit_pct": main_hit_pct,
        "avg_ttft": avg_ttft,
        "avg_e2e_tps": avg_e2e_tps,
    }


# ── Helpers & Quota Logic ──────────────────────────────────────────────────────
def format_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def context_color_used(used_pct: float) -> str:
    # Aligned with Antigravity auto-compaction (~95%-100% of max_ctx)
    if used_pct >= 92:
        return RED
    elif used_pct >= 80:
        return ORANGE
    return GREEN


def normalize_model_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def quota_color(pct: float) -> str:
    if pct >= 50:
        return PURPLE
    if pct >= 20:
        return LIGHT_ORANGE
    return RED


def format_reset_time(reset_time: str) -> str:
    try:
        reset = datetime.fromisoformat(reset_time.replace("Z", "+00:00"))
        diff = int((reset - datetime.now(timezone.utc)).total_seconds())
    except Exception:
        return ""
    if diff <= 0:
        return "now"
    minutes = (diff + 59) // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, mins = divmod(minutes, 60)
    if hours >= 24:
        days, rem_hours = divmod(hours, 24)
        return f"{days}d {rem_hours}h" if rem_hours else f"{days}d"
    return f"{hours}h {mins}m" if mins else f"{hours}h"


def extract_arg(command_line: str, name: str) -> str:
    match = re.search(rf"{re.escape(name)}(?:=|\s+)([^\s\"']+|\"[^\"]+\"|'[^']+')", command_line)
    if not match:
        return ""
    return match.group(1).strip("\"'")


def find_server_candidates() -> list[dict]:
    try:
        ps = subprocess.check_output(["ps", "auxww"], text=True, timeout=1.5)
    except Exception:
        return []
    candidates = []
    for line in ps.splitlines():
        lower = line.lower()
        is_cli = re.search(r"\bagy(\s|$)", line) is not None
        is_language_server = "language_server" in lower
        if not is_cli and not is_language_server:
            continue
        parts = line.split(None, 10)
        if len(parts) < 11:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        token = extract_arg(parts[10], "--csrf_token")
        score = 10 + (40 if is_cli else 0) + (20 if is_language_server else 0) + (10 if token else 0)
        if "/applications/antigravity.app" in lower:
            score -= 10
        candidates.append({
            "pid": pid,
            "csrf_token": token,
            "score": score,
            "kind": "cli" if is_cli else "language_server",
        })
    return sorted(candidates, key=lambda x: x["score"], reverse=True)


def get_listening_ports(pid: int) -> list[int]:
    try:
        out = subprocess.check_output(
            ["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN"],
            text=True,
            timeout=1.5,
        )
    except Exception:
        return []
    ports = []
    for match in re.finditer(r":(\d+)\s+\(LISTEN\)", out):
        port = int(match.group(1))
        if port not in ports:
            ports.append(port)
    return sorted(ports)


def request_user_status(port: int, csrf_token: str, use_https: bool) -> dict:
    body = json.dumps({
        "metadata": {
            "ideName": "antigravity",
            "extensionName": "antigravity",
            "locale": "en",
        }
    })
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
    }
    if csrf_token:
        headers["X-Codeium-Csrf-Token"] = csrf_token
    if use_https:
        conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=1.5, context=ssl._create_unverified_context())
    else:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.5)
    conn.request("POST", USER_STATUS_PATH, body, headers)
    res = conn.getresponse()
    raw = res.read().decode("utf-8", "replace")
    if res.status < 200 or res.status >= 300:
        raise RuntimeError(f"HTTP {res.status}")
    return json.loads(raw)


def parse_user_status_quota(response: dict) -> dict:
    user_status = response.get("userStatus", {})
    plan_info = user_status.get("planStatus", {}).get("planInfo", {})
    cascade = user_status.get("cascadeModelConfigData", {})
    models = {}
    for model in cascade.get("clientModelConfigs", []) or []:
        quota_info = model.get("quotaInfo") or {}
        if "remainingFraction" not in quota_info:
            continue
        label = model.get("label") or model.get("modelOrAlias", {}).get("model") or "Unknown"
        remaining = max(0.0, min(100.0, float(quota_info.get("remainingFraction", 0)) * 100))
        entry = {
            "name": label,
            "remaining_percentage": remaining,
            "source": "local_language_server",
        }
        reset_time = quota_info.get("resetTime")
        if reset_time:
            entry["reset_time"] = reset_time
            entry["refreshes_in"] = format_reset_time(reset_time)
        models[normalize_model_name(label)] = entry
    return {
        "timestamp": time.time(),
        "source": "local_language_server",
        "scope": {
            "email": user_status.get("email") or "",
            "plan_tier": plan_info.get("planName") or "",
        },
        "models": models,
    }


def fetch_live_quota_cache(expected_email: str = "") -> dict:
    fallback = {}
    expected = (expected_email or "").lower()
    for process_info in find_server_candidates():
        for port in get_listening_ports(process_info["pid"]):
            for use_https in (True, False):
                try:
                    response = request_user_status(port, process_info.get("csrf_token", ""), use_https)
                    cache = parse_user_status_quota(response)
                    if not cache.get("models"):
                        continue
                    email = str(cache.get("scope", {}).get("email", "")).lower()
                    if expected and email == expected:
                        return cache
                    if not fallback:
                        fallback = cache
                except Exception:
                    continue
    return fallback


def read_json_file(path: str) -> dict:
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_quota_cache(cache: dict) -> None:
    try:
        os.makedirs(os.path.dirname(QUOTA_CACHE_FILE), exist_ok=True)
        with open(QUOTA_CACHE_FILE, "w") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
    except Exception:
        pass


def write_status_state(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATUS_STATE_FILE), exist_ok=True)
        state = {
            "email": data.get("email") or "",
            "plan_tier": data.get("plan_tier") or "",
            "session_id": data.get("conversation_id") or data.get("session_id") or "",
            "timestamp": time.time(),
        }
        model_info = data.get("model", {})
        state["model"] = (
            model_info.get("display_name") or model_info.get("id") or ""
            if isinstance(model_info, dict)
            else str(model_info or "")
        )
        with open(STATUS_STATE_FILE, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
    except Exception:
        pass


def load_quota_for_model(model_name: str, data: dict) -> dict:
    cache = read_json_file(QUOTA_CACHE_FILE)
    now = time.time()
    ts = float(cache.get("timestamp", 0) or 0) if cache else 0
    if not cache or (now - ts >= QUOTA_REFRESH_INTERVAL_SECONDS):
        live = fetch_live_quota_cache(data.get("email") or "")
        if live:
            cache = live
            write_quota_cache(cache)
    if not cache:
        return {}
    models = cache.get("models", {})
    if not isinstance(models, dict):
        return {}
    wanted = normalize_model_name(model_name)
    if wanted in models:
        return models[wanted]
    for key, value in models.items():
        key_norm = normalize_model_name(key)
        if key_norm and (key_norm in wanted or wanted in key_norm):
            return value
    return {}


def get_tip() -> str:
    now = time.time()
    tip = ""
    ts = 0.0
    try:
        with open(TIP_CACHE_FILE, "r") as f:
            cache = json.load(f)
        tip = cache.get("tip", "")
        ts = float(cache.get("timestamp", 0))
    except Exception:
        pass
    if tip and (now - ts) < TIP_MIN_SECONDS:
        return tip
    choices = [t for t in TIPS if t != tip] or TIPS
    new_tip = random.choice(choices)
    try:
        with open(TIP_CACHE_FILE, "w") as f:
            json.dump({"tip": new_tip, "timestamp": now}, f)
    except Exception:
        pass
    return new_tip


# ── Rendering ──────────────────────────────────────────────────────────────────
SEP = f" {GRAY}│{RESET} "
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def vis_width(text: str) -> int:
    plain = ANSI_RE.sub("", text)
    width = 0
    for ch in plain:
        if unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def get_terminal_width(data: dict) -> int:
    for key in ("terminal_width", "width", "columns"):
        val = data.get(key)
        if isinstance(val, (int, float)) and val >= 40:
            return int(val)
    term = data.get("terminal")
    if isinstance(term, dict):
        val = term.get("width") or term.get("columns")
        if isinstance(val, (int, float)) and val >= 40:
            return int(val)
    env_cols = os.environ.get("COLUMNS", "")
    if env_cols.isdigit() and int(env_cols) >= 40:
        return int(env_cols)
    for fd in (1, 2):
        try:
            cols = os.get_terminal_size(fd).columns
            if cols >= 40:
                return cols
        except OSError:
            pass
    try:
        with open("/dev/tty", "rb") as tty:
            cols = os.get_terminal_size(tty.fileno()).columns
            if cols >= 40:
                return cols
    except OSError:
        pass
    return 0


def cache_hit_color(hit_pct: float) -> str:
    if hit_pct >= 75:
        return GREEN
    if hit_pct >= 40:
        return YELLOW
    return ORANGE


def render(data: dict) -> str:
    conv_id = data.get("conversation_id") or data.get("session_id") or ""
    rich = get_rich_session_stats(conv_id)

    # 1. Model Identity (Returned responseModel ID + Display Name)
    model_info = data.get("model", {})
    raw_name = (
        model_info.get("display_name") or model_info.get("id") or "AGY"
        if isinstance(model_info, dict)
        else str(model_info or "AGY")
    )
    last_cm = rich["main"]["last_cm"] if rich else None
    resp_model = last_cm.get("response_model") if last_cm else ""
    if resp_model and resp_model.lower() not in raw_name.lower():
        model_display = f"{YELLOW}{BOLD}{resp_model}{RESET} {GRAY}({raw_name}){RESET}"
    elif resp_model:
        model_display = f"{YELLOW}{BOLD}{resp_model}{RESET}"
    else:
        model_display = f"{YELLOW}{BOLD}{raw_name}{RESET}"

    # 2. Agent State
    state = data.get("agent_state", "idle")
    state_colors = {"working": CYAN, "idle": GRAY, "waiting": LIGHT_ORANGE, "error": RED}
    sc = state_colors.get(state, WHITE)
    state_display = f"{sc}{state.capitalize()}{RESET}"

    # 3. Context Window (Actual vs Max & Estimated%)
    cw = data.get("context_window", {})
    if last_cm and last_cm.get("max_ctx", 0) > 0:
        u = last_cm["usage"]
        actual_ctx = u["in"] + u["cache_read"] + u["cache_write"]
        max_ctx = last_cm["max_ctx"]
        est_ctx = last_cm.get("est_ctx", 0)
        act_pct = (actual_ctx / max_ctx) * 100.0
        est_pct = (est_ctx / max_ctx) * 100.0
        cc = context_color_used(max(act_pct, est_pct))
        ctx_display = (
            f"{cc}Ctx {format_tokens(actual_ctx)}/{format_tokens(max_ctx)} ({act_pct:.0f}%){RESET}"
            f"{GRAY}·估{est_pct:.0f}%{RESET}"
        )
    else:
        rem_pct = float(cw.get("remaining_percentage", 100.0))
        used_pct = max(0.0, 100.0 - rem_pct)
        cc = context_color_used(used_pct)
        ctx_display = f"{cc}Ctx {rem_pct:.0f}% left{RESET}"

    # 4. Working directory & sandbox
    cwd = data.get("cwd", "")
    if cwd.startswith(HOME):
        cwd = "~" + cwd[len(HOME):]
    sandbox_enabled = data.get("sandbox", {}).get("enabled", False)
    sandbox_str = f" {ORANGE}[sandbox]{RESET}" if sandbox_enabled else ""
    path_display = f"{GREEN}{cwd}{RESET}{sandbox_str}"

    # 5. Main-session cumulative cache hit rate
    hit_display = ""
    if rich and rich["main_in_total"] > 0:
        main_hit_pct = rich["main_hit_pct"]
        hc = cache_hit_color(main_hit_pct)
        hit_display = f"{hc}⚡Hit {main_hit_pct:.0f}%{RESET}"

    # 6. Quota
    quota = load_quota_for_model(raw_name, data)
    if "remaining_percentage" in quota:
        quota_pct = float(quota["remaining_percentage"])
        qc = quota_color(quota_pct)
        reset_in = quota.get("refreshes_in") or ""
        reset_display = f"{GRAY}·{reset_in}{RESET}" if reset_in else ""
        quota_display = f"{qc}⬡ {quota_pct:.0f}%{RESET}{reset_display}"
    else:
        quota_display = f"{GRAY}⬡ Quota: /usage{RESET}"

    # Row 1: Left (Model · State · Path) + Right-aligned (Ctx · Main Hit% · Quota)
    row1_left = f"{model_display}{SEP}{state_display}{SEP}{path_display}"
    right_parts = [ctx_display]
    if hit_display:
        right_parts.append(hit_display)
    right_parts.append(quota_display)
    row1_right = SEP.join(right_parts)

    term_width = get_terminal_width(data)
    try:
        margin = int(os.environ.get("AGY_STATUS_WIDTH_MARGIN", "2"))
    except ValueError:
        margin = 2
    usable_width = max(0, term_width - margin) if term_width > 0 else 0
    gap = usable_width - vis_width(row1_left) - vis_width(row1_right)
    if usable_width > 0 and gap >= 2:
        row1 = f"{row1_left}{' ' * gap}{row1_right}"
    else:
        row1 = f"{row1_left}{SEP}{row1_right}"

    # Row 2 & Row 3: Main-session latest turn breakdown & main-session cumulative totals
    if rich and rich["main"]["latest_turn"]:
        lt = rich["main"]["latest_turn"]
        tot_in = lt["in"] + lt["cache_read"] + lt["cache_write"]
        turn_hit_pct = (lt["cache_read"] / tot_in * 100.0) if tot_in > 0 else 0.0
        turn_hc = cache_hit_color(turn_hit_pct)
        cw_str = f" {GRAY}+ 写{RESET} {WHITE}{format_tokens(lt['cache_write'])}{RESET}" if lt["cache_write"] > 0 else ""
        row2 = (
            f"{CYAN}本条#{lt['turn']}({lt['calls']}次){RESET}: "
            f"{GRAY}新增{RESET} {WHITE}{format_tokens(lt['in'])}{RESET} "
            f"{GRAY}+ 缓存{RESET} {GREEN}{format_tokens(lt['cache_read'])}{RESET}{cw_str} "
            f"{turn_hc}(命中{turn_hit_pct:.0f}%){RESET}"
            f"{SEP}"
            f"{GRAY}输出{RESET} {WHITE}{format_tokens(lt['out'])}{RESET} "
            f"{GRAY}(🧠{format_tokens(lt['think'])} / 💬{format_tokens(lt['resp'])}){RESET}"
        )

        mt = rich["main"]["tot"]
        row3_parts = [
            f"Σ 会话累计: {BOLD}{WHITE}{format_tokens(mt['total'])}{RESET} {GRAY}({mt['calls']}次调用){RESET}"
        ]
        if hit_display:
            row3_parts.append(hit_display)
        perf_items = []
        if rich.get("avg_ttft") is not None:
            perf_items.append(f"TTFT {CYAN}{rich['avg_ttft']:.1f}s{RESET}")
        if rich.get("avg_e2e_tps") is not None:
            perf_items.append(f"E2E {GREEN}{rich['avg_e2e_tps']:.1f}t/s{RESET}")
        if perf_items:
            row3_parts.append(" · ".join(perf_items))
        row3 = SEP.join(row3_parts)

        return f"{row1}\n{row2}\n{row3}"

    tip = get_tip()
    row2 = f"{BLUE}💡 {tip}{RESET}"
    return f"{row1}\n{row2}"


def main():
    decoder = json.JSONDecoder()
    buffer = ""
    last_data = None

    while True:
        try:
            r, _, _ = select.select([sys.stdin], [], [], 1.0)
            if r:
                chunk = sys.stdin.read(1)
                if not chunk:
                    break
                buffer += chunk
                if chunk == "}":
                    while buffer:
                        stripped = buffer.lstrip()
                        if not stripped:
                            buffer = ""
                            break
                        try:
                            data, idx = decoder.raw_decode(stripped)
                            buffer = stripped[idx:]
                            if isinstance(data, dict) and "model" in data:
                                write_status_state(data)
                                last_data = data
                                print(render(last_data), flush=True)
                        except json.JSONDecodeError:
                            break
            elif last_data:
                print(render(last_data), flush=True)
        except EOFError:
            break
        except Exception:
            time.sleep(0.05)


if __name__ == "__main__":
    main()
