/*
 * 蔚来 App（com.do1.WeiLaiApp / NextevCar 6.9.0）—— 每日自动签到
 *
 * 三种触发方式，脚本自己区分：
 *   1) http-request —— 蹭 App 自己的请求，把 Bearer token 落库（不改请求）
 *   2) cron         —— 到点自动签到
 *   3) generic      —— 在 Loon 里手动点一下自检/立即签到
 *
 * ── 为什么走 gateway-front-external 而不是 app.nio.com ────────────────
 * 抓包（695_1791597328027.har）里同一个签到动作被 App 发了两次：
 *
 *   native 路径 idx 38：
 *     POST https://app.nio.com/c/award_cn/checkin
 *          ?hash_type=sha256&timestamp=<秒>&device_id=<...>&region=cn
 *          &app_id=10002&lang=zh_cn&app_ver=6.9.0&sign=<sha256 hex>
 *     签名覆盖整个请求（含 body=event=checkin），参数按 key 排序后参与；
 *     且服务端有防重放。实测：
 *       原样重放        -> {"result_code":"sign_replay"}
 *       改 timestamp 再放 -> {"result_code":"sign_failed","debug_msg":"invalid sign"}
 *     => 签名无法离线复刻（穷举约 800 万种拼接/哈希/HMAC 组合无一命中），这条路不可用。
 *
 *   webview 路径 idx 32 / 26：
 *     POST https://gateway-front-external.nio.com/moat/10086/c/award_cn/checkin
 *          ?app_id=10086&timestamp=<秒>            <-- 客户端不带 sign
 *     GET  https://gateway-front-external.nio.com/moat/10086//n/c/award/square
 *          ?event=checkin&collection_id=1843940587332317185
 *     只认 authorization: Bearer <token>，sign 由网关自己补（响应 "uri" 字段回显）。
 *     => 只要 token，插件可以直接打。
 *
 * ── token 来源（这一条踩过坑，别改回去）──────────────────────────────
 * 第一版把采集放在 http-response：真机跑满 100 次（match/Trigger/Finished 各 100）
 * 却一次都没取到 —— Loon 文档里 http-response 只承诺 $response.*。改成 http-request
 * 后能跑到脚本（111 次全部 Script done），但日志显示 HAR 里明确带 authorization 的
 * 请求，脚本仍报 auth头=无。所以本版不再依赖单一取法：
 *   · 源 1：authorization 头（多种取法 + 数组形态兜底）
 *   · 源 2：URL query 的 accessToken（真机日志里确实出现过，且 $request.url 是
 *           官方保证的 String，最可靠）
 * 并且每次决策都会写一行 [nio] 日志（含 headers 的 typeof 与键名），这样下一份
 * 隧道日志能直接判定到底卡在哪，不用再猜。
 *
 * ── 前提 ──────────────────────────────────────────────────────────────
 * 必须已登录，且 App 至少启动过一次（要先把 token 抄下来）。token 会过期
 * （登出/换账号立即作废），每次 App 发请求都会刷新存档。
 */

