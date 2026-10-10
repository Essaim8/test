/*
 * 蔚来 App（com.do1.WeiLaiApp / NextevCar 6.9.0）—— 每日自动签到
 *
 * 这个脚本有两种触发方式，靠运行时特征自动区分：
 *   1) http-request  —— 蹭 App 自己的请求，把 Bearer token 落库（不改请求）
 *   2) cron          —— 到点自己去签到
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
 * ── token 从哪来（这一条踩过坑，别改回去）──────────────────────────────
 * 第一版用 http-response 脚本读 $request.headers，真机上跑满 100 次
 * （match / Trigger / Finished 各 100）却一次都没取到 token：Loon 官方文档里
 * http-response 只承诺提供 $response.*，$request 仅写作"原请求信息"；而
 * http-request 明确列出 $request.headers。所以采集必须放在 http-request 阶段。
 *
 * 另外真机日志（2026-10-10 10:21）暴露了第二个 token 源：URL query 里的
 * accessToken 参数，例如
 *   /api/1/message/update_client?...&accessToken=2.0m%2BNlGOt5y0L...%3D
 * 它与 authorization 头的 Bearer 是同一个凭据。两个源都取，谁先出现用谁。
 *
 * ── 前提 ──────────────────────────────────────────────────────────────
 * 必须已登录，且 App 至少在装了本插件的设备上启动过一次（脚本要先把 token
 * 抄下来）。token 会过期（登出/换账号立即作废），每次 App 发请求都会刷新存档。
 */

(function () {
    'use strict';

    /* ── 常量 ───────────────────────────────────────────────────────── */

    // 只有这些 host 的请求才值得抄 token，避免误伤别的 App
    var HOSTS = /^https?:\/\/(?:app|gateway-front|api-fx|icar|matrix-api)[a-z-]*\.nio\.com\//i;

    var KEY_TOKEN  = 'nio_checkin_token';
    var KEY_DEVICE = 'nio_checkin_device';
    var KEY_LAST   = 'nio_checkin_last';   // 最近一次签到成功时间，用于 cron 去重/汇报
    var KEY_TOKEN_SEEN = 'nio_checkin_token_seen';  // 是否已经就「抓到 token」通知过

    // 与 HAR 完全一致，不要"美化"
    var GW          = 'https://gateway-front-external.nio.com/moat/10086';
    var SQUARE_URI  = GW + '//n/c/award/square?event=checkin&collection_id=1843940587332317185';
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
        if (!m) return '';
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }

    /*
     * 请求头取值。Loon 的原生 headers 是宿主对象，for...in 未必枚举得到，
     * 所以先按常见大小写直取，再退回 Object.keys，最后兼容数组形态。
     */
    function hdr(headers, name) {
        if (!headers) return '';
        var want = name.toLowerCase();

        // 1) 直接下标（命中率最高，Loon 通常已小写）
        var direct = ['', ''];
        if (typeof headers === 'object' && !(headers instanceof Array)) {
            var tries = [want, name, want.replace(/(^|-)([a-z])/g, function (m, a, b) {
                return a + b.toUpperCase();
            })];
            for (var i = 0; i < tries.length; i++) {
                var v = headers[tries[i]];
                if (v != null && v !== '') return String(v);
            }
            // 2) 枚举键
            try {
                var keys = Object.keys(headers);
                for (var j = 0; j < keys.length; j++) {
                    if (String(keys[j]).toLowerCase() === want) {
                        var v2 = headers[keys[j]];
                        if (v2 != null && v2 !== '') return String(v2);
                    }
                }
            } catch (e) {}
        }

        // 3) 数组形态 [{name, value}]
        if (headers instanceof Array) {
            for (var k = 0; k < headers.length; k++) {
                var h = headers[k] || {};
                if (String(h.name || '').toLowerCase() === want) return String(h.value || '');
            }
        }
        return '';
    }

    // Bearer 后面的 token 原样取出（形如 2.0Vp5T/gsTEfcZtvXVtp3XNjacEfFAdDHZhyxIMRkYccg=）
    function bearer(v) {
        var s = String(v || '').trim();
        if (!s) return '';
        var m = /^Bearer\s+(.+)$/i.exec(s);
        return m ? m[1].trim() : s;   // 有的接口直接给裸 token
    }

    // 凑一个像真 token 的值：HAR 抓到的形如 2.0 + 45 字符
    function looksLikeToken(t) {
        return !!t && t.length >= 20 && t.length <= 200;
    }

    /* ── 分支 1：http-request，抄 token ─────────────────────────────── */

    function requestJob() {
        var req = $request || {};
        var url = req.url || '';

        // 源 1：authorization 头
        var tk = bearer(hdr(req.headers, 'authorization'));

        // 源 2：URL 里的 accessToken（真机日志里确实出现过）
        if (!looksLikeToken(tk)) {
            var fromUrl = qs(url, 'accessToken') || qs(url, 'access_token');
            if (looksLikeToken(fromUrl)) tk = fromUrl;
        }

        if (looksLikeToken(tk)) {
            var isNew = (tk !== read(KEY_TOKEN));
            write(tk, KEY_TOKEN);
            if (isNew) {
                console.log('[nio] token 已捕获，len=' + tk.length);
                if (!read(KEY_TOKEN_SEEN)) {
                    notify('登录态已捕获', '已拿到 Bearer token，可以定时签到了。\n以后不需要再手动打开 App。');
                } else {
                    notify('登录态已更新', 'token 变了（重新登录或切换账号），本地存档已刷新。');
                }
                write('1', KEY_TOKEN_SEEN);
            }
        } else {
            // 只有首次排查时才需要看这行，抓到之后就安静了
            if (!read(KEY_TOKEN_SEEN)) {
                console.log('[nio] 本次请求未取到 token：' + url.slice(0, 80) +
                            ' | auth头=' + (hdr(req.headers, 'authorization') ? '有' : '无'));
            }
        }

        var dev = qs(url, 'device_id');
        if (dev && dev !== read(KEY_DEVICE)) write(dev, KEY_DEVICE);

        $done({});   // 绝不改请求
    }

    /* ── 分支 2：cron，执行签到 ─────────────────────────────────────── */

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

    if (typeof $request !== 'undefined' && $request) {
        requestJob();     // http-request 触发
    } else {
        cronJob();        // cron 触发：既没有 $request 也没有 $response
    }
})();
