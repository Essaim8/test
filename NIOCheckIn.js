/*
 * 蔚来 App（com.do1.WeiLaiApp / NextevCar 6.9.0）—— 每日自动签到
 *
 * 这个脚本有两种触发方式，靠运行时特征自动区分：
 *   1) http-response  —— 蹭 App 自己的请求，把 Bearer token / device_id 落库
 *   2) cron           —— 到点自己去签到
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
 *     => 签名无法离线复刻（已穷举约 800 万种拼接/哈希/HMAC 组合，无一命中），
 *        这条路径对插件不可用。
 *
 *   webview 路径 idx 32 / 26：
 *     POST https://gateway-front-external.nio.com/moat/10086/c/award_cn/checkin
 *          ?app_id=10086&timestamp=<秒>            <-- 注意：客户端不带 sign
 *     GET  https://gateway-front-external.nio.com/moat/10086//n/c/award/square
 *          ?event=checkin&collection_id=1843940587332317185
 *     只认 authorization: Bearer <token>，客户端不传 sign，由网关自己补签
 *     （响应里的 "uri" 字段回显了网关现生成的 sign）。实测：带完整原始头但
 *     token 已失效 -> auth_failed；不带 token/仅探测 -> 请求被正常受理。
 *     => 这条路径只要 token，插件可以直接打。
 *
 * 结论：签到走 webview 网关通道，token 由 App 自己产生、脚本负责抄下来。
 *
 * ── 前提 ──────────────────────────────────────────────────────────────
 * 必须已登录，且 App 至少在装了本插件的设备上启动过一次（脚本要先把 token
 * 抄下来）。token 会过期（服务端会随登出/换账号立即作废），所以每次 App 发
 * 请求都会刷新本地存档。
 */

