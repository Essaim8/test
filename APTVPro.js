/*
 * APTV (com.kimen.aptvpro) —— Pro 解锁脚本
 * Target : api.rc-backup.com / api.revenuecat.com   (RevenueCat)
 * Type   : Loon http-response script (requires-body = true)
 *
 * 依据：
 *   · 包体带 RevenueCat_RevenueCat.bundle；二进制里 RC 公钥与
 *     "https://api.rc-backup.com/" 在 __cstring 里紧邻（App 设了 Purchases.proxyURL），
 *     所以实际请求走的是反代域名，不是 api.revenuecat.com。
 *   · 用该公钥问官方接口拿到权威映射：
 *       GET https://api.revenuecat.com/v1/product_entitlement_mapping
 *       Authorization: Bearer appl_XLnjzAnooYgJCnswSNBaQsnwJrZ
 *     → {"com.kimen.aptvpro.lifetime":{"entitlements":["pro"]}}
 *     即唯一商品是终身买断 lifetime，唯一权益标识是 "pro"。
 *
 * 为什么可以伪造：
 *   · 二进制里没有 setErrorHandler（那 3 处 errorHandler 分别属于
 *     NSFileManager / UISceneGeometry / SwiftUI 的字段元数据，是误报）。
 *   · RevenueCat 官方文档：iOS 5.15+ 默认开启 Trusted Entitlements，
 *     但结果"仅供参考"，SDK 不会自动拒绝未验签数据。
 *   · 读 purchases-ios 源码确认唯一的硬拦截只有一处：
 *       if response.verificationResult.isFailed, case .enforced:
 *           return .failure(.signatureVerificationFailed(...))
 *     即只有在 App 显式配置 .enforced 时请求才会整个失败；
 *     默认的 .informational 会把数据照常交给 App。
 *   · 因此本脚本**不返回 x-signature**（去伪造一个必然验签失败的签名没有意义，
 *     缺签名比错签名更接近"未请求验证"）。
 *
 * 做法：只拦 CustomerInfo 本体 GET /v1/subscribers/<app_user_id>，
 *      /offerings、/product_entitlement_mapping、POST /receipts 等一律放行。
 */

(function () {
    'use strict';

    var ENTITLEMENT   = 'pro';
    var PRODUCT_ID    = 'com.kimen.aptvpro.lifetime';
    var PURCHASE_DATE = '2026-01-01T10:00:00Z';

    function nowISO() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    var url    = ($request && $request.url)    ? String($request.url)    : '';
    var method = ($request && $request.method) ? String($request.method).toUpperCase() : 'GET';

    // 只匹配 CustomerInfo 本体，不吞 /offerings 等子路径
    // 域名白名单不依赖插件的 [Script] 正则：脚本自身也要挡一道，
    // 否则同一路径被别的 App 用到时会被误伤。
    var m = url.match(/^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i);
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
        original_application_version: '1',
        original_purchase_date: PURCHASE_DATE,
        other_purchases: {},
        subscriptions: {}
    };

    // 终身买断：expires_date 为 null 即永久有效
    subscriber.entitlements[ENTITLEMENT] = {
        expires_date: null,
        grace_period_expires_date: null,
        product_identifier: PRODUCT_ID,
        product_plan_identifier: null,
        purchase_date: PURCHASE_DATE,
        is_sandbox: false,
        unsubscribe_detected_at: null,
        billing_issues_detected_at: null,
        ownership_type: 'PURCHASED',
        store: 'app_store'
    };

    // 与商品目录一致：lifetime 属 non_subscriptions，不编造订阅记录
    subscriber.non_subscriptions[PRODUCT_ID] = [{
        id: 'aptv-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: 'aptv-lifetime-0001'
    }];

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
