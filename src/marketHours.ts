/**
 * 中国 A 股交易时段（Asia/Shanghai）。
 * 自动刷新窗口：工作日 9:15–11:30、13:00–15:00（含集合竞价）。
 */

function shanghaiWeekdayAndMinutes(d: Date): { weekday: string; minutes: number } {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(d);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { weekday: wd, minutes: hour * 60 + minute };
}

/** 是否在自动拉取行情的时段（与集合竞价 9:15 起算） */
export function isCnAshareAutoRefreshWindow(now: Date = new Date()): boolean {
  const { weekday, minutes: t } = shanghaiWeekdayAndMinutes(now);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  // 9:15–11:30
  if (t >= 9 * 60 + 15 && t <= 11 * 60 + 30) {
    return true;
  }
  // 13:00–15:00
  if (t >= 13 * 60 && t <= 15 * 60) {
    return true;
  }
  return false;
}

/** 集合竞价展示竞价价的时段 9:15–9:30（不含 9:30 整点起连续竞价） */
export function isCnAshareCallAuctionWindow(now: Date = new Date()): boolean {
  const { weekday, minutes: t } = shanghaiWeekdayAndMinutes(now);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  return t >= 9 * 60 + 15 && t < 9 * 60 + 30;
}
