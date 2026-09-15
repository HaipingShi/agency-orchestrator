/**
 * NewAPI 系网关（PackyCode 等）的账户用量查询 —— 对照 cc-switch「用量查询 · NewAPI 模板」实现。
 *
 *   GET {站点根}/api/user/self
 *   Authorization: Bearer <系统访问令牌>
 *   New-Api-User: <用户 ID>
 *   → { success: true, data: { quota, used_quota, group } }   额度单位：500000 = 1 USD
 *
 * 两个容易填错的地方，这里都点破：
 *  - 用的是控制台「个人设置 → 安全设置」生成的**系统访问令牌** + 用户 ID，**不是**调用模型的 API Key
 *    （PackyCode 文档原话；拿 sk- 开头的 key 来查，网关只回一句「access token 无效」）；
 *  - 接口挂在站点根下，不在 /v1 下 —— 用户配的 API base_url 常带 /v1，要先取站点根。
 * 网关对未鉴权请求回的是 **HTTP 200 + success:false**，不能按状态码判断成败。
 */

/** NewAPI 的额度换算：500000 quota = 1 USD（cc-switch 模板同一口径） */
export const NEWAPI_QUOTA_PER_USD = 500000;

export type NewApiUsageResult =
  | { ok: true; planName?: string; remaining: number; used: number; total: number; unit: 'USD' }
  | { ok: false; error: string };

/** 从 API base_url（常带 /v1）取网关站点根；取不出返回空串 */
export function newApiOrigin(baseUrl: string): string {
  const raw = (baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return '';
  }
}

export async function queryNewApiUsage(opts: {
  baseUrl: string;
  accessToken: string;
  userId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<NewApiUsageResult> {
  const origin = newApiOrigin(opts.baseUrl);
  if (!origin) return { ok: false, error: `用量查询地址无效：${opts.baseUrl || '(空)'}` };
  const token = (opts.accessToken || '').trim();
  const userId = String(opts.userId ?? '').trim();
  if (!token || !userId) {
    return {
      ok: false,
      error: '用量查询需要「系统访问令牌」和「用户 ID」：在供应商控制台「个人设置 → 安全设置」生成令牌，用户 ID 在个人设置页顶部（不是调用模型用的 API Key）',
    };
  }
  if (!/^\d+$/.test(userId)) return { ok: false, error: `用户 ID 应是纯数字（个人设置页顶部可以看到），当前填的是：${userId}` };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12000);
  try {
    const r = await (opts.fetchImpl ?? fetch)(`${origin}/api/user/self`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'New-Api-User': userId },
      signal: ctrl.signal,
    });
    const text = await r.text();
    let body: { success?: boolean; message?: string; data?: { quota?: unknown; used_quota?: unknown; group?: unknown } };
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: `HTTP ${r.status}：返回的不是 JSON，地址可能不对（${text.slice(0, 120)}）` };
    }
    const quota = Number(body?.data?.quota);
    if (body?.success && Number.isFinite(quota)) {
      const remaining = quota / NEWAPI_QUOTA_PER_USD;
      const used = (Number(body.data?.used_quota) || 0) / NEWAPI_QUOTA_PER_USD;
      const group = body.data?.group;
      return {
        ok: true,
        ...(typeof group === 'string' && group ? { planName: group } : {}),
        remaining,
        used,
        total: remaining + used,
        unit: 'USD',
      };
    }
    const msg = typeof body?.message === 'string' && body.message ? body.message : `HTTP ${r.status}：未返回用量数据`;
    // 最常见的填错：把调用模型的 API Key（sk-…）当成了访问令牌
    const hint = token.startsWith('sk-') ? '（这里要的是「系统访问令牌」，不是 sk- 开头的 API Key）' : '';
    return { ok: false, error: `${msg}${hint}` };
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? '用量查询超时' : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
