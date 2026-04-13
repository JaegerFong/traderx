export function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toInt(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return Math.trunc(n);
}

export function pickString(v: unknown, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

/** 提取 JSONP 里的 payload 并 JSON.parse */
export function parseJsonpObject(text: string): unknown {
  const s = String(text ?? '').trim();
  // 常见：try{callback(...);}catch(e){}; 或 callback(...);
  const m = s.match(/callback\s*\(\s*([\s\S]*)\s*\)\s*;?\s*\}?/i);
  if (m && m[1]) {
    return JSON.parse(m[1]);
  }
  // 某些返回是 var data=...; 形式
  const m2 = s.match(/var\s+data\s*=\s*([\s\S]*?);/i);
  if (m2 && m2[1]) {
    return JSON.parse(m2[1]);
  }
  return JSON.parse(s);
}

export function formatHhMmSsFromUnixSeconds(sec: number): string {
  const d = new Date(sec * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

