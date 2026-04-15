import * as https from 'https';
import { URL } from 'url';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 长连接易触发对端提前关连接时，可改为 false 试一次 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 60000,
});

function mergeHeaders(rest: RequestInit | undefined): Record<string, string> {
  return {
    'User-Agent': DEFAULT_UA,
    Accept: 'application/json,text/plain,*/*',
    Connection: 'keep-alive',
    ...((rest?.headers as Record<string, string>) ?? {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
  return (
    msg.includes('fetch failed') ||
    msg.includes('Failed to fetch') ||
    msg.includes('socket hang up') ||
    msg.includes('Hang up') ||
    msg === 'network error' ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  );
}

/** Node https，带有限次重试（缓解 socket hang up） */
async function fetchTextNodeHttps(urlStr: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  let lastErr: unknown;
  const attempts = [false, true];
  for (let i = 0; i < attempts.length; i++) {
    const noKeepAlive = attempts[i]!;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchTextNodeHttpsOnce(urlStr, headers, timeoutMs, noKeepAlive);
      } catch (e) {
        lastErr = e;
        if (!isTransientNetError(e) || attempt === 2) {
          break;
        }
        await sleep(300 * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function fetchTextNodeHttpsOnce(
  urlStr: string,
  headers: Record<string, string>,
  timeoutMs: number,
  disableAgent: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: true,
        agent: disableAgent ? undefined : httpsAgent,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (ch) => chunks.push(ch as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.end();
  });
}

function shouldRetryWithNode(e: unknown): boolean {
  return isTransientNetError(e);
}

/** Node https：返回原始 Buffer（用于非 UTF-8 编码接口，如 GBK） */
async function fetchBufferNodeHttps(urlStr: string, headers: Record<string, string>, timeoutMs: number): Promise<Buffer> {
  let lastErr: unknown;
  const attempts = [false, true];
  for (let i = 0; i < attempts.length; i++) {
    const noKeepAlive = attempts[i]!;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchBufferNodeHttpsOnce(urlStr, headers, timeoutMs, noKeepAlive);
      } catch (e) {
        lastErr = e;
        if (!isTransientNetError(e) || attempt === 2) {
          break;
        }
        await sleep(300 * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function fetchBufferNodeHttpsOnce(
  urlStr: string,
  headers: Record<string, string>,
  timeoutMs: number,
  disableAgent: boolean,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: true,
        agent: disableAgent ? undefined : httpsAgent,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (ch) => chunks.push(ch as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.end();
  });
}

export async function fetchText(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<string> {
  const { timeoutMs = 20000, ...rest } = init ?? {};
  const headers = mergeHeaders(rest);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('utf8');
  } catch (e) {
    if (url.startsWith('https://') && shouldRetryWithNode(e)) {
      return fetchTextNodeHttps(url, headers, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchBuffer(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Buffer> {
  const { timeoutMs = 20000, ...rest } = init ?? {};
  const headers = mergeHeaders(rest);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: ctrl.signal,
      headers,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (url.startsWith('https://') && shouldRetryWithNode(e)) {
      return fetchBufferNodeHttps(url, headers, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}
