/*
 * 蔚来 App（com.do1.WeiLaiApp / NextevCar 6.9.0）—— 每日自动签到
 *
 * 触发方式（脚本自己区分）：
 *   1) http-request —— 蹭 App 自己的请求：抄 token；若今天还没签，就当场签掉
 *   2) cron         —— 到点用存档 token 补签（App 当天没打开时的兜底）
 *   3) generic      —— Loon 里手动点「蔚来-立即签到」立即执行/自检
 *
 * ══ 为什么走 gateway-front-external 而不是 app.nio.com ══════════════════
 * 抓包（695_1791597328027.har）里同一个签到动作被 App 发了两次：
 *
 *   native 路径 idx 38：
 *     POST https://app.nio.com/c/award_cn/checkin
 *          ?hash_type=sha256&timestamp=<秒>&device_id=<...>&region=cn
 *          &app_id=10002&lang=zh_cn&app_ver=6.9.0&sign=<sha256 hex>
 *     签名覆盖整个请求（含 body=event=checkin），参数按 key 排序后参与，
 *     且服务端有防重放。实测：
 *       原样重放         -> {"result_code":"sign_replay"}
 *       只改 timestamp   -> {"result_code":"sign_failed","debug_msg":"invalid sign"}
 *     => 签名不可离线复刻（穷举约 800 万种拼接/哈希/HMAC 组合无一命中）。
 *
 *   webview 路径 idx 32 / 26：
 *     POST https://gateway-front-external.nio.com/moat/10086/c/award_cn/checkin
 *          ?app_id=10086&timestamp=<秒>            <-- 客户端不带 sign
 *     GET  https://gateway-front-external.nio.com/moat/10086//n/c/award/square
 *          ?event=checkin&collection_id=1843940587332317185
 *     只认 authorization: Bearer <token>，sign 由网关自己补（响应 "uri" 回显）。
 *     实测（用已过期 token）：返回 auth_failed 而非 sign 错误 —— 说明请求形态正确，
 *     只差一个有效 token。
 *
 * ══ token 从哪来（关键，踩过坑）══════════════════════════════════════
 * 用完整解密包（蔚来_6.9.0.ipa，全 cryptid=0）逐条核对后确认：
 *   · token 不在任何响应体里（HAR 全文搜索无命中）；
 *   · 只出现在请求头 authorization，以及 /api/1/message/bind_client、
 *     /api/1/message/update_client 的 URL query（accessToken=...），
 *     且两者取值完全相同（已交叉验证）。
 * 所以采集只能放请求侧，且两条源都取：
 *   源 1：authorization 头
 *   源 2：URL 的 accessToken（$request.url 是文档保证的 String，最稳）
 *
 * ══ 为什么要"当场签"而不只靠 cron ═══════════════════════════════════
 * iOS 上 cron 依赖 Loon 后台调度，不保证准点；而 token 又会过期。
 * 所以主路径改成：App 任何一次带 token 的请求经过时，若今日未签就立刻签掉
 * ——「打开 App 就自动签到」，token 还一定是新鲜的。cron 只作兜底。
 *
 * ══ 前提 ════════════════════════════════════════════════════════════
 * 必须已登录。无需越狱、不改安装包。
 */

