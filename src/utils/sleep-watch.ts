/**
 * 检测系统睡眠（合盖 / 自动睡眠）。
 *
 * 真机（2026-09-14）：英文中篇的连贯性审校跑到一半 Mac 进了睡眠，Claude Code 的请求连接被冻住。醒来后引擎
 * 把它当成普通超时，600s → 900s → 1350s 逐次放宽再重试，两次运行各白等约 95 分钟，失败提示还建议"增大超时"——
 * 恰恰是错的方向（pmset 日志证实整夜 Sleep / DarkWake）。醒着重跑同一步 121s 就过。
 *
 * 判据：墙钟（Date.now）在睡眠期间照走；libuv 定时器与 performance.now 在 macOS / Linux 睡眠期间停摆。
 * 每个 tick 比较两者的增量，墙钟多走的部分超过阈值 = 刚睡过。若某平台两者在睡眠期间都走（检测不到），
 * 就退回原来的超时重试，行为不会比以前更糟。
 */

/** 墙钟比单调时钟多走的毫秒数（负数按 0：NTP 往回校时不算睡眠） */
export function clockJumpMs(wallDeltaMs: number, monoDeltaMs: number): number {
  return Math.max(0, Math.round(wallDeltaMs - monoDeltaMs));
}

/** 睡过多久才算"睡眠打断"。短于这个的抖动（GC、系统繁忙、NTP 小步校时）不理 */
export const SLEEP_THRESHOLD_MS = 60_000;
const TICK_MS = 5_000;

export interface SleepWatch {
  stop(): void;
}
export type SleepWatchFactory = (onSleep: (sleptMs: number) => void) => SleepWatch;

const realSleepWatch: SleepWatchFactory = (onSleep) => {
  let wall = Date.now();
  let mono = performance.now();
  const timer = setInterval(() => {
    const w = Date.now();
    const m = performance.now();
    const jump = clockJumpMs(w - wall, m - mono);
    wall = w;
    mono = m;
    if (jump >= SLEEP_THRESHOLD_MS) onSleep(jump);
  }, TICK_MS);
  // 不能因为这个 watcher 让进程在步骤结束后还挂着
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
};

let factory: SleepWatchFactory = realSleepWatch;

/** 测试用：换成能手动触发"睡了一觉"的假 watcher；传 null 还原 */
export function setSleepWatchFactoryForTest(f: SleepWatchFactory | null): void {
  factory = f ?? realSleepWatch;
}

export function startSleepWatch(onSleep: (sleptMs: number) => void): SleepWatch {
  return factory(onSleep);
}
