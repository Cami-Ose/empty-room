/* room.js — 放空室
 *
 * 全黑页面上一次显示一句话，按字数停留 2~6 秒，淡出后换下一句。
 * 句子存在服务端的 room.json 里，两个来源：模型现写的（POST /api/room/knock）、你填的。
 *
 * 节奏：淡入 → 停留（按字数算，2~6 秒）→ 淡出 → 黑场约 0.4 秒 → 下一句，循环。
 * 显示前剥掉末尾的句号（池子里存原文）。
 *
 * 敲门：屋里少于 12 句时每 100 秒一次（最多连敲 12 次），攒够后每 4 分钟一次。
 * 模型没配、或它这次没写 —— 都属于正常结果，页面照常轮播已有句子。
 *
 * 语音：每三分钟挑一句念出来（POST /tts），同时把这一句显示到屏幕上。
 * 未配置语音时只有画面。配置后需要一次页面操作（点 / 滑 / 按键）才会出声 ——
 * 浏览器要求页面先收到用户操作；这一次操作在页面上保持原样。
 */
(function () {
    'use strict';

    var 亮着毫秒 = function (text) {          // 一句亮多久：按字数算，2~6 秒
        var n = String(text || '').length;
        return Math.max(2, Math.min(6, n * 0.16 + 1.2)) * 1000;
    };
    var 淡出黑场毫秒 = 1600;                  // 淡出 1.2s + 黑场约 0.4s
    var 少话门槛 = 12;                        // 屋里少于这么多句就算「话少」
    var 少话间隔毫秒 = 100000;                // 话少时敲得勤（100 秒一次）
    var 少话最多连敲 = 12;                    // 连着这么多次都没写，就退回正常节奏
    var 正常间隔毫秒 = 240000;                // 攒够了就 4 分钟一次
    var 连着没新增 = 0;
    var 进来时刻 = Date.now();                // 拿它算「进来坐了多久」，敲门时告诉模型

    var 池 = [];                              // [{id, text, created_ts, source}]
    var 下标 = -1;                            // 当前播的是池里第几条
    var 敲着 = false;
    var 话 = document.getElementById('say');

    /* 语音那几个（见文件头）。插播 = 语音要念的那一句，让屏幕上显示的正是它。 */
    var 语音间隔毫秒 = 180000;                // 三分钟一句
    var 目标音量 = 0.55;                      // 轻声说话的音量
    var 有语音 = false;                       // 服务端配了语音没有
    var 能出声 = false;                       // 页面上有过一次用户操作没有
    var 音 = null;                            // 正在播的那个 Audio
    var 音缓存 = {};                          // id -> objectURL（同一句不重复要音频）
    var 念过的 = [];                          // 最近念过的 id，避免连着念同一句
    var 插播 = null;                          // {item, 毫秒}

    function 剥句号(t) {
        /* 只剥末尾的句号：中间的句号是断句用的，剥了会把两句黏成一句。 */
        return String(t == null ? '' : t).replace(/[。．.]+[\s\u3000]*$/, '');
    }

    function 等(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    async function 拉配置() {
        try {
            var r = await fetch('/api/config', { cache: 'no-store' });
            if (!r.ok) return;
            var d = await r.json();
            有语音 = !!(d && d.tts);
        } catch (e) { /* 问不到就按未配置处理 */ }
    }

    async function 拉池子() {
        try {
            var r = await fetch('/api/room', { cache: 'no-store' });
            if (!r.ok) return;
            var d = await r.json();
            池 = ((d && d.items) || []).filter(function (x) { return x && x.text; });
            var last = null;
            try { last = localStorage.getItem('room_last_id') || null; } catch (e) {}
            var i = last ? 池.findIndex(function (x) { return x.id === last; }) : -1;
            下标 = i;                         // 从上次那条的**下一条**接着播（循环里 +1）
        } catch (e) { /* 拉不到就等敲门那一路 */ }
    }

    function 插一句(item) {
        if (!item || !item.text) return;
        if (池.some(function (x) { return x.id === item.id; })) return;
        /* 还没开播（下标还是 -1）：让它现写的这句直接当第一句。
           这里只 unshift、不碰下标，等播() 自己 +1 落到 0。 */
        if (下标 < 0) 池.unshift(item);
        else 池.splice(下标 + 1, 0, item);     // 正播着：插在下一句的位置，紧接着就显示
    }

    async function 敲门() {
        if (敲着) return;
        敲着 = true;
        try {
            var r = await fetch('/api/room/knock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ minutes: Math.floor((Date.now() - 进来时刻) / 60000) })
            });
            if (!r.ok) return;
            var d = await r.json();
            if (d && d.said && d.text) {
                插一句({ id: d.id || ('t_' + Date.now()), text: d.text,
                          created_ts: Math.floor(Date.now() / 1000), source: 'knock' });
                连着没新增 = 0;
            } else {
                连着没新增++;                  // 这次没写（或者模型没配）—— 正常结果
            }
        } catch (e) { /* 没问到 —— 照常轮播已有句子 */ }
        finally { 敲着 = false; }
    }

    /* ---------------- 语音 ---------------- */

    function 解锁() {
        /* 浏览器要求页面先收到用户操作才允许播放。任意一次点击 / 触摸 / 按键都算，
           这一次操作在页面上保持原样。
           播一个 44 字节的空 wav，用于标记这一页已解锁。 */
        if (能出声) return;
        能出声 = true;
        try {
            var a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
            a.volume = 0;
            var p = a.play();
            if (p && p.catch) p.catch(function () {});
        } catch (e) {}
    }
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
        window.addEventListener(ev, 解锁, { once: true, passive: true });
    });

    function 停音() {
        if (音) { try { 音.pause(); } catch (e) {} 音 = null; }
    }

    function 挑一句念() {
        /* 随机挑一句，刚念过的那半池子先避开 —— 池子小时纯随机容易连着念同一句。 */
        if (!池.length) return null;
        var 候选 = 池.filter(function (x) { return 念过的.indexOf(x.id) < 0; });
        if (!候选.length) { 念过的 = []; 候选 = 池.slice(); }
        var it = 候选[Math.floor(Math.random() * 候选.length)];
        念过的.push(it.id);
        var 上限 = Math.max(1, Math.floor(池.length / 2));
        while (念过的.length > 上限) 念过的.shift();
        return it;
    }

    async function 拿音频(item) {
        if (音缓存[item.id]) return 音缓存[item.id];
        var r = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: item.text })
        });
        if (!r.ok) return '';
        var url = URL.createObjectURL(await r.blob());
        音缓存[item.id] = url;
        return url;
    }

    function 念一句(item) {
        /* 淡入 2 秒、末尾 1.5 秒淡出，声音从零起、到零收。
           返回音频时长（秒）；播不成返回 0。 */
        return 拿音频(item).then(function (url) {
            if (!url || !能出声) return 0;
            return new Promise(function (done) {
                停音();
                var a = new Audio(url);
                音 = a;
                a.volume = 0;
                var t0 = Date.now();
                var 淡入 = setInterval(function () {
                    if (音 !== a) { clearInterval(淡入); return; }
                    var k = Math.min(1, (Date.now() - t0) / 2000);
                    a.volume = 目标音量 * k;
                    if (k >= 1) clearInterval(淡入);
                }, 80);
                a.onloadedmetadata = function () {
                    var d = a.duration;
                    if (isFinite(d) && d > 3.5) {
                        setTimeout(function () {
                            if (音 !== a) return;
                            var t1 = Date.now();
                            var 淡出 = setInterval(function () {
                                if (音 !== a) { clearInterval(淡出); return; }
                                var k = Math.min(1, (Date.now() - t1) / 1500);
                                a.volume = 目标音量 * (1 - k);
                                if (k >= 1) clearInterval(淡出);
                            }, 80);
                        }, (d - 1.5) * 1000);
                    }
                };
                a.onended = function () {
                    if (音 === a) 音 = null;
                    done(isFinite(a.duration) ? a.duration : 0);
                };
                a.onerror = function () { if (音 === a) 音 = null; done(0); };
                var p = a.play();
                if (p && p.catch) p.catch(function () { if (音 === a) 音 = null; done(0); });
            });
        }).catch(function () { return 0; });
    }

    async function 语音循环() {
        /* 先把下一轮排上再干活 —— 合成要等几秒，别让它把间隔也吃掉。 */
        setTimeout(语音循环, 语音间隔毫秒);
        if (!有语音 || !能出声 || !池.length) return;
        var it = 挑一句念();
        if (!it) return;
        if (!(下标 >= 0 && 池[下标] === it)) {
            插播 = { item: it, 毫秒: 0 };      // 屏幕上显示的，得正是要念的这一句
        }
        var 时长 = await 念一句(it);
        if (插播 && 插播.item === it) {
            插播.毫秒 = Math.max(4500, (时长 || 0) * 1000 + 700);
        }
    }

    /* ---------------- 轮播 ---------------- */

    async function 播() {
        await 等(1600);                       // 进入页面后先留 1.6 秒黑场
        for (;;) {
            if (!池.length) { await 等(1500); continue; }
            var item, 这轮多久;
            if (插播 && 池.indexOf(插播.item) >= 0) {
                /* 语音挑了这句要念：这一轮先把它显示出来，停留时长按音频长度算，
                   与朗读同步。 */
                item = 插播.item;
                下标 = 池.indexOf(item);
                这轮多久 = 插播.毫秒 || 6000;
                插播 = null;
            } else {
                插播 = null;
                下标 = (下标 + 1) % 池.length;
                item = 池[下标];
                这轮多久 = 亮着毫秒(item.text);
            }
            /* 把元素摁回起点（下方 16px、透明）再让它上浮。中间那一下 transition:none
               是必须的：上一句停在 .gone（-14px），不掐掉过渡的话这一句会从上方落下来。 */
            话.style.transition = 'none';
            话.classList.remove('gone', 'lit');
            void 话.offsetWidth;               // 强制重排，让浏览器认下这个起点
            话.style.transition = '';
            话.textContent = 剥句号(item.text);
            话.dataset.t = 话.textContent;     // ::after 那层渗墨读的是 attr(data-t)
            try { localStorage.setItem('room_last_id', item.id); } catch (e) {}
            话.classList.add('lit');           // 上浮 + 淡入
            await 等(这轮多久);
            话.classList.remove('lit');
            话.classList.add('gone');          // 上浮着淡出
            await 等(1200 + 淡出黑场毫秒);
        }
    }

    function 排下一次() {
        /* 屋里话少（或者干脆空着）就敲得勤一点，好让池子攒起来 —— 只有两句的时候
           5 秒一轮，看两分钟就全是重复的。连着好几次都没写就别敲那么勤了。 */
        var 想勤敲 = 池.length < 少话门槛 && 连着没新增 < 少话最多连敲;
        敲门();
        setTimeout(排下一次, 想勤敲 ? 少话间隔毫秒 : 正常间隔毫秒);
    }

    (async function 起() {
        await 拉配置();
        await 拉池子();
        播();                                 // 不 await：这是一条无限循环
        敲门();                               // 刚进来敲一次
        setTimeout(排下一次, 少话间隔毫秒);
        setTimeout(语音循环, 语音间隔毫秒);    // 首次朗读在三分钟后
    })();
})();