(function () {
    'use strict';

    /* ── 常量 ───────────────────────────────────────────────────────── */

    var HOSTS = /^https?:\/\/(?:app|gateway-front|api-fx|icar|matrix-api)[a-z-]*\.nio\.com\//i;

    var K_TOKEN   = 'nio_checkin_token';
    var K_DEVICE  = 'nio_checkin_device';
    var K_DONE    = 'nio_checkin_done_date';    // 已签到成功的日期 YYYY-MM-DD
    var K_TRY     = 'nio_checkin_try_date';     // 已尝试过的日期（防重复打）
    var K_SEEN    = 'nio_checkin_seen';         // 是否通知过「已捕获」
    var K_DBG     = 'nio_checkin_dbg';          // 诊断已打印次数

    var GW          = 'https://gateway-front-external.nio.com/moat/10086';
    var SQUARE_URI  = GW + '//n/c/award/square?event=checkin&collection_id=1843940587332317185';
    var CHECKIN_URI = GW + '/c/award_cn/checkin?app_id=10086&timestamp=';

    var UA_WEB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
                 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ' +
                 'NIOAppCN/6.9.0 (com.do1.WeiLaiApp; build:2672; OS:iOS) webview/lg _dsbridge';

    var DBG_MAX = 8;

    /* ── 小工具 ─────────────────────────────────────────────────────── */

    function read(k) { try { return $persistentStore.read(k) || ''; } catch (e) { return ''; } }
    function write(v, k) { try { return $persistentStore.write(String(v), k); } catch (e) { return false; } }
    function say(s) { try { console.log('[nio] ' + s); } catch (e) {} }
    function notify(sub, msg) {
        say('notify> ' + sub + ' | ' + String(msg).replace(/\n/g, ' / '));
        try { $notification.post('蔚来签到', sub, msg); } catch (e) {}
    }
    function nowSec() { return Math.floor(Date.now() / 1000); }
    function today() {
        var d = new Date();
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function qs(url, name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url || '');
        if (!m) return '';
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    function firstStr(v) {
        if (v == null) return '';
        if (Object.prototype.toString.call(v) === '[object Array]') return v.length ? String(v[0]) : '';
        return String(v);
    }
    // 请求头取值：兼容普通对象 / 原生宿主对象 / 数组 [{name,value}]
    function hdr(headers, name) {
        if (!headers) return '';
        var want = name.toLowerCase();
        if (Object.prototype.toString.call(headers) === '[object Array]') {
            for (var i = 0; i < headers.length; i++) {
                var h = headers[i] || {};
                if (String(h.name || h.key || '').toLowerCase() === want) {
                    return firstStr(h.value != null ? h.value : h.val);
                }
            }
            return '';
        }
        var camel = want.replace(/(^|-)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
        var tries = [want, name, camel, 'Authorization'];
        for (var j = 0; j < tries.length; j++) {
            try { var s = firstStr(headers[tries[j]]); if (s) return s; } catch (e) {}
        }
        try {
            var ks = Object.keys(headers);
            for (var k = 0; k < ks.length; k++) {
                if (String(ks[k]).toLowerCase() === want) {
                    var s2 = firstStr(headers[ks[k]]); if (s2) return s2;
                }
            }
        } catch (e) {}
        try {
            for (var key in headers) {
                if (String(key).toLowerCase() === want) {
                    var s3 = firstStr(headers[key]); if (s3) return s3;
                }
            }
        } catch (e) {}
        return '';
    }
    function headerKeys(headers) {
        try {
            if (!headers) return '(nil)';
            if (Object.prototype.toString.call(headers) === '[object Array]') {
                return headers.map(function (h) { return String((h && h.name) || '?'); }).join(',');
            }
            var ks = Object.keys(headers);
            if (ks.length) return ks.join(',');
            var out = []; for (var k in headers) out.push(k);
            return out.length ? out.join(',') : '(空)';
        } catch (e) { return '(异常)'; }
    }
    function bearer(v) {
        var s = String(v || '').trim();
        if (!s) return '';
        var m = /^Bearer\s+(.+)$/i.exec(s);
        return m ? m[1].trim() : s;
    }
    function looksLikeToken(t) { return !!t && t.length >= 20 && t.length <= 200; }

    function pickToken(url, headers) {
        var tk = bearer(hdr(headers, 'authorization'));
        if (looksLikeToken(tk)) return { token: tk, src: 'header' };
        var u = qs(url, 'accessToken') || qs(url, 'access_token');
        if (looksLikeToken(u)) return { token: u, src: 'url' };
        return { token: '', src: '' };
    }

    /* ── 签到动作（http-request / cron / generic 共用）────────────────── */

    function gwHeaders(token) {
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

    /*
     * Loon 的 timeout 单位是【毫秒】(文档默认 5000)，不是秒。
     * 之前写成 timeout:12 等于 12ms，必然瞬间超时 —— 这是"查询失败"的真凶。
     */
    var NET_TIMEOUT = 15000;

    // $httpClient 失败时 error 是【字符串】，不是 Error 对象，不能取 .message
    function errText(e) {
        if (!e) return '';
        if (typeof e === 'string') return e;
        if (e.message) return String(e.message);
        try { return JSON.stringify(e); } catch (x) { return String(e); }
    }

    // 状态码：正常是 resp.status，个别版本给 statusCode，两个都认
    function httpCode(resp) {
        if (!resp) return 0;
        var c = resp.status != null ? resp.status : resp.statusCode;
        return c != null ? Number(c) : 0;
    }

    function fetchStatus(token, cb) {
        $httpClient.get({ url: SQUARE_URI, headers: gwHeaders(token), timeout: NET_TIMEOUT }, function (err, resp, data) {
            if (err) return cb(new Error(errText(err) || 'request failed'), null, data);
            var code = httpCode(resp);
            if (code !== 200) return cb(new Error('HTTP ' + (code || '(no status)')), null, data);
            var j = null; try { j = JSON.parse(data); } catch (e) {}
            cb(null, j, data);
        });
    }

    function postCheckIn(token, cb) {
        $httpClient.post({
            url: CHECKIN_URI + nowSec(),
            headers: gwHeaders(token),
            body: 'event=checkin',
            timeout: NET_TIMEOUT
        }, function (err, resp, data) {
            var j = null; try { j = JSON.parse(data); } catch (e) {}
            cb(err, resp, j, data);
        });
    }

    /*
     * 完整签到流程。cb 在所有异步结束后调用一次（保证 $done 只调一次）。
     * quiet=true 时「今日已签到」不弹通知（被 app 请求触发时用，避免骚扰）。
     */
    function runCheckIn(token, quiet, cb) {
        fetchStatus(token, function (e1, st, raw1) {
            if (e1) {
                var msg1 = errText(e1) || '未知错误';
                say('状态查询失败：' + msg1 + ' | body=' + String(raw1 || '').slice(0, 150));
                notify('查询失败', '状态接口：' + msg1 + '\n' + String(raw1 || '').slice(0, 100));
                return cb('error');
            }
            say('状态 result_code=' + (st && st.result_code) +
                ' checked_in=' + !!(st && st.data && st.data.check_in_info && st.data.check_in_info.checked_in));

            if (!st || st.result_code !== 'success') {
                notify('登录态失效',
                    '网关返回 ' + ((st && (st.message || st.result_code)) || '无响应') +
                    '\n请打开蔚来 App 重新登录一次以刷新 token。');
                return cb('auth');
            }

            var info = (st.data && st.data.check_in_info) || {};
            if (info.checked_in === true) {
                write(today(), K_DONE);
                if (!quiet) {
                    notify('今日已签到', '已连续 ' + (info.continuous_days || '?') + ' 天'
                        + '，累计 ' + (info.accumulate_days || '?') + ' 天。');
                } else {
                    say('今日已签到，静默跳过');
                }
                return cb('already');
            }

            postCheckIn(token, function (e2, resp, j, raw) {
                if (e2) {
                    notify('签到失败', '网络错误：' + (errText(e2) || '未知错误'));
                    return cb('error');
                }
                if (j && j.result_code === 'success' && j.data) {
                    var d = j.data;
                    write(today(), K_DONE);
                    notify('签到成功',
                        (d.tip || '签到完成') + '\n积分 +' + (d.credit || 0) +
                        '，累计 ' + ((d.stats && d.stats.accumulate_days) || '?') + ' 天。');
                    return cb('ok');
                }
                var why = (j && (j.message || j.result_code)) || ('HTTP ' + (httpCode(resp) || '(no status)'));
                say('签到未成功：' + String(raw || '').slice(0, 200));
                notify('签到失败', why + '\n' + String(raw || '').slice(0, 120));
                cb('fail');
            });
        });
    }

    // 今天是否已签成
    function doneToday() { return read(K_DONE) === today(); }

    /* ── 分支 1：http-request ───────────────────────────────────────── */

    function requestJob() {
        var req = $request || {};
        var url = req.url || '';

        var p = pickToken(url, req.headers);
        var tk = p.token;

        if (looksLikeToken(tk)) {
            var old = read(K_TOKEN);
            write(tk, K_TOKEN);
            if (tk !== old) {
                say('token 已捕获 src=' + p.src + ' len=' + tk.length + ' head=' + tk.slice(0, 6) + '…');
                if (!read(K_SEEN)) {
                    notify('登录态已捕获', '已拿到 token（来源 ' + p.src + '），可以自动签到了。');
                    write('1', K_SEEN);
                }
            }
            var dev = qs(url, 'device_id');
            if (dev) write(dev, K_DEVICE);

            /*
             * 主路径：今天还没签成 → 当场签（token 此刻一定新鲜）。
             * 只在 App 启动时的两条后台心跳请求上触发（/api/1/message/update_client
             * 与 bind_client）——它们不阻塞界面，且 URL 里就带 accessToken；
             * 绝不挂在用户要等的业务请求上，避免把 App 卡住。
             */
            var isHeartbeat = /\/api\/1\/message\/(update_client|bind_client)\b/.test(url);
            if (isHeartbeat && !doneToday() && read(K_TRY) !== today()) {
                write(today(), K_TRY);   // 先占位，防止同一批请求反复触发
                say('今日未签，当场执行（heartbeat）');
                runCheckIn(tk, true, function () { $done({}); });
                return;
            }
            $done({});
            return;
        }

        // 没取到 token：限流打几条诊断，便于下次定案
        var n = parseInt(read(K_DBG) || '0', 10);
        if (n < DBG_MAX) {
            write(n + 1, K_DBG);
            say('未取到 token | host=' + url.replace(/^https?:\/\//, '').split(/[/?]/)[0] +
                ' | headers类型=' + (typeof req.headers) +
                ' | keys=[' + String(headerKeys(req.headers)).slice(0, 240) + ']' +
                ' | 存档=' + (read(K_TOKEN) ? read(K_TOKEN).length : 0));
        }
        $done({});
    }

    /* ── 分支 2/3：cron 与 generic ──────────────────────────────────── */

    function timerJob(reason) {
        var token = read(K_TOKEN);
        say('开始 reason=' + reason + ' token=' + (token ? ('有(' + token.length + ')') : '无') +
            ' doneToday=' + doneToday());

        if (!token) {
            notify('尚未获取登录态',
                '请打开一次蔚来 App（进「我的」页面），插件会自动抓 token 并签到。\n抓到时会弹「登录态已捕获」。');
            return $done();
        }
        if (reason === 'cron' && doneToday()) {
            say('今日已签到，跳过');
            return $done();
        }

        runCheckIn(token, false, function () { $done(); });
    }

    /* ── 入口 ───────────────────────────────────────────────────────── */

    if (typeof $request !== 'undefined' && $request && ($request.url || $request.headers)) {
        requestJob();
    } else if (typeof $environment !== 'undefined' && $environment) {
        timerJob('manual');
    } else {
        timerJob('cron');
    }
})();
