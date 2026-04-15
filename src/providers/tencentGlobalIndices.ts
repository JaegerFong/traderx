import { fetchText } from '../http';
import type { GlobalIndexRow, GlobalIndicesPayload, GlobalRegionKey } from './marketTypes';

const QQ_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Edg/117.0.2045.60';

const REGION_ORDER: { key: GlobalRegionKey; title: string }[] = [
  { key: 'common', title: '重点关注' },
  { key: 'asia', title: '亚洲市场' },
  { key: 'america', title: '美洲市场' },
  { key: 'europe', title: '欧洲市场' },
  { key: 'other', title: '其他市场' },
];

function pickStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

export async function fetchTencentGlobalIndices(timeoutMs: number): Promise<GlobalIndicesPayload> {
  const url = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/rank/indexRankDetail2';
  const text = await fetchText(url, {
    timeoutMs,
    headers: {
      Referer: 'https://stockapp.finance.qq.com/mstats',
      'User-Agent': QQ_UA,
    },
  });
  const json = JSON.parse(text) as { code?: number; msg?: string; data?: Record<string, unknown> };
  if (json.code !== 0 || !json.data || typeof json.data !== 'object') {
    throw new Error(`全球股指数据异常：${json.msg ?? 'unknown'}`);
  }

  const data = json.data;
  const regions: GlobalIndicesPayload['regions'] = [];

  for (const { key, title } of REGION_ORDER) {
    const raw = data[key];
    if (!Array.isArray(raw) || raw.length === 0) {
      continue;
    }
    const rows: GlobalIndexRow[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      rows.push({
        code: pickStr(o.code),
        qtcode: pickStr(o.qtcode),
        name: pickStr(o.name) || pickStr(o.code),
        location: pickStr(o.location),
        zxj: pickStr(o.zxj),
        zdf: pickStr(o.zdf),
        state: pickStr(o.state),
      });
    }
    if (rows.length > 0) {
      regions.push({ key, title, rows });
    }
  }

  return { regions, fetchedAt: Date.now() };
}
