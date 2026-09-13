/**
 * Studio 的 CLI 输出解析器（web/run-output-parser.js）——用**真 reporter 打印出来的文本**喂它。
 *
 * 真机事故（2026-09-13）：撞 Claude Code 会话额度时，Studio 里失败的步骤显示绿勾、下面挂着
 * "失败: … / 部分失败: 0/2 步" 当正文，整次运行显示「已存入运行历史」、通知报成功，导出的 md 也带着报错。
 * 根因是解析器没有失败 / 跳过 / 部分失败三种行的规则。这里不手写样例行，而是调 reporter 的
 * printStepResult / printSummary 抓 stdout——哪天 reporter 改了打印格式，这个测试当场红，而不是 Studio 悄悄坏。
 */
import { createRunOutputParser, matchStepFailed, matchStepSkipped, matchRunSummary, matchSkippedTail } from '../web/run-output-parser.js';
import { printStepResult, printSummary } from '../src/output/reporter.js';
import type { DAGNode, WorkflowResult } from '../src/types.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
}
function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

/** 抓一段代码打到 console.log / stdout 的全部文本 */
function capture(fn: () => void): string {
  const out: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); };
  (process.stdout as any).write = (chunk: any) => { out.push(String(chunk)); return true; };
  try { fn(); } finally { console.log = origLog; (process.stdout as any).write = origWrite; }
  return out.join('');
}

type Ev = { type: string; data: any };
function parseAll(text: string): Ev[] {
  const events: Ev[] = [];
  const { parseLine } = createRunOutputParser({ send: (type: string, data: any) => events.push({ type, data }), runId: '1' });
  for (const line of text.split('\n')) parseLine(line);
  return events;
}

const node = (p: Partial<DAGNode> & { id: string }): DAGNode => ({
  step: { id: p.id, role: 'academic/academic-narratologist', task: 't', ...(p.step ?? {}) },
  dependencies: [], dependents: [],
  status: 'completed', startTime: 0, endTime: 1200,
  agentName: p.agentName ?? p.id, agentEmoji: '📖',
  ...p,
} as DAGNode);

console.log('\n─── Studio CLI 输出解析（真 reporter 文本）───');

// ── 一次"部分失败"的运行：s1 成功（正文里故意混进像状态行的字），s2 失败（多行原因），
//    s3 因上游失败跳过（真机不走 printStepResult，只在汇总尾部列一次），s4 条件不满足跳过（走 printStepResult）
const S2_ERROR = '请求失败: http://127.0.0.1:9/v1/chat/completions\n  fetch failed\n  可能原因: 无法连接 http://127.0.0.1:9/v1，请检查 base_url 是否正确、网络是否可达';
const partialRun = capture(() => {
  printStepResult(node({
    id: 's1', agentName: '叙事学家', tokenUsage: { input: 100, output: 200 },
    result: '第一段正文。\n失败: 这是正文里写的字，不是状态行\n完成: 3/3 步 也是正文\n跳过 (也是正文)',
  }), 1, 3);
  printStepResult(node({ id: 's2', agentName: '心理学家', status: 'failed', error: S2_ERROR }), 2, 4);
  printStepResult(node({ id: 's4', agentName: '可选配图', status: 'skipped', step: { id: 's4', role: 'r', task: 't', condition: '{{x}} contains y' } as any }), 3, 4);
  const result: WorkflowResult = {
    name: 'x', success: false, totalDuration: 5900, totalTokens: { input: 100, output: 200 },
    steps: [
      { id: 's1', role: 'r', status: 'completed', output: 'o', duration: 1200, tokens: { input: 100, output: 200 } },
      { id: 's2', role: 'r', status: 'failed', error: 'e', duration: 0, tokens: { input: 0, output: 0 } },
      { id: 's3', role: 'r', status: 'skipped', duration: 0, tokens: { input: 0, output: 0 } },
      { id: 's4', role: 'r', status: 'skipped', duration: 0, tokens: { input: 0, output: 0 } },
    ] as any,
  };
  printSummary(result, 'ao-output/x-2026-09-13T05-10-55', 'workflows/x.yaml');
});
const ev = parseAll(partialRun);
const of = (type: string) => ev.filter((e) => e.type === type);

