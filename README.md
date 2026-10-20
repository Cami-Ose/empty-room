# 放空室

全黑页面上一次显示一句话。句子按字数停留 2~6 秒，淡出后换下一句。

句子有两个来源：填在 `room.json` 里的，和模型现写的。配好语音接口后，每三分钟挑一句念出来。

后端为单文件 Python，只用标准库；前端为两个静态文件，无构建步骤，无外部资源。

## 功能

- **轮播** —— 一次一句，按字数停留 2~6 秒；淡入 1.2 秒，淡出后黑场约 0.4 秒
- **句子来源** —— 手工填写（`room.json`，或 `POST /api/room/say`），或由模型现写（`POST /api/room/knock`）
- **去重** —— 新句子与已有句子过于相似时顶掉旧的，完全相同时不收
- **语音（可选）** —— 每三分钟挑一句念出来，同时把这一句显示到屏幕上
- **零依赖** —— 后端只用 Python 标准库，前端不加载 CDN、webfont 或框架
- **降级** —— 未配置模型时轮播已有句子；未配置语音时只有画面

## 运行

需要 Python 3.9 以上。

### 1. 配置

```bash
cp config.example.json config.json
```

打开 `config.json` 填写 `llm` 一节。`base_url` 填到 `/v1` 一层，脚本自己接 `/chat/completions`。

### 2. 启动

```bash
python3 server.py
```

打开 http://127.0.0.1:8765。

`room.json` 内带九句示例，填 key 之前即可先看效果。

## 配置

| 字段 | 说明 |
|---|---|
| `host` / `port` | 监听地址，默认 `127.0.0.1:8765`。局域网内其他设备要访问，`host` 改为 `0.0.0.0` |
| `llm.base_url` | 模型接口地址，OpenAI 兼容 |
| `llm.api_key` | 你的 key |
| `llm.model` | 模型名 |
| `tts.base_url` / `tts.api_key` | 留空时沿用 `llm` 的值 |
| `tts.model` / `tts.voice` / `tts.format` | 语音接口的模型、音色、音频格式 |

环境变量优先级高于 `config.json`：`ROOM_HOST` `ROOM_PORT` `LLM_BASE_URL` `LLM_API_KEY`
`LLM_MODEL` `TTS_BASE_URL` `TTS_API_KEY` `TTS_MODEL` `TTS_VOICE` `TTS_FORMAT`。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 页面 |
| GET | `/room.js` | 页面脚本 |
| GET | `/api/room` | 句子池全量（按时间正序） |
| GET | `/api/config` | 语音与模型是否已配置、池内句数 |
| POST | `/api/room/knock` | 让模型决定是否写一句。body `{minutes}` |
| POST | `/api/room/say` | 手工加一句。body `{text}` |
| POST | `/tts` | 合成一段语音。body `{text}`，返回音频 |

`/api/room/knock` 返回 `{ok, said, text, why, id}`。`said: false` 表示模型这次没写，属于正常结果。

## 敲门节奏

在前端 `static/room.js`：屋里少于 12 句时每 100 秒一次（最多连敲 12 次），攒够后改为每 4 分钟一次；
连续多次没写成时，同样回到 4 分钟一次。

## 提示词

在 `prompts.py`，里面没有人物设定。屋里说话的是谁、进来的是谁，由使用者决定：
改 `ROOM_RULES` 的措辞，或者在 `KNOCK_SYSTEM` 前面接一段人设。

## 语音

走 OpenAI 兼容的 `POST {base_url}/audio/speech`。

- 未配置时页面只有画面。
- 配置后每三分钟挑一句念出来，同时把这一句显示到屏幕上，声音与画面是同一句。
  该句停留时长按音频长度计算。
- 音量从 0 淡入到 0.55（2 秒），末尾 1.5 秒淡出。
- 首次朗读在进入页面三分钟后。

## 目录

```
server.py             HTTP 服务（标准库）+ 调模型 + 转发语音
prompts.py            提示词（没有人物设定）
room_store.py         句子池 + 去重
room.json             句子池本体（运行时会被改写）
config.example.json   配置模板
static/index.html     页面（CSS 全在里面）
static/room.js        轮播 + 敲门 + 语音
check-clean.mjs       脱敏自查：发布前确认文件内无残留个人信息
README.md             本文件
LICENSE               MIT 许可证
NOTICE                第三方与服务说明
```

## 注意事项

- **`room.json` 会被改写。** 模型写的新句子、手工加的句子都落在它上面，被顶掉的旧句子从文件里消失。
  它是运行时数据。
- **配置在启动时读取。** 改完 `config.json` 要重启一次 `server.py`。
- **`base_url` 填到 `/v1` 一层。** 脚本自己接 `/chat/completions` 与 `/audio/speech`；
  填成完整端点地址会拼出重复路径。
- **语音需要一次页面操作。** 浏览器要求页面先收到用户操作才允许播放音频，进入页面后
  需点一下、滑一下或按一次键。这一次操作只用于解锁，页面上保持原样。
- **默认只监听本机。** `host` 为 `127.0.0.1` 时仅本机可访问。服务端自身没有鉴权，
  对外提供服务时需在前置代理上做。
- **去重两道闸的数值需要按语料调。** 只用二字组时，同话题、同句尾而意思差很远的两句也能到
  0.25 上下，而确实该合并的两句可能只有 0.35，阈值卡在中间两边都会切错；只用 difflib 时，
  阈值放到 0.45 会把一批无关的句子判成一对。换语言或换语料后，拿自己的句子重新量一遍。
- **比较前会去掉空白与标点。** 否则「今天的云走得很慢」和「今天的云走得慢。」会被当成两句。
  这一步在 `room_store._norm()`。
- **写入是原子的。** 先落 `.tmp` 再 `os.replace`，断电或并发请求不会留下半截文件。
- **敲门节奏在前端。** 服务端不主动生成句子，只有页面调 `/api/room/knock` 时才发生一次模型调用。
  页面关掉后即停止。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方与服务见 [NOTICE](NOTICE)。
