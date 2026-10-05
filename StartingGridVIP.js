/*
 * 发车格 / StartingGrid (com.f1.push.ios) —— 会员解锁脚本
 * Target : api.f1push.com
 * Type   : Loon http-response script (requires-body = true)
 *
 * 服务端响应本身是 AES-256-GCM 信封（{"alg":"A256GCM","iv":..,"payload":..}），
 * 但客户端的解码器 F1_HttpManager
 *   -[F1_HttpManager decodedJSONObjectForRequest:ytkRequest:]
 * 只有在「body 是信封」或「响应头 X-F1-Crypto-Response: 1」时才走解密分支；
 * 两者都不满足时直接返回 [response responseJSONObject]（明文 JSON）。
 *
 * 所以本脚本只需返回明文 JSON，并把响应头整体替换掉（顺带抹去
 * X-F1-Crypto-Response），客户端就会把它当成正常业务响应。
 * 唯一的硬性要求：必须带 Content-Type: application/json，
 * 否则 AFJSONResponseSerializer 校验失败，responseJSONObject 会是 nil。
 */

(function () {
    'use strict';

    // 会员到期时间（ISO8601 UTC）。App 用 yyyy-MM-dd'T'HH:mm:ss'Z' 解析；
    // 即使解析失败 expireDate 返回 nil，isActiveNow 依旧判定为有效。
    var EXPIRE_AT = '2099-12-31T23:59:59Z';

    var PRODUCT_ID = 'com.f1.push.ios.iap.year';

    function nowISO() {
        var s = new Date().toISOString();               // 2026-..T..:..:...123Z
        return s.replace(/\.\d{3}Z$/, 'Z');             // 去掉毫秒，匹配 App 格式
    }

    function buildMembership() {
        var t = nowISO();
        return {
            // ---- F1_AccountMembershipModel 直接映射字段 ----
            active: true,
            isAutoRenew: true,
            source: 'appstore',
            serverTime: t,
            expiresAt: EXPIRE_AT,
            isLifetime: false,

            // 别名（App 用 stringValueFromSources:keys: 同时尝试 camel / snake）
            is_active: true,
            is_auto_renew: true,
            expires_at: EXPIRE_AT,
            expireAt: EXPIRE_AT,
            expire_at: EXPIRE_AT,
            is_lifetime: false,

            // ---- 展示用子对象 ----
            level: {
                code: 'pro',
                planCode: 'year',
                name: '发车格 PRO'
            },
            plan: {
                code: 'year',
                planCode: 'year',
                name: '年度会员',
                planName: '年度会员',
                billingPeriod: 'yearly',
                durationType: 'year',
                subscriptionType: 'year',
                isLifetime: false
            },
            product: {
                productId: PRODUCT_ID,
                productCode: 'year',
                productName: '发车格年度会员',
                appleProductId: PRODUCT_ID,
                revenueCatProductId: PRODUCT_ID,
                purchaseType: 'subscription',
                isLifetime: false
            },
            subscription: {
                status: 'active',
                planCode: 'year',
                productId: PRODUCT_ID,
                isActive: true,
                isAutoRenew: true,
                expiresAt: EXPIRE_AT,
                platform: 'ios'
            },
            entitlements: ['pro', 'vip'],
            features: ['widget', 'ranking', 'career', 'team_manager', 'rating', 'theme_icon'],

            // 原始数据（App 会整体落盘到 MMKV: kF1MembershipStatusKey）
            rawData: {
                active: true,
                isAutoRenew: true,
                source: 'appstore',
                serverTime: t,
                expiresAt: EXPIRE_AT,
                platform: 'ios',
                productId: PRODUCT_ID
            }
        };
    }

    function envelope(data) {
        // F1_HttpResponse: success / code / msg / data
        // +[F1_AccountAPIClient responseIsSuccessful:] 判定: success==YES 或 code==200
        return {
            success: true,
            code: 200,
            msg: 'ok',
            message: 'ok',
            data: data
        };
    }

    function reply(obj) {
        $done({
            status: 200,
            // 显式给出 headers 会整体替换原响应头：
            // 1) 抹掉 X-F1-Crypto-Response，避免客户端走解密分支
            // 2) 必须保留 application/json，AFJSONResponseSerializer 才会解析
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(obj)
        });
    }

    var url = ($request && $request.url) ? String($request.url) : '';
    var path = url.split('?')[0].split('#')[0].replace(/\/+$/, '');

    // 1) GET /api/v1/membership/status  -> data 直接就是会员对象
    if (/\/api\/v1\/membership\/status$/i.test(path)) {
        reply(envelope(buildMembership()));
        return;
    }

    // 2) POST /api/v1/membership/ios/sync -> data 是 F1_IOSMembershipSyncModel
    //    客户端成功回调里会 saveMembership:model.membership，会覆盖缓存，
    //    所以这里也必须返回有效会员，避免自动同步把状态刷回去。
    if (/\/api\/v1\/membership\/ios\/sync$/i.test(path)) {
        reply(envelope({
            synced: true,
            iosSubscriptionFound: true,
            iosBindingStatus: 'bound',
            membership: buildMembership()
        }));
        return;
    }

    // 3) GET /api/v1/users/me -> 在 data 里补一个 membership 对象。
    //    -[F1_AccountAPIClient membershipDictionaryFromResponseData:]
    //    按 membership / memberShip / subscription / vip / entitlement 顺序取第一个非空字典。
    if (/\/api\/v1\/users\/me$/i.test(path)) {
        var obj = null;
        try {
            obj = JSON.parse($response.body);
        } catch (e) {
            obj = null;
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            $done({});          // 解析不了就放行，交给 App 原生逻辑
            return;
        }
        if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
            obj.data = {};
        }
        var m = buildMembership();
        obj.data.membership = m;
        obj.data.memberShip = m;
        obj.success = true;
        obj.code = 200;
        if (!obj.msg) { obj.msg = 'ok'; }
        reply(obj);
        return;
    }

    // 其它请求原样放行
    $done({});
})();
