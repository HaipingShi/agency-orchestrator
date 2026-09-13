/**
 * `ao run` 的终端输出 → Studio 的结构化 SSE 事件（web/server.js 的 /api/run 用；单角色咨询借用其中的匹配函数）。
 *
 * 为什么单拎出来：这是一组按行匹配的正则，依赖 src/output/reporter.ts 的打印格式，改一边另一边就悄悄坏。
 * 以前内联在 server.js 里没法测，结果「失败: …」「跳过 (…)」「部分失败: n/m 步」三种行都没有规则，
 * 全被当成上一步的正文收进去——Studio 里失败的步骤显示成绿勾 + 一段报错"正文"，整次运行因为"有内容"
 * 被判成「已完成」，导出的 md 里也带着报错（2026-09-13 撞 Claude Code 会话额度时真机看到）。
 * test/run-output-parser.ts 用真 reporter 打印出来的文本喂这里，格式漂移会当场红。
 */

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const plain = (raw) => raw.replace(ANSI, '').replace(/\r/g, '');

// reporter 的状态行缩进 2 格，步骤正文缩进 4 格——下面三个只认 ≤2 格的行，
// 正文里恰好写着「失败: …」「完成: 3/3 步」不会被误判成状态行。

/** 步骤失败行 "  失败: <原因>" → 原因文本；不是则 null */
export function matchStepFailed(raw) {
  const m = plain(raw).match(/^ {0,2}失败[:：]\s*(.*?)\s*$/);
  return m ? m[1] : null;
}

/** 步骤跳过行 "  跳过 (条件不满足)" → 原因；不是则 null */
export function matchStepSkipped(raw) {
  const m = plain(raw).match(/^ {0,2}跳过\s*[(（]\s*(.+?)\s*[)）]\s*$/);
  return m ? m[1] : null;
}

/** 全流程汇总行：成功 "完成: 5/5 步 | …"，有步骤失败 "部分失败: 3/5 步 | …" */
export function matchRunSummary(raw) {
  const line = plain(raw);
  const m = line.match(/^ {0,2}(完成|部分失败)[:：]\s*\d+\/\d+\s*步/);
  return m ? { ok: m[1] === '完成', text: line.trim() } : null;
}

/**
 * 汇总尾部的 "  ⏭️  跳过 2 步: b, c" → ['b', 'c']；不是则 null。
 * 因**上游失败**被跳过的步骤不走 printStepResult（executor 的 markDownstreamSkipped 直接改状态，不进批次），
 * 没有 header、没有"跳过 (…)"行，只在这里出现一次——不认这行，Studio 里它们永远停在"待运行"。
 */
export function matchSkippedTail(raw) {
  const m = plain(raw).match(/^ {0,2}⏭️?\s*跳过\s*\d+\s*步[:：]\s*(.+?)\s*$/);
  return m ? m[1].split(/\s*,\s*/).filter(Boolean) : null;
}

/**
 * 有状态的逐行解析器：记住"当前正文属于哪一步"。
 * @param {{ send: (type: string, data: object) => void, runId?: string, resolveOutputDir?: (p: string) => string }} opts
 */
