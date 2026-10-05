/*
 * Linger (com.libowang.Linger.Global) —— Pro 解锁脚本
 * Target : api.revenuecat.com / api.rc-backup.com   (RevenueCat)
 * Type   : Loon http-response script (requires-body = true)
 *
 * 依据（IPA 里直接写着，不用猜）：
 *   Linger.app/Info.plist
 *     REVENUECAT_PUBLIC_SDK_KEY        = appl_IfYMhrtieEJqMlAETJfcDDeSgWZ
 *     REVENUECAT_ENTITLEMENT_ID        = "Pro access"
 *     REVENUECAT_DEFAULT_OFFERING_ID   = "default"
 *     REVENUECAT_USE_BACKUP_PROXY      = NO
 *   用该公钥问 RevenueCat 官方接口 /v1/product_entitlement_mapping 得到：
 *     linger_global_lifetime_standard_new / _weekly / _yearly /
 *     _yearly_discount / _yearly_original      → entitlements: ["Pro access"]
 *
 * 可干扰性：
 *   - 二进制里没有 errorHandler（App 没有注册 RC 的错误处理），
 *     App 侧也没有引用 entitlements.verificationResult；
 *   - RevenueCat 官方 Trusted Entitlements 文档明确：iOS 5.15+ 默认开启验签但
 *     "verification results are informational only"，SDK 不会自动拒绝未验签数据。
 *   ⇒ 伪造 CustomerInfo 有效。不返回 x-signature（本来也签不出来）。
 *
 * 做法：只拦 CustomerInfo 本体
 *   GET /v1/subscribers/<app_user_id>
 * 其余（/offerings、/product_entitlement_mapping、POST 等）全部原样放行。
 */

(function () {
    'use strict';

    var ENTITLEMENT   = 'Pro access';
    var LIFETIME_ID   = 'linger_global_lifetime_standard_new';
    var YEARLY_ID     = 'linger_global_yearly';
    var PURCHASE_DATE = '2026-01-01T10:00:00Z';
    var EXPIRES_DATE  = '2099-12-31T23:59:59Z';

    function nowISO() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    var url    = ($request && $request.url)    ? String($request.url)    : '';
    var method = ($request && $request.method) ? String($request.method).toUpperCase() : 'GET';

    // 只匹配 CustomerInfo 本体，不吞 /offerings、/virtual_currencies 等子路径
    var m = url.match(/^https?:\/\/[^\/]+\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i);
    if (!m || method !== 'GET') {
        $done({});
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
        original_application_version: '216',
        original_purchase_date: PURCHASE_DATE,
        other_purchases: {},
        subscriptions: {}
    };

    // 权益本体：expires_date 为空 = 永久有效
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

    // 买断记录（对应 nonSubscriptions）
    subscriber.non_subscriptions[LIFETIME_ID] = [{
        id: 'linger-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: 'linger-lifetime-0001'
    }];

    // 再挂一个远期年度订阅，兜住用 activeSubscriptions 判定的写法
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
