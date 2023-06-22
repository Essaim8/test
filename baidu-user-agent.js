var modifiedHeaders = $request.headers;

modifiedHeaders['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SearchCraft/3.9.0 (Baidu; P2 16.3)';

$done({ headers: modifiedHeaders });
