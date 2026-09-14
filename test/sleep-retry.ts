/**
 * 系统睡眠打断 LLM 调用：立即重试、不占 retry 名额、封顶、失败提示不再建议"增大超时"。
 *
 * 真机（2026-09-14）：Mac 睡眠冻住了 Claude Code 的请求，引擎按普通超时 600→900→1350s 放宽重试，
 * 两次运行各白等约 95 分钟，失败提示还说"增大超时"。醒着重跑同一步 121s 就过。
 * 真睡眠没法在测试里造，这里把 sleep watcher 换成能手动触发的假货，连接器用"永不返回"模拟被冻住的请求。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow } from '../src/core/parser.js';
import { buildDAG } from '../src/core/dag.js';
import { executeDAG, sleepFailureHint } from '../src/core/executor.js';
import { clockJumpMs, setSleepWatchFactoryForTest, type SleepWatchFactory } from '../src/utils/sleep-watch.js';
import type { LLMConnector, LLMResult, LLMConfig } from '../src/types.js';

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void { if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.log(`  ❌ ${m}`); failed++; } }

console.log('\n─── 系统睡眠打断调用（sleep-retry）───');
process.env.AO_SLEEP_RETRY_DELAY_MS = '10';

// ── 纯函数
assert(clockJumpMs(130_000, 5_000) === 125_000, 'clockJumpMs：墙钟比单调时钟多走的部分 = 睡了多久');
assert(clockJumpMs(5_000, 5_000) === 0, 'clockJumpMs：两者同步 = 没睡');
assert(clockJumpMs(-2_000, 5_000) === 0, 'clockJumpMs：墙钟往回校（NTP）不算睡眠');
assert(sleepFailureHint(30 * 60_000, 'darwin').includes('caffeinate -i'), 'macOS 上提示用 caffeinate -i 保持唤醒');
assert(!sleepFailureHint(30 * 60_000, 'linux').includes('caffeinate'), '非 macOS 不提 caffeinate');
assert(sleepFailureHint(30 * 60_000, 'linux').includes('增大超时没有用'), '睡眠提示明说增大超时没用');

// ── 临时角色库 + 工作流（retry: 0 → 能证明睡眠重试不占名额；timeout: 0 → 不留 30s 的兜底定时器拖住进程）
const dir = mkdtempSync(join(tmpdir(), 'ao-sleep-'));
mkdirSync(join(dir, 'x'), { recursive: true });
writeFileSync(join(dir, 'x', 'y.md'), '---\nname: 测试角色\ndescription: 测试用\n---\n你是测试角色。\n', 'utf-8');
const wfPath = join(dir, 'wf.yaml');
writeFileSync(wfPath, `name: sleep-test
agents_dir: ${dir}
llm:
  provider: deepseek
  model: deepseek-chat
  retry: 0
  timeout: 0
steps:
  - id: a
    role: x/y
    task: 写一句话
    output: out_a
`, 'utf-8');
const wf = parseWorkflow(wfPath);

/** 连接器：前 hangCalls 次调用永不返回（模拟被睡眠冻住的请求），之后返回 ok */
class FrozenThenOk implements LLMConnector {
  calls = 0;
  constructor(private hangCalls: number) {}
  chat(_s: string, _u: string, _c: LLMConfig): Promise<LLMResult> {
    this.calls++;
    if (this.calls <= this.hangCalls) return new Promise<LLMResult>(() => {});
    return Promise.resolve({ content: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
  }
}

/** 假 watcher：shouldSleep(第几个 watcher) 为真时，20ms 后报告"睡了 2 分钟" */
function fakeWatch(shouldSleep: (n: number) => boolean) {
  const stats = { started: 0, stopped: 0 };
  const f: SleepWatchFactory = (onSleep) => {
    const n = ++stats.started;
    const t = shouldSleep(n) ? setTimeout(() => onSleep(120_000), 20) : null;
    return { stop: () => { stats.stopped++; if (t) clearTimeout(t); } };
  };
  return { f, stats };
}

const run = (connector: LLMConnector) => executeDAG(buildDAG(wf), {
  connector, agentsDir: dir, llmConfig: wf.llm, concurrency: 1, inputs: new Map(),
});

// 1) 第一次调用被睡眠打断 → 立即重试成功；retry: 0 也能成功 = 没占名额
{
  const { f, stats } = fakeWatch((n) => n === 1);
  setSleepWatchFactoryForTest(f);
  const conn = new FrozenThenOk(1);
  const t0 = Date.now();
  const r = await run(conn);
  const a = r.steps.find((s) => s.id === 'a');
  assert(a?.status === 'completed' && a.output === 'ok', `睡眠打断后立即重试成功（status=${a?.status}）`);
  assert(conn.calls === 2, `重试了一次（共 ${conn.calls} 次调用）`);
  assert(Date.now() - t0 < 3_000, `没有干等超时（用时 ${Date.now() - t0}ms）`);
  assert(stats.started === stats.stopped, `每次尝试的 watcher 都停掉了（启 ${stats.started} / 停 ${stats.stopped}）`);
}

// 2) 一直在睡（整夜合盖：睡—暗唤醒—再睡）→ 封顶 3 次后直接失败，提示讲睡眠、不建议增大超时
{
  const { f } = fakeWatch(() => true);
  setSleepWatchFactoryForTest(f);
  const conn = new FrozenThenOk(Infinity);
  const r = await run(conn);
  const a = r.steps.find((s) => s.id === 'a');
  assert(a?.status === 'failed', `反复睡眠时步骤失败而不是无限重试（status=${a?.status}）`);
  assert(conn.calls === 4, `1 次 + 3 次睡眠重试后停（共 ${conn.calls} 次调用）`);
  assert(!!a?.error?.includes('💤') && !!a?.error?.includes('睡眠了约 8 分钟'), `错误里讲清睡了多久（${a?.error?.split('\n')[1]?.trim()}）`);
  assert(!a?.error?.includes('1. 增大超时'), '失败提示里不再有"1. 增大超时"那条误导建议');
}

// 3) 没睡 → 行为不变：一次调用成功，watcher 照常启停
{
  const { f, stats } = fakeWatch(() => false);
  setSleepWatchFactoryForTest(f);
  const conn = new FrozenThenOk(0);
  const r = await run(conn);
  assert(r.steps.find((s) => s.id === 'a')?.status === 'completed' && conn.calls === 1, '没睡时一次调用成功，行为不变');
  assert(stats.started === 1 && stats.stopped === 1, 'watcher 启 1 停 1');
}

setSleepWatchFactoryForTest(null);
console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
if (failed > 0) process.exit(1);