export function createRunOutputParser({ send, runId, resolveOutputDir = (p) => p }) {
  let currentStepId = null;
  // 验收未过时，"完成 | … | 验收 ⚠️" 行之后紧跟若干 "⚠️ 未满足条目" 行——
  // 它们是核验详情而非步骤产出，转成 step-verify-item 事件，别混进正文。
  let inVerifyItems = false;
  // 失败原因常常是多行（"请求失败: <url>" 之后跟 "fetch failed" "可能原因: …" "走了代理…"），
  // 真正有用的是后面几行。记住正在收哪一步的报错，直到空行 / 下一个 header 为止。
  let failedStepId = null;
  let failedError = '';

  function parseLine(raw) {
    const clean = plain(raw).trim();
    // ⚠️ 条目紧贴"完成 | … | 验收 ⚠️"行连续打印，首个空行即正文分界——
    // 空行必须关闭 verify-item 窗口，否则正文里以 ⚠️ 开头的行会被误吞成核验条目
    if (!clean) { inVerifyItems = false; failedStepId = null; return; }

    // human_input / approval 节点暂停等待输入：引擎在 AO_WEB_INPUT 模式下发的机器标记。
    // 转成 await-input 事件，前端弹框，用户输入经 POST /api/run-input 写回子进程 stdin。
    const inputReq = clean.match(/^__AO_INPUT_REQUEST__(\{.*\})$/);
    if (inputReq) {
      try { send('await-input', { runId, ...JSON.parse(inputReq[1]) }); } catch { /* ignore malformed */ }
      return;
    }
    // 开跑前的媒体花费预览（几条片 × 几秒 × 哪档）：引擎在 web 模式下发的机器标记，前端在步骤上方展示
    const preflight = clean.match(/^__AO_PREFLIGHT__(\{.*\})$/);
    if (preflight) {
      try { send('preflight', JSON.parse(preflight[1])); } catch { /* ignore malformed */ }
      return;
    }

    // Step start: "⏳ emoji name 执行中 ..."
    const startMatch = clean.match(/^⏳\s+(\S+)\s+(.+?)\s+执行中/);
    if (startMatch) {
      const [, emoji, name] = startMatch;
      send('step-start', { emoji, name });
      return;
    }

    // Step header: "── [N/M] emoji name (id) ──"
    const headerMatch = clean.match(/── \[(\d+)\/(\d+)\] (\S+)\s+(.+?)\s+\((\S+)\) ──/);
    if (headerMatch) {
      const [, cur, total, emoji, name, id] = headerMatch;
      currentStepId = id;
      failedStepId = null;
      send('step-header', { cur: +cur, total: +total, emoji, name, id });
      return;
    }

    // 多行失败原因的续行：并进同一步的 error 重发一次（前端按 id 覆盖），不当正文
    if (failedStepId) {
      if (/^={3,}$/.test(clean) || matchRunSummary(raw)) {
        failedStepId = null;
      } else {
        failedError += `\n${clean}`;
        send('step-failed', { id: failedStepId, error: failedError });
        return;
      }
    }

    // Step done: "完成 | 22.5s | 695 tokens".
    // NOTE: the step's CONTENT is printed AFTER this line, so we must keep
    // currentStepId set here — clearing it would drop the whole step body.
    const metaMatch = clean.match(/^完成\s*\|\s*(.+)/);
    if (metaMatch && currentStepId) {
      // reporter.formatVerification 对英文步骤打的是 "Acceptance ⚠️ 2 unmet"——只认中文"验收"时，
      // 英文模板的未满足条目会整段掉进正文
      inVerifyItems = /(?:验收|Acceptance)\s*⚠️/.test(metaMatch[1]);
      send('step-done', { id: currentStepId, meta: metaMatch[1] });
      return;
    }

    // Step failed / skipped: 状态行之后这一步不会再有正文——清掉 currentStepId，
    // 否则后面的汇总行、报错行会一路挂到这一步名下当"正文"
    const failed = matchStepFailed(raw);
    if (failed !== null && currentStepId) {
      send('step-failed', { id: currentStepId, error: failed });
      failedStepId = currentStepId;
      failedError = failed;
      currentStepId = null;
      inVerifyItems = false;
      return;
    }
    const skipped = matchStepSkipped(raw);
    if (skipped !== null && currentStepId) {
      send('step-skipped', { id: currentStepId, reason: skipped });
      currentStepId = null;
      inVerifyItems = false;
      return;
    }

    // Verification detail lines right after a "完成 | … | 验收 ⚠️" line
    if (inVerifyItems && currentStepId && /^⚠️\s*/.test(clean)) {
      send('step-verify-item', { id: currentStepId, text: clean.replace(/^⚠️\s*/, '') });
      return;
    }
    inVerifyItems = false;

    // Workflow summary: "完成: 5/5 步 | ..." or "部分失败: 3/5 步 | ..." — end of all step output.
    const summary = matchRunSummary(raw);
    if (summary) {
      send('workflow-summary', summary);
      currentStepId = null;
      return;
    }

    // 因上游失败被跳过的步骤只在汇总尾部列一次（见 matchSkippedTail）。reason 留空：
    // 条件跳过的步骤此前已经带着"条件不满足"发过一次，别被这里覆盖成"上游失败"
    const skippedIds = matchSkippedTail(raw);
    if (skippedIds) {
      for (const id of skippedIds) send('step-skipped', { id, reason: null });
      currentStepId = null;
      return;
    }

    // Trailing footer after the summary — never part of a step body.
    if (/^详细输出[:：]/.test(clean) || /^💡/.test(clean) || /^可选步骤/.test(clean) || /^steps[:：]/i.test(clean)) {
      // 把输出目录单独发给前端展示"保存位置"(用户反馈:不知道文件存在哪)
      const m = clean.match(/(?:详细输出|Detailed output)[:：]?\s*(.+)$/i);
      if (m) send('output-dir', { dir: resolveOutputDir(m[1].trim()) });
      currentStepId = null;
      return;
    }

    // Pure separator lines (=====) — skip, but keep attributing to the step.
    if (/^={3,}$/.test(clean)) return;

    // Step content (printed after the "完成 | meta" line, until the next header)
    if (currentStepId) {
      const stripped = plain(raw).replace(/^\s{0,4}/, '');
      if (!/^⏳.*\.\.\.\s*\d+s/.test(clean)) {
        send('step-content', { id: currentStepId, text: stripped });
      }
    }
  }

  return { parseLine };
}
