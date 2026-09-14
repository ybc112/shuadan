import net from 'node:net';
import tls from 'node:tls';

/**
 * 网络环境代理桥接：仅在设置了 HTTPS_PROXY 时替换全局 fetch，使所有外部
 * HTTPS 请求（币安合约接口）通过本地代理 CONNECT 隧道转发。
 * 未设置 HTTPS_PROXY 时完全不生效，行为与原生 fetch 完全一致。
 */
export function installProxyFetch(proxyUrl: string): void {
  let proxy: URL;
  try { proxy = new URL(proxyUrl); } catch { return; }
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || 80;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input));
    if (url.protocol !== 'https:') return originalFetch(url, init);
    const controller = new AbortController();
    const signal = init.signal;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await proxyRequest(url, init, proxyHost, proxyPort, controller.signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }) as typeof fetch;
}

function proxyRequest(
  url: URL,
  init: RequestInit,
  proxyHost: string,
  proxyPort: number,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const host = url.hostname;
    const port = url.port || '443';
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body == null ? undefined : Buffer.from(String(init.body));
    const headers = new Headers(init.headers);
    if (body) headers.set('content-length', String(body.length));
    headers.set('connection', 'close');
    headers.set('host', url.host);

    let settled = false;
    let tlsSocket: tls.TLSSocket | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      tlsSocket?.destroy();
      socket.destroy();
      reject(error);
    };

    const socket = net.connect(proxyPort, proxyHost);
    socket.setTimeout(15000, () => fail(new Error('代理连接超时')));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });

    let rest = Buffer.alloc(0);
    const onConnectData = (chunk: Buffer) => {
      rest = Buffer.concat([rest, chunk]);
      const idx = rest.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = rest.slice(0, idx).toString('latin1').split('\r\n')[0];
      const code = Number(statusLine.split(' ')[1]);
      socket.off('data', onConnectData);
      if (code !== 200) { fail(new Error(`代理 CONNECT 失败：${statusLine}`)); return; }
      socket.unshift(rest.subarray(idx + 4));
      rest = Buffer.alloc(0);
      tlsSocket = tls.connect({ socket, servername: host });
      tlsSocket.on('error', fail);
      tlsSocket.on('secureConnect', () => {
        if (signal.aborted) { fail(new Error('请求已中止')); return; }
        const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `host: ${url.host}`];
        headers.forEach((value, key) => { if (key.toLowerCase() !== 'host') lines.push(`${key}: ${value}`); });
        const headText = lines.join('\r\n') + '\r\n\r\n';
        tlsSocket!.write(Buffer.concat([Buffer.from(headText), body ?? Buffer.alloc(0)]));
      });
      signal.addEventListener('abort', () => fail(new Error('请求已中止')), { once: true });

      let httpBuf = Buffer.alloc(0);
      tlsSocket.on('data', (chunk2) => { httpBuf = Buffer.concat([httpBuf, chunk2]); });
      tlsSocket.on('end', () => {
        if (settled) return;
        settled = true;
        const sep = httpBuf.indexOf('\r\n\r\n');
        if (sep === -1) { socket.destroy(); reject(new Error('币安响应无效')); return; }
        const headText2 = httpBuf.slice(0, sep).toString('latin1');
        const lineList = headText2.split('\r\n');
        const status = Number(lineList[0].split(' ')[1]);
        const responseHeaders = new Headers();
        for (let i = 1; i < lineList.length; i++) {
          const matched = /^([^:]+):\s*(.*)$/.exec(lineList[i]);
          if (matched) responseHeaders.set(matched[1], matched[2]);
        }
        let payload = httpBuf.subarray(sep + 4);
        const contentLength = responseHeaders.get('content-length');
        if (contentLength != null) payload = payload.subarray(0, Number(contentLength));
        resolve(new Response(payload, {
          status,
          headers: responseHeaders,
          statusText: lineList[0].split(' ').slice(2).join(' ') || undefined,
        }));
      });
    };
    socket.on('data', onConnectData);
  });
}