(function () {
    'use strict';

    /* ── 常量 ───────────────────────────────────────────────────────── */

    var HOSTS = /^https?:\/\/(?:app|gateway-front|api-fx|icar|matrix-api)[a-z-]*\.nio\.com\//i;

    var KEY_TOKEN      = 'nio_checkin_token';
    var KEY_DEVICE     = 'nio_checkin_device';
    var KEY_LAST       = 'nio_checkin_last';        // 最近一次签到成功时间
    var KEY_TOKEN_SEEN = 'nio_checkin_token_seen';  // 是否已就「抓到 token」通知过
    var KEY_DBG_N      = 'nio_checkin_dbg_n';       // 已输出的诊断次数（限流用）
    var KEY_DBG_TS     = 'nio_checkin_dbg_ts';      // 上次诊断时间戳（限流用）

    var GW          = 'https://gateway-front-external.nio.com/moat/10086';
    var SQUARE_URI  = GW + '//n/c/award/square?event=checkin&collection_id=1843940587332317185';
    var CHECKIN_URI = GW + '/c/award_cn/checkin?app_id=10086&timestamp=';

    var UA_WEB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
                 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ' +
                 'NIOAppCN/6.9.0 (com.do1.WeiLaiApp; build:2672; OS:iOS) webview/lg _dsbridge';

    var DBG_MAX = 6;      // 最多打 6 条诊断，避免刷爆日志
    var DBG_GAP = 3000;   // 相邻诊断至少间隔 3 秒

    /* ── 小工具 ─────────────────────────────────────────────────────── */

    function read(k) {
        try { return $persistentStore.read(k) || ''; } catch (e) { return ''; }
    }
    function write(v, k) {
        try { $persistentStore.write(String(v), k); return true; } catch (e) { return false; }
    }
    function say(s) {
        try { console.log('[nio] ' + s); } catch (e) {}
    }
    // 通知同时写日志：Loon 的隧道日志不记录 $notification.post，写一行才查得到
    function notify(sub, msg) {
        say('notify> ' + sub + ' | ' + String(msg).replace(/\n/g, ' / '));
        try { $notification.post('蔚来签到', sub, msg); } catch (e) {}
    }
    function nowSec() { return Math.floor(Date.now() / 1000); }

    function qs(url, name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url || '');
        if (!m) return '';
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }

    // 诊断限流：返回 true 表示这次可以输出
    function dbgAllowed() {
        var n = parseInt(read(KEY_DBG_N) || '0', 10);
        if (n >= DBG_MAX) return false;
        var ts = parseInt(read(KEY_DBG_TS) || '0', 10);
        var now = Date.now();
        if (ts && (now - ts) < DBG_GAP) return false;
        write(n + 1, KEY_DBG_N);
        write(now, KEY_DBG_TS);
        return true;
    }

    /*
     * 请求头取值，尽可能穷尽各种形态：
     *   普通对象（大小写混用）、原生宿主对象（for...in 枚举不到）、数组 [{name,value}]、
     *   以及个别实现把 header 值塞成数组的形式。
     */
    function hdr(headers, name) {
        if (!headers) return '';
        var want = name.toLowerCase();

        // 数组形态
        if (Object.prototype.toString.call(headers) === '[object Array]') {
            for (var i = 0; i < headers.length; i++) {
                var h = headers[i] || {};
                if (String(h.name || h.key || '').toLowerCase() === want) {
                    return firstStr(h.value != null ? h.value : h.val);
                }
            }
            return '';
        }

        // 直接下标：原样、全小写、每个词首字母大写
        var camel = want.replace(/(^|-)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
        var tries = [want, name, camel, 'Authorization'];
        for (var j = 0; j < tries.length; j++) {
            try {
                var v = headers[tries[j]];
                var s = firstStr(v);
                if (s) return s;
            } catch (e) {}
        }

        // 枚举键
        try {
            var keys = Object.keys(headers);
            for (var k = 0; k < keys.length; k++) {
                if (String(keys[k]).toLowerCase() === want) {
                    var s2 = firstStr(headers[keys[k]]);
                    if (s2) return s2;
                }
            }
        } catch (e) {}

        // for...in 兜底（有的宿主对象只支持这种）
        try {
            for (var key in headers) {
                if (String(key).toLowerCase() === want) {
                    var s3 = firstStr(headers[key]);
                    if (s3) return s3;
                }
            }
        } catch (e) {}

        return '';
    }

    function firstStr(v) {
        if (v == null) return '';
        if (Object.prototype.toString.call(v) === '[object Array]') return v.length ? String(v[0]) : '';
        return String(v);
    }

    function headerKeys(headers) {
        try {
            if (!headers) return '(nil)';
            if (Object.prototype.toString.call(headers) === '[object Array]') {
                return headers.map(function (h) { return String((h && h.name) || '?'); }).join(',');
            }
            var ks = Object.keys(headers);
            if (ks.length) return ks.join(',');
            var out = [];
            for (var k in headers) out.push(k);
            return out.length ? out.join(',') : '(空)';
        } catch (e) { return '(异常:' + e.message + ')'; }
    }

    function bearer(v) {
        var s = String(v || '').trim();
        if (!s) return '';
        var m = /^Bearer\s+(.+)$/i.exec(s);
        return m ? m[1].trim() : s;
    }

    function looksLikeToken(t) {
        return !!t && t.length >= 20 && t.length <= 200;
    }

    /* ── 分支 1：http-request，抄 token ─────────────────────────────── */

    function requestJob() {
        var req = $request || {};
        var url = req.url || '';
        var hi = '';

        // 源 1：authorization 头
        try {
            hi = hdr(req.headers, 'authorization');
        } catch (e) {
            say('读 authorization 头异常：' + e.message);
        }
        var tk  = bearer(hi);
        var src = tk ? 'header' : '';

        // 源 2：URL 里的 accessToken（$request.url 是官方保证的 String，最可靠）
        if (!looksLikeToken(tk)) {
            var fromUrl = qs(url, 'accessToken') || qs(url, 'access_token');
            if (looksLikeToken(fromUrl)) { tk = fromUrl; src = 'url'; }
        }

        var st = read(KEY_TOKEN);
        if (looksLikeToken(tk)) {
            write(tk, KEY_TOKEN);
            if (tk !== st) {
                say('token 已捕获 src=' + src + ' len=' + tk.length + ' head=' + tk.slice(0, 6) + '…');
                if (!read(KEY_TOKEN_SEEN)) {
                    notify('登录态已捕获', '已拿到 token（来源 ' + src + '），可以定时签到了。\n以后不需要再手动打开 App。');
                } else {
                    notify('登录态已更新', 'token 变了（重新登录或切换账号），本地存档已刷新。');
                }
                write('1', KEY_TOKEN_SEEN);
            }
        } else if (dbgAllowed()) {
            // 决定性诊断：headers 的真实形态 + 键名，一次就够定案
            say('未取到 token | host=' + url.replace(/^https?:\/\//, '').split(/[/?]/)[0] +
                ' | path=' + url.replace(/^https?:\/\//, '').split('?')[0].split('/').slice(1, 4).join('/') +
                ' | headers类型=' + (typeof req.headers) +
                ' | keys=[' + String(headerKeys(req.headers)).slice(0, 200) + ']' +
                ' | 已存token=' + (st ? st.length : 0));
        }

        var dev = qs(url, 'device_id');
        if (dev && dev !== read(KEY_DEVICE)) write(dev, KEY_DEVICE);

        $done({});   // 绝不改请求
    }

    /* ── 分支 2/3：cron 与 generic 共用同一套签到逻辑 ────────────────── */

    function headers(token) {
        return {
            'authorization':   'Bearer ' + token,
            'content-type':    'application/x-www-form-urlencoded',
            'accept':          'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh-Hans;q=0.9',
            'user-agent':      UA_WEB,
            'origin':          'null',
            'sec-fetch-site':  'cross-site',
            'sec-fetch-mode':  'cors',
            'sec-fetch-dest':  'empty'
        };
    }

    function fetchStatus(token, cb) {
        $httpClient.get({ url: SQUARE_URI, headers: headers(token), timeout: 20 }, function (err, resp, data) {
            if (err) return cb(err, null, data);
            if (!resp || resp.status !== 200) return cb(new Error('HTTP ' + (resp ? resp.status : '?')), null, data);
            var j = null;
            try { j = JSON.parse(data); } catch (e) {}
            cb(null, j, data);
        });
    }

    function doCheckIn(token, cb) {
        $httpClient.post({
            url: CHECKIN_URI + nowSec(),
            headers: headers(token),
            body: 'event=checkin',
            timeout: 20
        }, function (err, resp, data) {
            var j = null;
            try { j = JSON.parse(data); } catch (e) {}
            cb(err, resp, j, data);
        });
    }

    // reason: 'cron' 或 'manual'
    function runJob(reason) {
        var token = read(KEY_TOKEN);
        say('开始执行 reason=' + reason + ' token=' + (token ? ('有(len ' + token.length + ')') : '无'));

        if (!token) {
            notify('尚未获取登录态',
                '请先打开一次蔚来 App（进「我的」页面），让插件抓到 token。\n抓到时会弹「登录态已捕获」。');
            return $done();
        }

        // cron 当天已签过就不重复；手动点则始终查询并如实汇报
        if (reason === 'cron') {
            var last = parseInt(read(KEY_LAST) || '0', 10);
            var t0 = new Date(); t0.setHours(0, 0, 0, 0);
            if (last && last * 1000 >= t0.getTime()) {
                say('今日已签到，跳过');
                return $done();
            }
        }

        fetchStatus(token, function (e1, st, raw1) {
            if (e1) {
                say('查询失败：' + e1.message + ' | body=' + String(raw1 || '').slice(0, 150));
                notify('查询失败', '状态接口：' + e1.message);
                return $done();
            }
            say('状态响应 result_code=' + (st && st.result_code) +
                ' checked_in=' + !!(st && st.data && st.data.check_in_info && st.data.check_in_info.checked_in));

            if (!st || st.result_code !== 'success') {
                notify('登录态失效',
                    '网关返回 ' + ((st && (st.message || st.result_code)) || '无响应') +
                    '\n请打开蔚来 App 重新登录一次以刷新 token。');
                return $done();
            }

            var info = (st.data && st.data.check_in_info) || {};
            if (info.checked_in === true) {
                notify('今日已签到', '已连续 ' + (info.continuous_days || '?') + ' 天'
                    + '，累计 ' + (info.accumulate_days || '?') + ' 天。');
                return $done();
            }

            doCheckIn(token, function (e2, resp, j, raw) {
                if (e2) {
                    notify('签到失败', '网络错误：' + e2.message);
                    return $done();
                }
                if (j && j.result_code === 'success' && j.data) {
                    var d = j.data;
                    notify('签到成功',
                        (d.tip || '签到完成') + '\n积分 +' + (d.credit || 0) +
                        '，累计 ' + ((d.stats && d.stats.accumulate_days) || '?') + ' 天。');
                    write(nowSec(), KEY_LAST);
                } else {
                    var why = (j && (j.message || j.result_code)) || ('HTTP ' + (resp ? resp.status : '?'));
                    say('签到未成功：' + String(raw || '').slice(0, 200));
                    notify('签到失败', why + '\n' + String(raw || '').slice(0, 120));
                }
                $done();
            });
        });
    }

    /* ── 入口 ───────────────────────────────────────────────────────── */

    if (typeof $request !== 'undefined' && $request && ($request.url || $request.headers)) {
        requestJob();            // http-request
    } else if (typeof $environment !== 'undefined' && $environment) {
        runJob('manual');        // generic（在 Loon 里手动触发）
    } else {
        runJob('cron');          // cron
    }
})();
