"""server.py — 放空室

零依赖，只用 Python 标准库。`python3 server.py` 就跑起来，然后开 http://127.0.0.1:8765。

它做三件事：
  · 把页面发给浏览器（static/ 下那两个文件）
  · 让模型写一句新的（配了 llm 时）
  · 把句子合成语音（配了 tts 时）

配置读同目录的 config.json（照 config.example.json 抄一份、改成 config.json）。
环境变量优先，方便部署：ROOM_PORT / ROOM_HOST / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL /
TTS_BASE_URL / TTS_API_KEY / TTS_MODEL / TTS_VOICE / TTS_FORMAT。
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import prompts
import room_store

_HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(_HERE, "static")
CONFIG_FILE = os.path.join(_HERE, "config.json")

DEFAULT_PORT = 8765
LLM_TIMEOUT = 60
TTS_TIMEOUT = 60
MAX_BODY = 64 * 1024          # 请求体上限：手滑灌进来一整本书也别把服务拖住


def _env(*names):
    for n in names:
        v = os.environ.get(n)
        if v:
            return v.strip()
    return ""


def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}

    def 段(name):
        v = cfg.get(name)
        return v if isinstance(v, dict) else {}

    llm, tts = 段("llm"), 段("tts")
    return {
        "host": _env("ROOM_HOST") or str(cfg.get("host") or "127.0.0.1"),
        "port": int(_env("ROOM_PORT") or cfg.get("port") or DEFAULT_PORT),
        "llm": {
            "base_url": (_env("LLM_BASE_URL") or str(llm.get("base_url") or "")).rstrip("/"),
            "api_key": _env("LLM_API_KEY") or str(llm.get("api_key") or ""),
            "model": _env("LLM_MODEL") or str(llm.get("model") or ""),
        },
        "tts": {
            "base_url": (_env("TTS_BASE_URL") or str(tts.get("base_url") or "")).rstrip("/"),
            "api_key": _env("TTS_API_KEY") or str(tts.get("api_key") or ""),
            "model": _env("TTS_MODEL") or str(tts.get("model") or "tts-1"),
            "voice": _env("TTS_VOICE") or str(tts.get("voice") or "alloy"),
            "format": _env("TTS_FORMAT") or str(tts.get("format") or "mp3"),
        },
    }


CONFIG = load_config()


def _llm_ready():
    llm = CONFIG["llm"]
    return bool(llm["base_url"] and llm["api_key"] and llm["model"])


def _tts_ready():
    """语音这头：base_url / api_key 缺了就借 llm 的 —— 同一个站既给模型又给语音是很常见的配法。"""
    tts = CONFIG["tts"]
    base = tts["base_url"] or CONFIG["llm"]["base_url"]
    key = tts["api_key"] or CONFIG["llm"]["api_key"]
    return bool(base and key), base, key


def _post_json(url, payload, key, timeout):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _parse_say(text):
    """从模型输出里抠出那一句。它有时候会裹一层 ```json 或者多说两句，宽容点 ——
    抠不出 JSON 就把整段当句子，别因为格式白跑一趟（钱已经花了）。"""
    s = str(text or "").strip()
    if s.startswith("```"):
        s = s.strip("`").strip()
        if s[:4].lower() == "json":
            s = s[4:].strip()
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i:j + 1])
            if isinstance(obj, dict):
                return str(obj.get("say") or "").strip()
        except ValueError:
            pass
    s = s.strip().strip('"“”').splitlines()[0].strip() if s else ""
    return s[:room_store.MAX_TEXT_CHARS]


