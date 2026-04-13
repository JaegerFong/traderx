/** 规范化后的代码，如 sh600519 / sz000001 / bj920118 */
export type NormalizedCode = string;

const SH_PREFIXES = new Set(['600', '601', '603', '605', '688', '689']);
const SZ_PREFIXES = new Set(['000', '001', '002', '003', '300', '301']);

export function normalizeStockInput(input: string): { ok: true; code: NormalizedCode } | { ok: false; message: string } {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) {
    return { ok: false, message: '请输入股票代码' };
  }

  let raw = s;
  if (raw.startsWith('sh') || raw.startsWith('sz') || raw.startsWith('bj')) {
    raw = raw.slice(2);
  }

  if (!/^\d{6}$/.test(raw)) {
    return { ok: false, message: '代码应为 6 位数字（或 sh/sz/bj 前缀）' };
  }

  const head3 = raw.slice(0, 3);
  let prefix: 'sh' | 'sz' | 'bj';

  if (raw.startsWith('920') || raw.startsWith('430') || /^8\d{5}$/.test(raw)) {
    prefix = 'bj';
  } else if (raw.startsWith('6') || SH_PREFIXES.has(head3)) {
    prefix = 'sh';
  } else if (SZ_PREFIXES.has(head3) || raw.startsWith('0') || raw.startsWith('3')) {
    prefix = 'sz';
  } else {
    return { ok: false, message: '无法识别市场，请使用 sh/sz/bj 前缀指定' };
  }

  return { ok: true, code: `${prefix}${raw}` };
}

/** 东方财富 secid：沪 1.xxxxxx，深/北 0.xxxxxx */
export function toEastmoneySecid(normalized: NormalizedCode): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/.exec(normalized);
  if (!m) {
    return null;
  }
  const [, market, num] = m;
  if (market === 'sh') {
    return `1.${num}`;
  }
  return `0.${num}`;
}

/** 新浪 / 腾讯 list 参数使用的小写前缀格式 */
export function toMarketListSymbol(normalized: NormalizedCode): string {
  return normalized;
}
