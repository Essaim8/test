/*
 * Slidebox (co.slidebox.Slidebox) —— Pro 解锁脚本
 * Target : firebaseremoteconfig.googleapis.com   (Firebase Remote Config)
 * Type   : Loon http-response script (requires-body = true)
 *
 * 为什么是这个口子（逆向结论）：
 *   采购判定在 -[SBXPremiumLogic hasPremiumAccessWithStoreModel:developerModel:]：
 *       if ([developerModel forceNonPremiumOverride]) return NO;
 *       return [storeModel hasActivePremiumEntitlement];      // 看本地 Keychain 里的购买凭证
 *   但几乎所有业务侧的门禁写成：
 *       BOOL ok = [SBXPremiumLogic hasPremiumAccessWithStoreModel:store developerModel:dev];
 *       BOOL forced = [[self configModel] forcePremiumEnabled];      // ← 这里
 *       if (ok || forced) { ...解锁分支... }
 *
 *   -[SBXConfigModel forcePremiumEnabled] 的实现（0x1001b15a0）：
 *       if ([SBXAppOverride overrideConfigModelForcePremiumEnabled_TRUE]) return YES;
 *       return [[self.firebaseRemoteConfig configValueForKey:@"ios_force_premium_enabled"] boolValue];
 *
 *   "ios_force_premium_enabled" 就在 App 的远程配置键表里（同表还有
 *   ios_premium_product_v2_enabled 等 30 多个键），并且
 *   -[SBXConfigModel sync] 会走 [firebaseRemoteConfig fetchWithExpirationDuration:completionHandler:]
 *   把它从网上拉下来再 activate。→ 改这一条网络响应就能强开 Premium。
 *
 * 做法：不伪造任何“购买”，只把远端配置里那条开关置为 true，
 *       其余所有配置项原样保留，避免影响其它功能。
 */

(function () {
    'use strict';

    var KEY   = 'ios_force_premium_enabled';
    var HOST  = /^https?:\/\/firebaseremoteconfig\.googleapis\.com\//i;

    var url = ($request && $request.url) ? String($request.url) : '';
    if (!HOST.test(url)) {
        $done({});
        return;
    }

    var raw = $response ? $response.body : null;
    if (!raw || typeof raw !== 'string') {
        $done({});
        return;
    }

    var obj;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        $done({});              // 不是 JSON 就原样放行
        return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        $done({});
        return;
    }

    if (!obj.entries || typeof obj.entries !== 'object' || Array.isArray(obj.entries)) {
        obj.entries = {};
    }
    obj.entries[KEY] = 'true';
    // NO_CHANGE 会被 SDK 忽略，强制成 UPDATE 才会应用 entries
    obj.state = 'UPDATE';

    var headers = {};
    var src = ($response && $response.headers) ? $response.headers : {};
    for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        var lk = String(k).toLowerCase();
        if (lk === 'content-length' || lk === 'content-encoding' || lk === 'content-type') continue;
        headers[k] = src[k];
    }
    headers['Content-Type'] = 'application/json; charset=utf-8';

    $done({
        status: 200,
        headers: headers,
        body: JSON.stringify(obj)
    });
})();
