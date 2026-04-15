import { fetchText } from '../http';
import type { IndustryRankPayload, IndustryRankRow } from './marketTypes';

const QQ_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Edg/117.0.2045.60';

function pickStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** sort：兼容 desc/asc（映射为 0/1） */
function normalizeIndustrySort(sort: string): string {
  const t = sort.trim().toLowerCase();
  if (t === 'desc' || t === '0') return '0';
  if (t === 'asc' || t === '1') return '1';
  return t === '1' ? '1' : '0';
}

export async function fetchTencentIndustryRank(
  sort: string,
  cnt: number,
  timeoutMs: number,
): Promise<IndustryRankPayload> {
  const l = Math.max(5, Math.min(200, cnt));
  const o = normalizeIndustrySort(sort);
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=${l}&p=1&t=01/averatio&ordertype=&o=${encodeURIComponent(o)}`;
  const text = await fetchText(url, {
    timeoutMs,
    headers: {
      Referer: 'https://stockapp.finance.qq.com/',
      'User-Agent': QQ_UA,
    },
  });
  const json = JSON.parse(text) as { code?: number; msg?: string; data?: unknown };
  if (json.code !== 0) {
    throw new Error(`行业排行异常：${json.msg ?? 'unknown'}`);
  }
  if (!Array.isArray(json.data)) {
    throw new Error('行业排行：返回数据格式异常');
  }

  const rows: IndustryRankRow[] = [];
  for (const item of json.data) {
    if (!item || typeof item !== 'object') continue;
    const x = item as Record<string, unknown>;
    rows.push({
      bdName: pickStr(x.bd_name),
      bdCode: pickStr(x.bd_code),
      bdZxj: pickStr(x.bd_zxj),
      bdZdf: pickStr(x.bd_zdf),
      nzgCode: pickStr(x.nzg_code),
      nzgName: pickStr(x.nzg_name),
      nzgZdf: pickStr(x.nzg_zdf),
      nzgZxj: pickStr(x.nzg_zxj),
      bdZdf5: pickStr(x.bd_zdf5),
      bdZdf20: pickStr(x.bd_zdf20),
    });
  }

  return { rows, fetchedAt: Date.now() };
}
