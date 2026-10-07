/*
 * RevenueCat 多 App 合一解锁脚本
 * Target : api.rc-backup.com / api.revenuecat.com   (RevenueCat)
 * Type   : Loon http-response script (requires-body = true)
 * Tag    : RC-Multi
 *
 * ── 为什么必须合并成一个脚本 ──────────────────────────────────────────────
 * Loon 对**一条 URL 只会执行第一个匹配到的 http-response 脚本**（日志实测：
 * Scrollie 的请求 useragent:Scrollie/32 命中的却是 Linger-Pro，且全程只出现
 * 一条 match），而 Scrollie / Linger / APTV 三家的 CustomerInfo 接口路径
 * 完全相同（/v1/subscribers/<app_user_id>），正则无法区分。
 *
 * 于是出现：Linger 插件排在前面 → 吃掉 Scrollie 的请求 → 用 'Pro access'
 * 的响应覆盖掉 Scrollie 的 'Scrollie Pro' 缓存 → Scrollie 掉 Pro。
 * 反过来也一样。**拆成多个插件无论怎么调顺序都必然互相覆盖。**
 *
 * 所以这里只保留一个插件、一个脚本，内部按请求的 User-Agent 分流，
 * 每个 App 拿到自己那份 payload。
 *
 * ── UA 规律 ──────────────────────────────────────────────────────────────
 * iOS 默认 UA = "<CFBundleName>/<CFBundleVersion>"，实测对齐：
 *   Scrollie  2.3.0 (build 32)          → Scrollie/32
 *   APTV      1.5.12                    → APTV/1（CFBundleName=APTV）
 *   Linger    1.50.1 (build 216)        → Linger/216
 *     （Linger 的 CFBundleDisplayName 是「去留」，CFBundleName 是 Linger。日志里没有 Linger
 *      自己的流量可以核对，所以两种都匹配，避免 UA 用显示名时漏判。）
 * 所以用 /^<名字>\// 前缀匹配即可，版本号升级不影响。
 *
 * ── 权益参数（均取自各自 Info.plist 的公钥 + 官方 product_entitlement_mapping）─
 *   Scrollie  appl_aOOUjqoPlLVIRlNvmbaYqeEnfWV
 *     com.foamzou.scrollie.{lifetime,monthly,yearly} -> "Scrollie Pro"
 *   Linger    appl_IfYMhrtieEJqMlAETJfcDDeSgWZ
 *     linger_global_{lifetime_standard_new,weekly,yearly,...} -> "Pro access"
 *
 * 不返回 x-signature（签名覆盖 requestDate + 请求头哈希，客户端造不出）。
 */

(function () {
    'use strict';

    var PURCHASE_DATE = '2026-01-01T10:00:00Z';
    var EXPIRES_DATE  = '2099-12-31T23:59:59Z';
    var HOSTS         = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\//i;
    var TARGET        = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i;

    // 每个 App 一份：ua 用前缀匹配（忽略大小写），App 不在表里就原样放行
    var APPS = [
        {
            name: 'Scrollie',
            ua: /^Scrollie\//i,
            entitlement: 'Scrollie Pro',
            lifetimeId: 'com.foamzou.scrollie.lifetime',
            yearlyId: 'com.foamzou.scrollie.yearly',
            appVersion: '32'
        },
        {
            name: 'Linger',
            ua: /^(?:Linger|去留)\//i,
            entitlement: 'Pro access',
            lifetimeId: 'linger_global_lifetime_standard_new',
            yearlyId: 'linger_global_yearly',
            appVersion: '216'
        }
    ];

    function nowISO() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    function pickHeader(headers, want) {
        if (!headers) return '';
        var k;
        for (k in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, k) &&
                String(k).toLowerCase() === want) {
                return String(headers[k]);
            }
        }
        return '';
    }

    var url    = ($request && $request.url)    ? String($request.url)    : '';
    var method = ($request && $request.method) ? String($request.method).toUpperCase() : 'GET';
    var ua     = pickHeader($request && $request.headers, 'user-agent');

    if (!HOSTS.test(url)) { $done({}); return; }

    // 只匹配 CustomerInfo 本体，不吞 /offerings、/v1/config/app 等子路径
    var m = url.match(TARGET);
    if (!m || method !== 'GET') { $done({}); return; }

    // 按 UA 判定是哪个 App；认不出来就放行，绝不误伤
    var app = null, i;
    for (i = 0; i < APPS.length; i++) {
        if (APPS[i].ua.test(ua)) { app = APPS[i]; break; }
    }
    if (!app) {
        console.log('[RC-Multi] PASS (unknown UA) ' + ua + ' ' + url.split('?')[0]);
        $done({});
        return;
    }

    var appUserId = m[1];
    try { appUserId = decodeURIComponent(appUserId); } catch (e) { /* 原样 */ }

    var now = nowISO();
    var subscriber = {
        entitlements: {},
        first_seen: PURCHASE_DATE,
        last_seen: now,
        management_url: null,
        non_subscriptions: {},
        original_app_user_id: appUserId,
        original_application_version: app.appVersion,
        original_purchase_date: PURCHASE_DATE,
        other_purchases: {},
        subscriptions: {}
    };

    // 权益本体：expires_date = null 表示永久有效
    subscriber.entitlements[app.entitlement] = {
        expires_date: null,
        grace_period_expires_date: null,
        product_identifier: app.lifetimeId,
        product_plan_identifier: null,
        purchase_date: PURCHASE_DATE,
        is_sandbox: false,
        unsubscribe_detected_at: null,
        billing_issues_detected_at: null,
        ownership_type: 'PURCHASED',
        store: 'app_store'
    };

    // 终身买断记录
    subscriber.non_subscriptions[app.lifetimeId] = [{
        id: app.name.toLowerCase() + '-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: app.name.toLowerCase() + '-lifetime-0001'
    }];

    // 远期年度订阅：兜住以 activeSubscriptions 判定的写法
    subscriber.subscriptions[app.yearlyId] = {
        billing_issues_detected_at: null,
        expires_date: EXPIRES_DATE,
        grace_period_expires_date: null,
        is_sandbox: false,
        original_purchase_date: PURCHASE_DATE,
        period_type: 'normal',
        purchase_date: PURCHASE_DATE,
        refunded_at: null,
        store: 'app_store',
        store_transaction_id: app.name.toLowerCase() + '-yearly-0001',
        unsubscribe_detected_at: null
    };

    console.log('[RC-Multi] FORGE ' + app.name + ' (' + ua + ') user=' + appUserId);

    $done({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            request_date: now,
            request_date_ms: Date.now(),
            subscriber: subscriber
        })
    });
})();