test('reporter 真的打出了失败 / 跳过 / 部分失败三种行（前提成立，否则下面的断言没意义）', () => {
  assert(/\n {2}失败: 请求失败: /.test(partialRun), '没打出"  失败:"行');
  assert(/\n {2}跳过 \(条件不满足\)/.test(partialRun), '没打出"  跳过 (条件不满足)"行');
  assert(/\n {2}部分失败: 1\/4 步/.test(partialRun), '没打出"  部分失败: 1/4 步"行');
  assert(/\n {2}\u23ED\uFE0F? +跳过 2 步: s3, s4/.test(partialRun), '没打出汇总尾部"⏭️  跳过 2 步: s3, s4"行');
});

test('走 printStepResult 的三步都识别到了 header（上游跳过的 s3 本来就没有 header）', () => {
  assert(of('step-header').map((e) => e.data.id).join() === 's1,s2,s4', JSON.stringify(of('step-header').map((e) => e.data.id)));
});

test('s1 成功：step-done + 正文完整，正文里像状态行的字仍是正文', () => {
  assert(of('step-done').length === 1 && of('step-done')[0].data.id === 's1', 'step-done 应只有 s1');
  const body = of('step-content').filter((e) => e.data.id === 's1').map((e) => e.data.text).join('\n');
  assert(body.includes('第一段正文。'), 's1 正文缺第一段');
  assert(body.includes('失败: 这是正文里写的字'), '正文里的"失败:"被误判成状态行了');
  assert(body.includes('完成: 3/3 步 也是正文'), '正文里的"完成: 3/3 步"被误判成汇总行了');
  assert(body.includes('跳过 (也是正文)'), '正文里的"跳过 (…)"被误判成跳过行了');
});

test('s2 失败：发 step-failed，多行原因全部并进 error（最后一次事件带全文），且不进任何步骤正文', () => {
  const f = of('step-failed');
  assert(f.length > 0 && f.every((e) => e.data.id === 's2'), `step-failed 应只属于 s2，实际 ${JSON.stringify(f)}`);
  const last = f[f.length - 1].data.error;
  assert(last.startsWith('请求失败: http://127.0.0.1:9/v1/chat/completions'), `第一行不对：${last}`);
  assert(last.includes('fetch failed') && last.includes('可能原因: 无法连接'), `续行没并进来（真正有用的提示在续行里）：${last}`);
  const leaked = of('step-content').filter((e) => /fetch failed|可能原因|请求失败|部分失败/.test(e.data.text));
  assert(leaked.length === 0, `报错 / 汇总行混进了正文：${JSON.stringify(leaked)}`);
  assert(!of('step-content').some((e) => e.data.id === 's2'), 's2 不该有任何正文');
});

test('跳过：条件跳过的 s4 带「条件不满足」；上游跳过的 s3 从汇总尾部识别出来；都不算失败', () => {
  const s = of('step-skipped');
  const s4 = s.filter((e) => e.data.id === 's4');
  assert(s4.length >= 1 && s4[0].data.reason === '条件不满足', `s4 首个事件应带条件原因：${JSON.stringify(s4)}`);
  assert(s4.slice(1).every((e) => !e.data.reason), '汇总尾部那次不能带原因（否则会把"条件不满足"覆盖成空 / 上游失败）');
  assert(s.some((e) => e.data.id === 's3'), `上游跳过的 s3 没识别出来：${JSON.stringify(s)}`);
  assert(!of('step-failed').some((e) => e.data.id === 's3' || e.data.id === 's4'), '跳过不能发成失败');
});

test('汇总：部分失败 → workflow-summary ok=false；输出目录单独发 output-dir', () => {
  const sum = of('workflow-summary');
  assert(sum.length === 1 && sum[0].data.ok === false && sum[0].data.text.startsWith('部分失败: 1/4 步'), JSON.stringify(sum));
  const od = of('output-dir');
  assert(od.length === 1 && od[0].data.dir === 'ao-output/x-2026-09-13T05-10-55', JSON.stringify(od));
});

