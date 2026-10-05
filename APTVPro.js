/*
 * APTV (com.kimen.aptvpro) —— Pro 解锁脚本（带自证日志版）
 * Target : api.rc-backup.com / api.revenuecat.com   (RevenueCat)
 * Type   : Loon http-response script (requires-body = true)
 *
 * 依据：
 *   · 包体带 RevenueCat_RevenueCat.bundle；RC 公钥与 "https://api.rc-backup.com/"
 *     在 __cstring 里紧邻（App 设了 Purchases.proxyURL），真实流量走反代域名。
 *   · 用该公钥问官方接口拿到权威映射：
 *       GET https://api.revenuecat.com/v1/product_entitlement_mapping
 *       Authorization: Bearer appl_XLnjzAnooYgJCnswSNBaQsnwJrZ
 *     → {"com.kimen.aptvpro.lifetime":{"entitlements":["pro"]}}
 *   · 二进制里 setErrorHandler 出现 0 次；官方文档 + purchases-ios 源码（Signing.swift /
 *     HTTPClient）确认唯一硬拦截是 App 显式配置 .enforced 时把验签失败升级成 NetworkError。
 *
 * 本版新增「自证日志」：
 *   插件的 [Script] 正则放宽到整个 RC 域名，脚本每次被调用都会 console.log 一行。
 *   在 Loon「脚本日志」里搜 APTV-Pro 即可判断卡在哪一步：
 *     · 一条都没有            → MitM 没生效 / 域名没进列表（插件根本没被调用）
 *     · 有 GET /v1/... 但没有 FORGE  → 路径正则没命中，把日志发我
 *     · 出现 [FORGE] 仍未解锁 → 拦截成功，问题在 App 侧（验签策略或别的判定）
 */

(function () {
    'use strict';

    var ENTITLEMENT   = 'pro';
    var PRODUCT_ID    = 'com.kimen.aptvpro.lifetime';
    var PURCHASE_DATE = '2026-01-01T10:00:00Z';
    var HOSTS         = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\//i;
    var TARGET        = /^https?:\/\/(?:api\.rc-backup\.com|api\.revenuecat\.com)\/v1\/subscribers\/([^\/?#]+)(?:[?#].*)?$/i;

    function nowISO() {
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    var url    = ($request && $request.url)    ? String($request.url)    : '';
    var method = ($request && $request.method) ? String($request.method).toUpperCase() : 'GET';

    // 脚本被调用了就留痕，便于在 Loon 脚本日志里定位
    console.log('[APTV-Pro] CALL ' + method + ' ' + url.split('?')[0]);

    if (!HOSTS.test(url)) {
        $done({});
        return;
    }

    var orig = ($response && $response.body) ? String($response.body) : '';
    console.log('[APTV-Pro] RESP status=' + (($response && $response.status) || '?') +
                ' len=' + orig.length + ' head=' + orig.slice(0, 200));

    // 只改 CustomerInfo 本体，其余（/offerings、/product_entitlement_mapping、
    // POST /receipts 等）原样放行
    var m = url.match(TARGET);
    if (!m || method !== 'GET') {
        console.log('[APTV-Pro] PASS');
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

    // 与商品目录保持一致：lifetime 属 non_subscriptions，不编造订阅记录
    subscriber.non_subscriptions[PRODUCT_ID] = [{
        id: 'aptv-lifetime-0001',
        is_sandbox: false,
        purchase_date: PURCHASE_DATE,
        store: 'app_store',
        store_transaction_identifier: 'aptv-lifetime-0001'
    }];

    console.log('[APTV-Pro] FORGE user=' + appUserId);

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
