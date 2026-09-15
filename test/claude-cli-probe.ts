/**
 * Studio「Claude Code 中转」测试连接的兜底：直连探测被中转拒绝时，用本机 claude CLI 经中转实测。
 *
 * 用假的 claude 脚本（放进临时 PATH）钉住：中转凭据只注入子进程、ANTHROPIC_API_KEY 被剥掉、
 * 参数形状、失败原因透传、没装 CLI 与超时的区分。不花 token、不联网。
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { claudeRelayEnv, probeClaudeCliViaRelay } from '../src/utils/claude-cli-probe.js';

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.log(`  ❌ ${m}`); failed++; }
}

console.log('\n─── claude CLI 经中转实测（测试连接兜底）───');

const env0 = claudeRelayEnv('https://relay.example', 'tok-1', { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-official', HOME: '/h' });
assert(env0.ANTHROPIC_BASE_URL === 'https://relay.example' && env0.ANTHROPIC_AUTH_TOKEN === 'tok-1', '子进程环境指向中转并带上中转 token');
assert(env0.ANTHROPIC_API_KEY === undefined, '剥掉继承来的 ANTHROPIC_API_KEY（它优先级更高，会绕过中转）');
assert(env0.HOME === '/h' && env0.PATH === '/bin', '其余环境变量原样保留');

if (process.platform === 'win32') {
  console.log('  （Windows 下跳过假 CLI 用例：依赖 POSIX shell 脚本）');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'ao-claude-probe-'));
  const bin = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`, 'utf-8');
    chmodSync(p, 0o755);
    return name;
  };
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, ANTHROPIC_API_KEY: 'sk-should-be-dropped' };
  try {
    bin('fake-claude-ok', 'echo "base=$ANTHROPIC_BASE_URL token=$ANTHROPIC_AUTH_TOKEN apikey=${ANTHROPIC_API_KEY:-none} args=$*"');
    const ok = await probeClaudeCliViaRelay({ baseUrl: 'https://www.packyapi.ai', token: 'sk-cc', model: 'claude-sonnet-5', command: 'fake-claude-ok', env });
    assert(ok.ok === true, `CLI 退出码 0 且有输出 → 通过（实际 ${JSON.stringify(ok)}）`);
    if (ok.ok) {
      assert(/base=https:\/\/www\.packyapi\.ai token=sk-cc/.test(ok.output), '中转地址与 token 送达子进程');
      assert(/apikey=none/.test(ok.output), '子进程里看不到 ANTHROPIC_API_KEY');
      assert(/args=-p hi --model claude-sonnet-5/.test(ok.output), '参数形状：-p hi --model <模型>');
    }

    bin('fake-claude-fail', 'echo "Invalid API key · Please run /login" 1>&2; exit 1');
    const bad = await probeClaudeCliViaRelay({ baseUrl: 'https://x', token: 't', command: 'fake-claude-fail', env });
    assert(!bad.ok && !bad.notInstalled && /Invalid API key/.test(bad.error), '失败时把 CLI 的报错原样带回来');

    bin('fake-claude-empty', 'exit 0');
    const empty = await probeClaudeCliViaRelay({ baseUrl: 'https://x', token: 't', command: 'fake-claude-empty', env });
    assert(!empty.ok, '退出码 0 但没有任何输出不算通过');

    const missing = await probeClaudeCliViaRelay({ baseUrl: 'https://x', token: 't', command: 'ao-no-such-claude-cli', env });
    assert(!missing.ok && missing.notInstalled === true, '没装 CLI 时标 notInstalled，与"测了但失败"区分开');

    bin('fake-claude-slow', 'sleep 5; echo late');
    const slow = await probeClaudeCliViaRelay({ baseUrl: 'https://x', token: 't', command: 'fake-claude-slow', env, timeoutMs: 400 });
    assert(!slow.ok && /超时/.test(slow.error), '卡住的 CLI 按超时结束，不把测试连接挂死');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
