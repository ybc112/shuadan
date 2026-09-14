let token = '';
export function setToken(next: string) { token = next; }

// AbortSignal.timeout 是较新 API（Chrome 103+ / Safari 15.4+）。
// 旧浏览器回退到 AbortController + 定时器，保证工作台可在旧环境打开。
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export async function api<T = { ok: boolean }>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Console-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body), signal: timeoutSignal(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data as T;
}
