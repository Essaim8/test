/*
 * Linger (com.libowang.Linger.Global) —— Pro 解锁脚本
 * Target : api.rc-backup.com / api.revenuecat.com   (RevenueCat)
 * Type   : Loon response 脚本（新版语法，requires_body = true）
 *
 * 依据（IPA 里直接写着，不用猜）：
 *   Linger.app/Info.plist
 *     REVENUECAT_PUBLIC_SDK_KEY        = appl_IfYMhrtieEJqMlAETJfcDDeSgWZ
 *     REVENUECAT_ENTITLEMENT_ID        = "Pro access"
 *     REVENUECAT_USE_BACKUP_PROXY      = NO
 *   用该公钥问官方 /v1/product_entitlement_mapping：
 *     linger_global_{lifetime_standard_new,weekly,yearly,...} -> ["Pro access"]
 *   （注意：Linger 自己在 Info.plist 写了 USE_BACKUP_PROXY=NO，但二进制里仍带
 *     api.rc-backup.com 字符串，所以两个域名都保留在匹配范围内。）
 *
 * 为什么脚本里还要再判一次 UA：同 ScrolliePro.js —— 外层 URL 正则区分不了
 * 不同的 RC App（路径对所有 RC App 都是 /v1/subscribers/<id>），脚本内部这道
 * 校验保证不误伤别的 App。
 *
 * 不返回 x-signature。
 */

(function () {
    'use strict';

    var ENTITLEMENT   = 'Pro access';
    var LIFETIME_ID   = 'linger_global_lifetime_standard_new';
    var YEARLY_ID     = 'linger_global_yearly';
    var PURCHASE_DATE = '2026-01-01T10:00:00Z';
    var EXPIRES_DATE  = '2099-12-31T23:59:59Z';

    var HOSTS = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\//i;
    var PATH  = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i;
    // Linger 的 CFBundleName 是 Linger，CFBundleDisplayName 是「去留」。
    // 日志里没有 Linger 自己发起的流量可以核对到底是哪个，两种都接受。
    var UA    = /^(?:Linger|去留)\//i;

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
        console.log('[Linger-Pro] PASS (UA=' + ua + ')');
        $done({});
        return;
    }

    var m = url.match(PATH);
    if (!m || method !== 'GET') {
        console.log('[Linger-Pro] PASS ' + method + ' ' + url.split('?')[0]);
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
        original_application_version: '216',
        original_purchase_date: PURCHASE_DATE,
        other_purchases: {},
        subscriptions: {}
    };

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

    subscriber.non_subscriptions[LIFETIME_ID] = [{
        id: 'linger-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: 'linger-lifetime-0001'
    }];

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
        store_transaction_id: 'linger-yearly-0001',
        unsubscribe_detected_at: null
    };

    console.log('[Linger-Pro] FORGE user=' + appUserId);

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