def ask_model(minutes=0):
    """问一次模型「现在要不要留一句」。返回 (那一句, 说明)；失败就是 ("", 为什么)。"""
    if not _llm_ready():
        return "", "没配模型（config.json 里的 llm）"
    llm = CONFIG["llm"]
    user = prompts.build_knock_prompt(minutes, room_store.recent_texts(20))
    try:
        raw = _post_json(
            llm["base_url"] + "/chat/completions",
            {
                "model": llm["model"],
                "messages": [
                    {"role": "system", "content": prompts.KNOCK_SYSTEM},
                    {"role": "user", "content": user},
                ],
                "max_tokens": 300,
            },
            llm["api_key"], LLM_TIMEOUT,
        )
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        return "", "模型接口 %s：%s" % (e.code, detail)
    except Exception as e:
        return "", "调模型失败：%s" % e
    try:
        obj = json.loads(raw.decode("utf-8"))
        content = obj["choices"][0]["message"]["content"]
    except Exception as e:
        return "", "模型返回看不懂：%s" % e
    return _parse_say(content), ""


def tts_audio(text):
    """要一段音频。返回 (音频字节, 说明)；没配就是 (None, 为什么)。"""
    ok, base, key = _tts_ready()
    if not ok:
        return None, "没配语音（config.json 里的 tts）"
    tts = CONFIG["tts"]
    try:
        return _post_json(
            base + "/audio/speech",
            {"model": tts["model"], "input": text, "voice": tts["voice"],
             "response_format": tts["format"]},
            key, TTS_TIMEOUT,
        ), ""
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        return None, "语音接口 %s：%s" % (e.code, detail)
    except Exception as e:
        return None, "调语音失败：%s" % e


class Handler(BaseHTTPRequestHandler):
    server_version = "empty-room"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- 小工具 ----------

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._json({"error": "not found"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return {}
        try:
            obj = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}
        return obj if isinstance(obj, dict) else {}

    # ---------- 路由 ----------

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            return self._file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
        if path == "/room.js":
            return self._file(os.path.join(STATIC_DIR, "room.js"), "text/javascript; charset=utf-8")
        if path == "/api/room":
            return self._json(room_store.view())
        if path == "/api/config":
            # 前端靠这个决定要不要出声：没配语音就整段不念，界面上一个字都不多
            return self._json({
                "tts": _tts_ready()[0],
                "llm": _llm_ready(),
                "count": room_store.room_count(),
            })
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]

        if path == "/api/room/knock":
            body = self._body()
            try:
                minutes = max(0, int(body.get("minutes") or 0))
            except (TypeError, ValueError):
                minutes = 0
            say, why = ask_model(minutes)
            item = None
            if say:
                try:
                    item = room_store.append_saying(say, source="knock")
                except Exception as e:
                    return self._json({"ok": True, "said": False, "error": str(e)})
            return self._json({"ok": True, "said": item is not None,
                               "text": (item or {}).get("text") or "",
                               "why": why, "id": (item or {}).get("id")})

        if path == "/api/room/say":
            body = self._body()
            try:
                item = room_store.append_saying(body.get("text"), source="manual")
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
            return self._json({"ok": item is not None, "text": (item or {}).get("text") or ""})

        if path == "/tts":
            text = str(self._body().get("text") or "").strip()
            if not text:
                return self._json({"error": "empty text"}, 400)
            audio, err = tts_audio(text[:600])
            if not audio:
                return self._json({"error": err}, 503)
            fmt = CONFIG["tts"]["format"].lower()
            ctype = {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg",
                     "aac": "audio/aac", "flac": "audio/flac"}.get(fmt, "audio/mpeg")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(audio)
            return

        return self._json({"error": "not found"}, 404)


def main():
    host, port = CONFIG["host"], CONFIG["port"]
    print("放空室 · http://%s:%d" % (host, port))
    print("  屋里 %d 句" % room_store.room_count())
    print("  写新句子：%s" % ("配好了" if _llm_ready() else "没配 —— 只会轮播已有的句子"))
    print("  念出来：  %s" % ("配好了" if _tts_ready()[0] else "没配 —— 页面不出声"))
    srv = ThreadingHTTPServer((host, port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n关了。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
