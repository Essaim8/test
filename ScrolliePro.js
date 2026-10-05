/*
 * Scrollie (com.foamzou.scrollie) —— Pro 解锁脚本
 * Target : api.rc-backup.com / api.revenuecat.com  (RevenueCat)
 * Type   : Loon http-response script (不需要 requires-body)
 *
 * 背景（实测）：
 *   - 会员状态来自 RevenueCat，唯一权益标识是 "Scrollie Pro"
 *     （用 App 内置的公钥问 /v1/product_entitlement_mapping 得到：
 *      com.foamzou.scrollie.{lifetime,monthly,yearly} -> ["Scrollie Pro"]）
 *   - App 自己把 Purchases.proxyURL 指到 https://api.rc-backup.com/，
 *     所以 SDK 的请求实际打到 rc-backup 这个域名。
 *   - RevenueCat 的 Trusted Entitlements 默认只是「informational」：
 *     官方文档明确写 SDK 不会因为验签失败而拒绝数据，是否处理由 App 自己决定；
 *     这个 App 没有用 Purchases.errorHandler，也没有引用 verificationResult，
 *     所以伪造 CustomerInfo 是有效的。
 *
 * 做法：只拦截 CustomerInfo 接口
 *   GET /v1/subscribers/<app_user_id>
 * 返回一个带有效 "Scrollie Pro" 权益的 CustomerInfo。
 * 为了兼容 App 可能用到的各种判断口径（entitlements.active /
 * activeSubscriptions / nonSubscriptions），三种痕迹都写进去了。
 * 不返回 x-signature 头（本来也签不出来）。
 */

(function () {
    'use strict';

    var ENTITLEMENT   = 'Scrollie Pro';
    var LIFETIME_ID   = 'com.foamzou.scrollie.lifetime';
    var YEARLY_ID     = 'com.foamzou.scrollie.yearly';
    var PURCHASE_DATE = '2026-01-01T10:00:00Z';
    var EXPIRES_DATE  = '2099-12-31T23:59:59Z';

    function nowISO() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    var url    = ($request && $request.url)    ? String($request.url)    : '';
    var method = ($request && $request.method) ? String($request.method).toUpperCase() : 'GET';

    // 严格只匹配 CustomerInfo 本体，不要吞掉 /offerings、/virtual_currencies 等子路径
    var m = url.match(/^https?:\/\/[^\/]+\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i);
    if (!m || method !== 'GET') {
        $done({});      // 其它请求原样放行
        return;
    }

    var appUserId = m[1];
    try {
        appUserId = decodeURIComponent(appUserId);
    } catch (e) { /* 保持原样 */ }

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

    // 权益本体：expires_date = null 表示永久有效（终身）
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

    // 终身买断记录（对应 nonSubscriptions）
    subscriber.non_subscriptions[LIFETIME_ID] = [{
        id: 'scrollie-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: 'scrollie-lifetime-0001'
    }];

    // 再挂一个远期有效的年度订阅（对应 activeSubscriptions，兜住以订阅判定的写法）
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

    $done({
        status: 200,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            request_date: now,
            request_date_ms: Date.now(),
            subscriber: subscriber
        })
    });
})();
