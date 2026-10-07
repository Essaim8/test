/*
 * Scrollie (com.foamzou.scrollie) —— Pro 解锁脚本
 * Target : api.rc-backup.com / api.revenuecat.com   (RevenueCat)
 * Type   : Loon response 脚本（新版语法，requires_body = true）
 *
 * 依据：
 *   · 包内 Info.plist 写明 REVENUECAT_API_KEY = appl_aOOUjqoPlLVIRlNvmbaYqeEnfWV，
 *     且 App 把 Purchases.proxyURL 指到 https://api.rc-backup.com/，真实流量走反代。
 *   · 用该公钥问官方 /v1/product_entitlement_mapping 得到权威映射：
 *       com.foamzou.scrollie.{lifetime,monthly,yearly} -> ["Scrollie Pro"]
 *   · 二进制里 setErrorHandler 出现 0 次，App 侧没有引用 verificationResult。
 *
 * 为什么脚本里还要再判一次 UA：
 *   外层的 URL 正则只能区分域名和路径，而 RevenueCat 的 CustomerInfo 路径对
 *   所有接入 RC 的 App 都是固定的 /v1/subscribers/<id>。如果哪天有人把这条规则
 *   写宽了、或和别的 RC 插件叠在一起，脚本内部这道 UA 校验能保证「不是 Scrollie
 *   的请求绝不改写」，不会误伤别的 App。
 *
 * 不返回 x-signature（签名覆盖 requestDate + 请求头哈希，客户端造不出；
 * 缺签名比错签名更接近「未发起验证」）。
 */

(function () {
    'use strict';

    var ENTITLEMENT   = 'Scrollie Pro';
    var LIFETIME_ID   = 'com.foamzou.scrollie.lifetime';
    var YEARLY_ID     = 'com.foamzou.scrollie.yearly';
    var PURCHASE_DATE = '2026-01-01T10:00:00Z';
    var EXPIRES_DATE  = '2099-12-31T23:59:59Z';

    var HOSTS = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\//i;
    var PATH  = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i;
    var UA    = /^Scrollie\//i;

    function nowISO() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    function header(headers, want) {
        var k;
        if (!headers) return '';
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
    var ua     = header($request && $request.headers, 'user-agent');

    if (!HOSTS.test(url)) { $done({}); return; }
    if (!UA.test(ua)) {
        console.log('[Scrollie-Pro] PASS (UA=' + ua + ')');
        $done({});
        return;
    }

    // 只改 CustomerInfo 本体，不吞 /offerings、/v1/config/app 等子路径
    var m = url.match(PATH);
    if (!m || method !== 'GET') {
        console.log('[Scrollie-Pro] PASS ' + method + ' ' + url.split('?')[0]);
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
        original_application_version: '32',
        original_purchase_date: PURCHASE_DATE,
        other_purchases: {},
        subscriptions: {}
    };

    // 权益本体：expires_date = null 表示永久有效
    subscriber.entitlements[ENTITLEMENT] = {
        expires_date: null,
        grace_period_expires_date: null,
        product_identifier: LIFETIME_ID,
        product_plan_identifier: null,
        purchase_date: PURCHASE_DATE,
        is_sandbox: false,
        unsubscribe_detected_at: null,
        billing_issues_detected_at: null,
        ownership_type: 'PURCHASED',
        store: 'app_store'
    };

    // 买断记录
    subscriber.non_subscriptions[LIFETIME_ID] = [{
        id: 'scrollie-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: 'scrollie-lifetime-0001'
    }];

    // 远期年度订阅：兜住以 activeSubscriptions 判定的写法
    subscriber.subscriptions[YEARLY_ID] = {
        billing_issues_detected_at: null,
        expires_date: EXPIRES_DATE,
        grace_period_expires_date: null,
        is_sandbox: false,
        original_purchase_date: PURCHASE_DATE,
        period_type: 'normal',
        purchase_date: PURCHASE_DATE,
        refunded_at: null,
        store: 'app_store',
        store_transaction_id: 'scrollie-yearly-0001',
        unsubscribe_detected_at: null
    };

    console.log('[Scrollie-Pro] FORGE user=' + appUserId);

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
