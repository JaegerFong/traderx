/** 东财指数链接（用于内置浏览器打开）。 */
export interface IndexKlineLink {
  label: string;
  /** 东财 PC 行情页（兜底） */
  url: string;
  /** 仅显示分时图（优先） */
  intradayUrl?: string;
}

/** 全球股指（部分常用指数） */
export const GLOBAL_STOCK_KLINE_LINKS: IndexKlineLink[] = [
  {
    label: '上证指数',
    url: 'https://quote.eastmoney.com/zs000001.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000001&market=1',
  },
  {
    label: '深证成指',
    url: 'https://quote.eastmoney.com/zs399001.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399001&market=0',
  },
  {
    label: '创业板指',
    url: 'https://quote.eastmoney.com/zs399006.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399006&market=0',
  },
  { label: '恒生指数', url: 'https://quote.eastmoney.com/hk/110000.html' },
  { label: '纳斯达克', url: 'https://quote.eastmoney.com/us/ixic.html' },
  { label: '道琼斯', url: 'https://quote.eastmoney.com/us/dji.html' },
  { label: '标普500', url: 'https://quote.eastmoney.com/us/spx.html' },
];

/** 重大指数（更多常用指数） */
export const MAJOR_INDEX_KLINE_LINKS: IndexKlineLink[] = [
  {
    label: '上证指数',
    url: 'https://quote.eastmoney.com/zs000001.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000001&market=1',
  },
  {
    label: '深证指数',
    url: 'https://quote.eastmoney.com/zs399001.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399001&market=0',
  },
  {
    label: '创业板指',
    url: 'https://quote.eastmoney.com/zs399006.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399006&market=0',
  },
  { label: '恒生指数', url: 'https://quote.eastmoney.com/hk/110000.html' },
  { label: '道琼斯', url: 'https://quote.eastmoney.com/us/dji.html' },
  { label: '标普500', url: 'https://quote.eastmoney.com/us/spx.html' },
  { label: '纳斯达克', url: 'https://quote.eastmoney.com/us/ixic.html' },
  {
    label: '沪深300',
    url: 'https://quote.eastmoney.com/zs000300.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000300&market=1',
  },
  {
    label: '上证50',
    url: 'https://quote.eastmoney.com/zs000016.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000016&market=1',
  },
  {
    label: '中证A500',
    url: 'https://quote.eastmoney.com/zs000510.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000510&market=1',
  },
  {
    label: '中证1000',
    url: 'https://quote.eastmoney.com/zs000852.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000852&market=1',
  },
  {
    label: '科创50',
    url: 'https://quote.eastmoney.com/zs000688.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000688&market=1',
  },
  {
    label: '科创芯片',
    url: 'https://quote.eastmoney.com/zs000685.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000685&market=1',
  },
  {
    label: '证券龙头',
    url: 'https://quote.eastmoney.com/zs399437.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399437&market=0',
  },
  {
    label: '高端装备',
    url: 'https://quote.eastmoney.com/zs399417.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399417&market=0',
  },
  {
    label: '中证银行',
    url: 'https://quote.eastmoney.com/zs399986.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399986&market=0',
  },
  {
    label: '上证医药',
    url: 'https://quote.eastmoney.com/zs000037.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=000037&market=1',
  },
  {
    label: '中证白酒',
    url: 'https://quote.eastmoney.com/zs399997.html',
    intradayUrl: 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=399997&market=0',
  },
  { label: '富时中国三倍做多', url: 'https://quote.eastmoney.com/us/yinn.html' },
  { label: 'VIX恐慌指数', url: 'https://quote.eastmoney.com/us/uvxy.html' },
];
