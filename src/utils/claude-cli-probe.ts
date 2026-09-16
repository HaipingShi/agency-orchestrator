/**
 * 用本机官方 claude CLI 经中转实测一次（Studio「Claude Code 中转」的测试连接兜底）。
 *
 * 为什么需要：有的中转分组**只放行官方 Claude Code 客户端**——PackyCode 的 cc 分组即是。
 * 测试连接原本手搓一个 POST {base}/v1/messages 去探，会被它拒掉（400「非法请求」/「请使用
 * 正确的 Claude Code 客户端」，403「only accessible via the official Claude CLI」），于是界面报失败；
 * 可 claude-code 这条路实际运行时就是 claude CLI 走中转，同一把 key 跑工作流完全正常
 * （2026-09-15 真 key 实测：直连探测 400，claude -p 经中转 5 秒回「你好」）。
 * 所以探测被拒时，用真实客户端再测一次才能下结论。
 *
 * 中转凭据只注入这一个子进程（ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN），不碰用户本机的
 * claude 配置；并剥掉继承来的 ANTHROPIC_API_KEY——它优先级更高，留着会绕过中转去打别处。
 */
import type { ChildProcess } from 'node:child_process';
import { findExecutable, spawnCLI } from '../connectors/spawn-cli.js';

export type ClaudeCliProbeResult =
  | { ok: true; latencyMs: number; output: string }
  | { ok: false; notInstalled?: boolean; error: string };

const NOT_INSTALLED = '本机没有安装 claude（Claude Code CLI），无法用官方客户端实测';

/** 只给这次子进程用的环境：指向中转、带上中转 token，并去掉会抢先生效的 ANTHROPIC_API_KEY */
export function claudeRelayEnv(baseUrl: string, token: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token };
  delete out.ANTHROPIC_API_KEY;
  return out;
}

export function probeClaudeCliViaRelay(opts: {
  baseUrl: string;
  token: string;
  model?: string;
  /** 默认 claude；测试里指向假的可执行文件 */
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeCliProbeResult> {
  const command = opts.command ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const env = claudeRelayEnv(opts.baseUrl, opts.token, opts.env ?? process.env);
  if (!findExecutable(command, env)) return Promise.resolve({ ok: false, notInstalled: true, error: NOT_INSTALLED });
  const args = ['-p', 'hi', ...(opts.model ? ['--model', opts.model] : [])];
  const t0 = Date.now();

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const done = (r: ClaudeCliProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawnCLI(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }, 'Claude Code');
    } catch (e) {
      done({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    timer = setTimeout(() => {
      // 先礼后兵，与 cli-base 同一口径：SIGTERM 不走就 SIGKILL，别把子进程留在那儿
      try { child?.kill('SIGTERM'); } catch { /* 已退出 */ }
      setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* 已退出 */ } }, 5000).unref?.();
      done({ ok: false, error: `claude CLI 实测超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e: NodeJS.ErrnoException) => {
      done(e.code === 'ENOENT' ? { ok: false, notInstalled: true, error: NOT_INSTALLED } : { ok: false, error: e.message });
    });
    child.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text) done({ ok: true, latencyMs: Date.now() - t0, output: text.slice(0, 200) });
      else done({ ok: false, error: (err.trim() || text || `claude CLI 退出码 ${code}`).slice(0, 400) });
    });
  });
}
