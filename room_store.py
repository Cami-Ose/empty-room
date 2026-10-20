"""room_store.py — 放空室的句子池

池子存在同目录的 room.json 里：

    {"items": [{"id": "r_1750000000_1a2b", "text": "…", "created_ts": 1750000000, "source": "knock"}]}

source 有三个来路：`knock`（模型现写的）、`seed`（你自己填进 room.json 的）、
`manual`（网页上调 /api/room/say 加的）。

同一件事只说最新的那遍：新句子跟旧的「过于相似」就把旧的顶掉；像到一模一样干脆不收。
"""

import difflib
import json
import os
import random
import string
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOM_FILE = os.path.join(_HERE, "room.json")

MAX_TEXT_CHARS = 200

# 去重的两道闸，两道都要过才算「像」。单看哪一道都会误判：
#   只看二字组 —— 同话题、同句尾而意思差很远的两句也能到 0.25 上下，
#                 而确实该合并的两句可能才 0.35，阈值卡在中间，两边都会切错；
#   只看 difflib —— 阈值放到 0.45 会把一批无关的句子判成一对。
# 先粗筛、再细比才分得开。改这两个数之前，拿自己的句子量一遍。
SIMILAR_BIGRAM = 0.30
SIMILAR_DIFFLIB = 0.60

_lock = threading.RLock()

# 标点不参与比较 —— 不然「今天的云走得很慢」和「今天的云走得慢。」会被当成两句
_PUNCT = set(string.punctuation) | set("。，、！？；：…—～·‘’“”《》〈〉【】〔〕（）「」『』")


def _norm(t):
    s = "".join(str(t or "").split()).lower()
    return "".join(ch for ch in s if ch not in _PUNCT)


def _bigrams(s):
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def _similar(a, b):
    """两句像不像。两道闸都要过 —— 只过一道的都当「不像」，留着。"""
    x, y = _norm(a), _norm(b)
    if not x or not y:
        return False
    if x == y:
        return True
    bx, by = _bigrams(x), _bigrams(y)
    if not bx or not by:
        return False
    if len(bx & by) / len(bx | by) < SIMILAR_BIGRAM:
        return False
    return difflib.SequenceMatcher(None, x, y).ratio() >= SIMILAR_DIFFLIB


def load_room():
    try:
        with open(ROOM_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    return data if isinstance(data, dict) else {}


def save_room(data):
    """原子写：先落 .tmp 再 replace —— 断电或者两个请求撞一起都不会留半截文件。"""
    tmp = ROOM_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, ROOM_FILE)


def _items(data):
    items = data.get("items")
    return items if isinstance(items, list) else []


def _new_id():
    return "r_%d_%04x" % (int(time.time()), random.randint(0, 0xFFFF))


def view(limit=0):
    """按时间正序给一份（前端照这个顺序轮播）。limit>0 时只给最近的那些。"""
    with _lock:
        items = [it for it in _items(load_room()) if isinstance(it, dict) and it.get("text")]
    items.sort(key=lambda it: (int(it.get("created_ts") or 0), str(it.get("id") or "")))
    if limit and limit > 0:
        items = items[-limit:]
    return {"items": [dict(it) for it in items], "count": len(items)}


def room_count():
    with _lock:
        return len([it for it in _items(load_room()) if isinstance(it, dict)])


def recent_texts(n=20):
    """最近 n 句的正文（新→旧）。拿去当提示词里「你已经说过什么」的参考，免得反复说同一件事。"""
    with _lock:
        items = [it for it in _items(load_room()) if isinstance(it, dict)]
    items.sort(key=lambda it: (int(it.get("created_ts") or 0), str(it.get("id") or "")), reverse=True)
    return [str(it.get("text") or "") for it in items[:max(0, int(n))]]


def append_saying(text, source="knock"):
    """往池子里留一句。返回新条目 dict（被顶掉的旧句子放在 item["dropped"] 里）；
    没留成返回 None —— 空句子、或者跟已有的完全一样，都不收。"""
    text = str(text or "").strip()[:MAX_TEXT_CHARS].strip()
    if not text:
        return None
    nt = _norm(text)
    with _lock:
        data = load_room()
        items = _items(data)
        for it in items:
            if _norm(it.get("text")) == nt:
                return None                       # 同一句已经有了
        留下, 顶掉 = [], []
        for it in items:
            if _similar(it.get("text"), text):
                顶掉.append(str(it.get("text") or ""))
            else:
                留下.append(it)
        if 顶掉:
            data["items"] = 留下                   # 同一件事只说最新的那遍
            items = 留下
        item = {
            "id": _new_id(),
            "text": text,
            "created_ts": int(time.time()),
            "source": str(source or "knock"),
        }
        items.append(item)
        save_room(data)
        out = dict(item)
        if 顶掉:
            out["dropped"] = 顶掉
        return out
