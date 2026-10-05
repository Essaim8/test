/*
 * 飓风相机 / StormCam (com.ysjf.lutcamera) —— 诊断脚本（只读，不改任何响应）
 *
 * 目的：把 base.ysjf.com/storm_auth 下接口的**真实响应结构**打到 Loon 脚本日志，
 *       用来确认两件事：
 *         1) /auth/account/v2/users/action/get_info 的 data 结构长什么样；
 *         2) 未购买状态下 memberships 是空数组还是压根没有这个字段。
 *
 * 拿到结果后才有依据去写精确的伪造脚本——在此之前盲写只能靠猜。
 *
 * 隐私：token / secret / password / signature 之类的字段会被打码。
 */

(function () {
    'use strict';

    var SENSITIVE = /(token|secret|password|passwd|signature|authorization|cookie|ticket)/i;
    var MAXLEN = 3000;

    function mask(v, depth) {
        if (depth > 6) return '[deep]';
        if (Array.isArray(v)) {
            return v.slice(0, 8).map(function (x) { return mask(x, depth + 1); });
        }
        if (v && typeof v === 'object') {
            var out = {};
            for (var k in v) {
                if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
                out[k] = SENSITIVE.test(k) ? '***' : mask(v[k], depth + 1);
            }
            return out;
        }
        return v;
    }

    var url = ($request && $request.url) ? String($request.url) : '';
    if (!/^https?:\/\/[^\/]*ysjf\.com\//i.test(url)) {
        $done({});
        return;
    }

    var raw = ($response && $response.body) ? String($response.body) : '';
    var printable;
    try {
        printable = JSON.stringify(mask(JSON.parse(raw), 0));
    } catch (e) {
        printable = raw;      // 非 JSON 就原样（截断）
    }

    console.log('[StormCam] ' + ($request.method || '') + ' ' + url.split('?')[0]);
    console.log('[StormCam] ' + printable.slice(0, MAXLEN));

    $done({});                // 不改动响应
})();