test('汇总之后的提示行（💡 从失败处继续 / 命令）不挂到任何步骤名下', () => {
  const idx = ev.findIndex((e) => e.type === 'workflow-summary');
  const after = ev.slice(idx + 1).filter((e) => e.type === 'step-content');
  assert(after.length === 0, `汇总后还有正文事件：${JSON.stringify(after.slice(0, 3))}`);
});

// ── 验收未过的条目：中文 "验收 ⚠️" 与英文 "Acceptance ⚠️" 两种（英文模板真跑时 reporter 打的是后者）
for (const [label, agentName, result] of [
  ['中文', '执笔作者', '她把伞塞进少年手里。'],
  ['English', 'Writer', 'She pressed the umbrella into his hands.'],
] as const) {
  test(`验收未过（${label}）：⚠️ 条目发 step-verify-item，不进正文；正文照常`, () => {
    const text = capture(() => {
      printStepResult(node({
        id: 'w', agentName, result,
        verification: { pass: false, failed: ['条目一 / criterion one', '条目二 / criterion two'], reworked: true },
      }), 1, 1);
    });
    assert(label === '中文' ? /验收 ⚠️/.test(text) : /Acceptance ⚠️ 2 unmet/.test(text), `reporter 没按预期语言打验收行：${text.slice(0, 200)}`);
    const e = parseAll(text);
    const items = e.filter((x) => x.type === 'step-verify-item').map((x) => x.data.text);
    assert(items.length === 2 && items[0].startsWith('条目一'), `应识别 2 条未满足条目，实际 ${JSON.stringify(items)}`);
    const body = e.filter((x) => x.type === 'step-content').map((x) => x.data.text).join('\n');
    assert(!/条目一|criterion/.test(body), `未满足条目混进了正文：${body}`);
    assert(body.includes(result), '正文丢了');
  });
}

// ── 全部成功的运行
test('全部成功：workflow-summary ok=true，没有 step-failed', () => {
  const okRun = capture(() => {
    printStepResult(node({ id: 'a', result: '正文' }), 1, 1);
    printSummary({ name: 'y', success: true, totalDuration: 1000, totalTokens: { input: 1, output: 1 },
      steps: [{ id: 'a', role: 'r', status: 'completed', output: '正文', duration: 1000, tokens: { input: 1, output: 1 } }] as any }, 'ao-output/y', 'workflows/y.yaml');
  });
  const e2 = parseAll(okRun);
  const sum = e2.filter((e) => e.type === 'workflow-summary');
  assert(sum.length === 1 && sum[0].data.ok === true, JSON.stringify(sum));
  assert(!e2.some((e) => e.type === 'step-failed'), '成功运行不该有 step-failed');
  assert(e2.filter((e) => e.type === 'step-content').map((e) => e.data.text).join('').includes('正文'), '正文丢了');
});

// ── 单角色咨询也用这几个匹配函数
test('匹配函数只认 ≤2 格缩进的状态行，4 格缩进的正文不认', () => {
  assert(matchStepFailed('  失败: boom') === 'boom', 'failed');
  assert(matchStepFailed('    失败: boom') === null, '4 格缩进是正文');
  assert(matchStepFailed('\x1b[31m  失败: boom\x1b[0m') === 'boom', '带 ANSI 颜色也要认');
  assert(matchStepSkipped('  跳过 (条件不满足)') === '条件不满足', 'skipped');
  assert(matchRunSummary('  完成: 5/5 步 | 1.0s | 10 tokens')?.ok === true, 'summary ok');
  assert(matchRunSummary('    完成: 5/5 步') === null, '4 格缩进的"完成: 5/5 步"是正文');
  assert(JSON.stringify(matchSkippedTail('  \u23ED\uFE0F  跳过 2 步: b, c')) === '["b","c"]', 'skipped tail');
  assert(matchSkippedTail('    \u23ED\uFE0F  跳过 2 步: b, c') === null, '4 格缩进的是正文');
});

console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
if (failed > 0) process.exit(1);
