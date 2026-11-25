/*
 * GoogleAIUltra.js  —  Loon http-response 脚本
 *
 * 作用：把 Google One「AI 方案」接口 (one.google.com/ai?*) 的响应体里的
 *       Ultra 标准套餐代码，替换成带「1 个月免费试用」的收购(acq)代码。
 *       等同于视频里 ProxyPin 的「响应体 → 文本替换」规则。
 *
 * 视频原始规则：
 *   URL   : https://one.google.com/ai?*
 *   匹配  : g1.ios.20tb.m.v2
 *   替换为: g1.ai.ultra.1month_eft.acq
 *
 * 说明：套餐代码会随地区/时间变化。若替换后不出现免费试用，
 *       先装 GoogleAIUltra-Diag.js 抓一次真实响应，把下面 FROM 改成真实的套餐代码。
 */

(function () {
  var url = ($request && $request.url) || "";

  // 二次 host 白名单：只处理 one.google.com 的 /ai 接口，避免误伤同路径的其它域名
  if (!/^https?:\/\/one\.google\.com\/ai(\?|$)/i.test(url)) {
    $done({});
    return;
  }

  var body = ($response && typeof $response.body === "string") ? $response.body : null;
  if (!body) { $done({}); return; }        // 无 body（如图片/空响应）直接放行

  var FROM = "g1.ios.20tb.m.v2";           // ← 原套餐代码（按需改成真实值）
  var TO   = "g1.ai.ultra.1month_eft.acq"; // ← 1 个月免费试用收购代码

  if (body.indexOf(FROM) === -1) { $done({}); return; } // 没命中就原样放行

  body = body.split(FROM).join(TO);        // 全部替换
  $done({ body: body });
})();