(function () {
    'use strict';

    /* ── 常量 ───────────────────────────────────────────────────────── */

    // 只有这些 host 的请求才值得抄 token，避免误伤别的 App
    var HOSTS = /^https?:\/\/(?:app|gateway-front-external|api-fx|icar|matrix-api)\.nio\.com\//i;

    var KEY_TOKEN  = 'nio_checkin_token';
    var KEY_DEVICE = 'nio_checkin_device';
    var KEY_LAST   = 'nio_checkin_last';   // 最近一次签到结果，用于 cron 去重/汇报

    // 与 HAR 完全一致，不要"美化"
    var GW         = 'https://gateway-front-external.nio.com/moat/10086';
    var SQUARE_URI = GW + '//n/c/award/square?event=checkin&collection_id=1843940587332317185';
    var CHECKIN_URI = GW + '/c/award_cn/checkin?app_id=10086&timestamp=';

    // token 归 webview 通道用，UA 抄 HAR 里 idx 32 的那条
    var UA_WEB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
                 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ' +
                 'NIOAppCN/6.9.0 (com.do1.WeiLaiApp; build:2672; OS:iOS) webview/lg _dsbridge';

    /* ── 小工具 ─────────────────────────────────────────────────────── */

    function read(k) {
        try { return $persistentStore.read(k) || ''; } catch (e) { return ''; }
    }
    function write(v, k) {
        try { $persistentStore.write(String(v), k); } catch (e) {}
    }
    function notify(sub, msg) {
        try { $notification.post('蔚来签到', sub, msg); } catch (e) {}
    }
    function nowSec() { return Math.floor(Date.now() / 1000); }

    // 从 URL query 里取字段
    function qs(url, name) {
        var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(url || '');
        return m ? decodeURIComponent(m[1]) : '';
    }

    // 请求头大小写不敏感地取
    function hdr(headers, name) {
        if (!headers) return '';
        var want = name.toLowerCase();
        for (var k in headers) {
            if (k.toLowerCase() === want) return headers[k] || '';
        }
        return '';
    }

    // Bearer 后面的 token 原样取出（形如 2.0Vp5T/gsTEfcZtvXVtp3XNjacEfFAdDHZhyxIMRkYccg=）
    function bearer(v) {
        var s = String(v || '').trim();
        if (!s) return '';
        var m = /^Bearer\s+(.+)$/i.exec(s);
        return m ? m[1].trim() : '';
    }

    function base64Decode(s) {
        var out = '';
        try {
            if (typeof atob === 'function') {
                var raw = atob(s);
                // UTF-8 还原
                return decodeURIComponent(raw.split('').map(function (c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
            }
        } catch (e) {}
        return out;
    }

    function parseBody(resp) {
        if (!resp || !resp.body) return null;
        var b = resp.body;
        if (typeof b === 'object') return b;
        var t = String(b).trim();
        if (t.charAt(0) === '{' || t.charAt(0) === '[') {
            try { return JSON.parse(t); } catch (e) {}
        }
        var dec = base64Decode(t);
        if (dec) { try { return JSON.parse(dec); } catch (e) {} }
        return null;
    }

    /* ── 分支 1：http-response，抄 token ─────────────────────────────── */

    function responseJob() {
        var req = $request || {};
        var url = req.url || '';
        var auth = hdr(req.headers, 'authorization');
        var tk = bearer(auth);

        // 每次经过都刷新，保证是最新 token
        if (tk && tk.length > 16) {
            if (tk !== read(KEY_TOKEN)) {
                write(tk, KEY_TOKEN);
                console.log('[nio] token 已更新，len=' + tk.length);
            }
        }
        var dev = qs(url, 'device_id');
        if (dev && dev !== read(KEY_DEVICE)) write(dev, KEY_DEVICE);

        // 顺手记一下用户是否手动签过，方便 cron 判断
        var j = parseBody($response);
        if (j && j.data && j.data.checked_in === true) {
            write(nowSec(), KEY_LAST);
            console.log('[nio] 观察到已签到：' + (j.data.tip || ''));
        }

        $done({});  // 绝不改响应
    }

    /* ── 分支 2：cron，执行签到 ─────────────────────────────────────── */

    function headers(token) {
        return {
            'authorization':          'Bearer ' + token,
            'content-type':           'application/x-www-form-urlencoded',
            'accept':                 'application/json, text/plain, */*',
            'accept-language':        'zh-CN,zh-Hans;q=0.9',
            'user-agent':             UA_WEB,
            'origin':                 'null',
            'sec-fetch-site':         'cross-site',
            'sec-fetch-mode':         'cors',
            'sec-fetch-dest':         'empty'
        };
    }

    // 查签到状态（免签名，只读，幂等）
    function fetchStatus(token, cb) {
        $httpClient.get({ url: SQUARE_URI, headers: headers(token), timeout: 20 }, function (err, resp, data) {
            if (err) return cb(err, null);
            if (!resp || resp.status !== 200) return cb(new Error('HTTP ' + (resp ? resp.status : '?')), null);
            var j = null;
            try { j = JSON.parse(data); } catch (e) {}
            cb(null, j);
        });
    }

    // 签到（webview 网关通道，客户端不需要 sign）
    function doCheckIn(token, cb) {
        var url = CHECKIN_URI + nowSec();
        $httpClient.post({
            url: url,
            headers: headers(token),
            body: 'event=checkin',
            timeout: 20
        }, function (err, resp, data) {
            var j = null;
            try { j = JSON.parse(data); } catch (e) {}
            cb(err, resp, j, data);
        });
    }

    function report(token, done) {
        fetchStatus(token, function (e1, st) {
            if (e1) {
                notify('查询失败', '状态接口：' + e1.message + '\n签到未执行，token 可能已失效。');
                return done();
            }
            if (!st || st.result_code !== 'success') {
                notify('登录态失效',
                    '网关返回 ' + ((st && (st.message || st.result_code)) || '无响应') +
                    '\n请打开蔚来 App 重新登录一次以刷新 token。');
                return done();
            }

            var info = (st.data && st.data.check_in_info) || {};
            if (info.checked_in === true) {
                notify('今日已签到', '已连续 ' + (info.continuous_days || '?') + ' 天'
                    + '，累计 ' + (info.accumulate_days || '?') + ' 天。');
                return done();
            }

            // 未签到 -> 打一次
            doCheckIn(token, function (e2, resp, j, raw) {
                if (e2) {
                    notify('签到失败', '网络错误：' + e2.message);
                    return done();
                }
                if (j && j.result_code === 'success' && j.data) {
                    var d = j.data;
                    notify('签到成功',
                        (d.tip || '签到完成') + '\n积分 +' + (d.credit || 0) +
                        '，累计 ' + ((d.stats && d.stats.accumulate_days) || '?') + ' 天。');
                    write(nowSec(), KEY_LAST);
                } else {
                    var why = (j && (j.message || j.result_code)) || ('HTTP ' + (resp ? resp.status : '?'));
                    notify('签到失败', why + '\n' + String(raw || '').slice(0, 120));
                }
                done();
            });
        });
    }

    function cronJob() {
        var token = read(KEY_TOKEN);
        if (!token) {
            notify('尚未获取登录态', '请先打开一次蔚来 App 并进入「我的」页面，让插件抓到 token。');
            return $done();
        }

        // 今天已经签过了就不再打扰
        var last = parseInt(read(KEY_LAST) || '0', 10);
        var today0 = new Date(); today0.setHours(0, 0, 0, 0);
        if (last && last * 1000 >= today0.getTime()) {
            console.log('[nio] 今日已签到，跳过');
            return $done();
        }

        report(token, function () { $done(); });
    }

    /* ── 入口 ───────────────────────────────────────────────────────── */

    if (typeof $response !== 'undefined') {
        // Loon 的 http-response 触发
        responseJob();
    } else {
        // cron 触发：既没有 $request 也没有 $response
        cronJob();
    }
})();
