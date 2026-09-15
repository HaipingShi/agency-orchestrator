/**
 * NewAPI 系网关（PackyCode 等）账户用量查询 —— 对照 cc-switch「用量查询 · NewAPI 模板」。
 *
 * 钉住三件事：请求形状（站点根 /api/user/self + Bearer 访问令牌 + New-Api-User）、
 * 额度换算（500000 = 1 USD），以及两个最常见的填错（带 /v1 的 base、拿 API Key 当访问令牌）。
 */
import http from 'node:http';
import { newApiOrigin, queryNewApiUsage } from '../src/utils/newapi-usage.js';

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.log(`  ❌ ${m}`); failed++; }
}

console.log('\n─── NewAPI 用量查询（PackyCode 等）───');

assert(newApiOrigin('https://www.packyapi.ai/v1') === 'https://www.packyapi.ai', '带 /v1 的 API base 取站点根');
assert(newApiOrigin('www.packyapi.ai') === 'https://www.packyapi.ai', '只写域名时补 https');
assert(newApiOrigin('') === '', '空地址返回空串');

// 假网关：只认 GET /api/user/self；令牌 tok-ok + 用户 42 才给数据，其余照真网关回 200 + success:false
const seen: { url?: string; auth?: string; user?: string; method?: string }[] = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization, user: req.headers['new-api-user'] as string, method: req.method });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/user/self' && req.headers.authorization === 'Bearer tok-ok' && req.headers['new-api-user'] === '42') {
    res.end(JSON.stringify({ success: true, data: { quota: 1_000_000, used_quota: 500_000, group: 'cc' } }));
    return;
  }
  if (req.url === '/api/user/self-html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>'); return; }
  res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

try {
  const ok = await queryNewApiUsage({ baseUrl: `${base}/v1`, accessToken: 'tok-ok', userId: '42' });
  const last = seen[seen.length - 1];
  assert(last?.url === '/api/user/self' && last.method === 'GET', '请求打到站点根的 GET /api/user/self（base 带 /v1 也不拼进去）');
  assert(last?.auth === 'Bearer tok-ok' && last.user === '42', '带上 Bearer 访问令牌与 New-Api-User 头');
  assert(ok.ok === true, `查通返回 ok（实际 ${JSON.stringify(ok)}）`);
  if (ok.ok) {
    assert(ok.remaining === 2 && ok.used === 1 && ok.total === 3, `额度按 500000 = 1 USD 换算：剩余 2 / 已用 1 / 总额 3（实际 ${ok.remaining}/${ok.used}/${ok.total}）`);
    assert(ok.planName === 'cc' && ok.unit === 'USD', '分组名作为套餐名，单位 USD');
  }

  const bad = await queryNewApiUsage({ baseUrl: base, accessToken: 'tok-wrong', userId: '42' });
  assert(!bad.ok && /access token 无效/.test(bad.error), '网关回 200 + success:false 时如实转述它的 message');
  assert(!bad.ok && !/API Key/.test(bad.error), '不是 sk- 开头时不乱加 API Key 的提示');

  const withKey = await queryNewApiUsage({ baseUrl: base, accessToken: 'sk-f29Z-not-an-access-token', userId: '42' });
  assert(!withKey.ok && /不是 sk- 开头的 API Key/.test(withKey.error), '拿 sk- API Key 当访问令牌时点破（最常见的填错）');

  const before = seen.length;
  const missing = await queryNewApiUsage({ baseUrl: base, accessToken: '', userId: '' });
  assert(!missing.ok && /系统访问令牌/.test(missing.error) && /用户 ID/.test(missing.error), '缺令牌 / 用户 ID 时说清去哪儿拿');
  const badUid = await queryNewApiUsage({ baseUrl: base, accessToken: 'tok-ok', userId: 'abc' });
  assert(!badUid.ok && /纯数字/.test(badUid.error), '用户 ID 不是数字时直接指出');
  assert(seen.length === before, '凭据不全时不发请求');

  const noJson = await queryNewApiUsage({ baseUrl: 'http://127.0.0.1:9/x', accessToken: 'tok-ok', userId: '42', timeoutMs: 3000 });
  assert(!noJson.ok, '端点连不上时返回失败而不是抛异常');
} finally {
  server.close();
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
