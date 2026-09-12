/**
 * Claude API 连接器 · max_tokens 自动续写（回归）
 * 场景：第 1 轮 stop_reason=max_tokens → 连接器带着已写内容再请求；第 2 轮 end_turn → 拼成完整正文。
 * 修复前：只发一次请求，截断的半篇小说被当作"完成"交给下游。
 * 还要验：续写请求里必须带 assistant(已写内容) + user(继续) 两条消息；正常结束不多发请求。
 */
import http from 'node:http';
import { ClaudeConnector } from '../src/connectors/claude.js';

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.log(`  ❌ ${m}`); failed++; }
}

console.log('\n─── Claude 连接器 · max_tokens 自动续写 ───');

const PART1 = '第一段'.repeat(100);
const PART2 = '第二段'.repeat(50);
const bodies: any[] = [];
let mode: 'truncate-once' | 'clean' | 'always-truncate' = 'truncate-once';
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = JSON.parse(b);
    bodies.push(body);
    const n = bodies.length;
    const reply = (text: string, stop: string) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: stop, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      }));
    };
    if (mode === 'clean') return reply(PART1, 'end_turn');
    if (mode === 'always-truncate') return reply(PART1, 'max_tokens');
    return n === 1 ? reply(PART1, 'max_tokens') : reply(PART2, 'end_turn');
  });
});

await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const port = (srv.address() as any).port;
const conn = new ClaudeConnector('k', `http://127.0.0.1:${port}`);
const cfg = { provider: 'claude' as const, model: 'claude-sonnet-5', max_tokens: 50 };

// 1) 截断一次 → 续写一次 → 拼接
const r1 = await conn.chat('sys', 'write', cfg);
assert(bodies.length === 2, `命中 max_tokens 应发生续写（2 次请求），实际 ${bodies.length}`);
assert(r1.content === PART1 + PART2, `两轮内容应拼接（长度 ${r1.content.length}）`);
assert(r1.usage.output_tokens === 40 && r1.usage.input_tokens === 20, `usage 应累加两轮（实际 in=${r1.usage.input_tokens} out=${r1.usage.output_tokens}）`);
const second = bodies[1];
assert(Array.isArray(second.messages) && second.messages.length === 3, `续写请求应带 3 条消息（user/assistant/user），实际 ${second.messages?.length}`);
assert(second.messages?.[1]?.role === 'assistant' && second.messages[1].content === PART1, '续写请求第 2 条应是 assistant(已写内容)');
assert(second.messages?.[2]?.role === 'user' && /继续/.test(String(second.messages[2].content)), '续写请求第 3 条应是 user(继续)');
assert(second.system === 'sys' && second.max_tokens === 50, 'system / max_tokens 在续写轮保持不变');

// 2) 正常结束 → 只发一次
bodies.length = 0; mode = 'clean';
const r2 = await conn.chat('sys', 'write', cfg);
assert(bodies.length === 1 && r2.content === PART1, `end_turn 不应续写（请求数 ${bodies.length}）`);

// 3) 一直截断 → 最多续写 3 次（共 4 次请求）后返回，不能死循环
bodies.length = 0; mode = 'always-truncate';
const r3 = await conn.chat('sys', 'write', cfg);
assert(bodies.length === 4, `一直 max_tokens 时最多 1+3 次请求，实际 ${bodies.length}`);
assert(r3.content.length === PART1.length * 4, '4 轮内容全部保留');

srv.close();
console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
if (failed > 0) process.exit(1);
