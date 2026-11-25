/*
 * GoogleAIUltra-Diag.js  —  只读取证脚本（不改响应）
 *
 * 用途：不确定当前地区/账号的套餐代码时，先用它抓一次真实的
 *       one.google.com/ai?* 响应，把里面的 g1.* 代码打到 Loon 脚本日志，
 *       再把 GoogleAIUltra.js 里的 FROM 改成真实代码。
 *
 * 用法：在插件里把 [Script] 那一行的 script-path 换成本文件后运行一次，
 *       打开 Loon → 脚本日志，查找 "[G1Diag]" 开头的行。
 */

(function () {
  var url = ($request && $request.url) || "";
  if (!/^https?:\/\/one\.google\.com\/ai(\?|$)/i.test(url)) { $done({}); return; }

  var body = ($response && typeof $response.body === "string") ? $response.body : "";
  var codes = body.match(/g1\.[A-Za-z0-9_.]+/g) || [];
  var uniq = [];
  for (var i = 0; i < codes.length; i++) { if (uniq.indexOf(codes[i]) === -1) uniq.push(codes[i]); }

  console.log("[G1Diag] " + (($request && $request.method) || "") + " " + url);
  console.log("[G1Diag] len=" + body.length + " codes=" + JSON.stringify(uniq));
  // 顺便看看是否有 1month / eft / acq 相关字样
  var hit = body.match(/[A-Za-z0-9_.]*(?:1month|eft|acq|trial)[A-Za-z0-9_.]*/gi) || [];
  console.log("[G1Diag] trialish=" + JSON.stringify(hit.slice(0, 20)));

  $done({}); // 不改动
})();
