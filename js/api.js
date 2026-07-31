/* api.js —— 基金行情接口（JSONP，无需后端）
 *
 * 主接口（2026-07 实测可用）：天天基金移动端开放接口
 *   https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?...&Fcodes=110011,161725&callback=xxx
 *   优点：支持 JSONP、支持一次批量查多只、返回官方净值 NAV 与日涨跌幅 NAVCHGRT
 *   字段：FCODE 代码 / SHORTNAME 名称 / PDATE 净值日期 / NAV 单位净值 /
 *         ACCNAV 累计净值 / NAVCHGRT 日涨跌幅(%) / GSZ 盘中估值 / GSZZL 估值涨跌幅(%) / GZTIME 估值时间
 *
 * 备用接口：https://fundgz.1234567.com.cn/js/{code}.js
 *   注意：该地址 2026 年已下线（返回 404 页面），仅作为兜底保留，失败即忽略。
 */
(function () {
  'use strict';

  const MOB_BASE = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo';
  const MOB_PARAMS = 'pageIndex=1&pageSize=50&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=ffa';

  function isTradingTime() {
    const d = new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return false; // 周末非交易
    const mins = d.getHours() * 60 + d.getMinutes();
    const m1s = 9 * 60 + 30, m1e = 11 * 60 + 30; // 09:30-11:30
    const m2s = 13 * 60, m2e = 15 * 60;          // 13:00-15:00
    return (mins >= m1s && mins <= m1e) || (mins >= m2s && mins <= m2e);
  }

  /* 通用 JSONP 请求 */
  function jsonp(buildUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cb = 'ffa_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
      const script = document.createElement('script');
      let done = false;
      const timer = setTimeout(() => { if (!done) { cleanup(); reject(new Error('请求超时')); } }, timeoutMs || 12000);

      function cleanup() {
        clearTimeout(timer);
        done = true;
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      script.onerror = () => { if (!done) { cleanup(); reject(new Error('网络错误')); } };
      script.src = buildUrl(cb);
      document.head.appendChild(script);
    });
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

  /* 把移动端接口的一条记录规范化为内部结构 */
  function normalize(row) {
    const nav = num(row.NAV);                 // 官方最新单位净值
    const chgRt = num(row.NAVCHGRT);          // 该净值日的涨跌幅 %
    const hasGsz = row.GSZ !== null && row.GSZ !== undefined && row.GSZ !== '' && num(row.GSZ) > 0;
    // 上一交易日净值：由最新净值与当日涨跌幅反推
    const prev = chgRt !== -100 ? nav / (1 + chgRt / 100) : nav;
    return {
      code: String(row.FCODE || ''),
      name: row.SHORTNAME || '',
      nav: nav,                               // 官方已公布净值
      navDate: row.PDATE || '',
      navChangePct: chgRt,                    // 官方净值日涨跌幅
      prevNav: prev,                          // 官方净值的前一日净值
      gsz: hasGsz ? num(row.GSZ) : 0,         // 盘中估值（无则 0）
      gszzl: hasGsz ? num(row.GSZZL) : 0,     // 估值涨跌幅
      gztime: row.GZTIME || '',
      hasEstimate: hasGsz,
    };
  }

  /* 批量查询：codes 为代码数组，返回 { code: normalized } 映射 */
  async function getBatch(codes) {
    const list = (codes || []).map(c => String(c).trim()).filter(c => /^\d{6}$/.test(c));
    if (list.length === 0) return {};
    const out = {};
    // 每批最多 50 只
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const data = await jsonp(cb =>
        MOB_BASE + '?' + MOB_PARAMS + '&Fcodes=' + chunk.join(',') + '&_=' + Date.now() + '&callback=' + cb);
      if (!data || !Array.isArray(data.Datas)) throw new Error('未获取到基金数据');
      data.Datas.forEach(row => {
        if (row && row.FCODE) out[String(row.FCODE)] = normalize(row);
      });
    }
    return out;
  }

  /* 单只查询（兼容旧调用） */
  async function getEstimate(code) {
    const map = await getBatch([code]);
    const d = map[String(code).trim()];
    if (!d) throw new Error('未获取到基金数据');
    return d;
  }

  window.FundAPI = { isTradingTime, getBatch, getEstimate, _jsonp: jsonp, _normalize: normalize };
})();

/* GoldAPI —— 实体黄金（如意金）参考价
 * 数据源（2026-07 实测可用、CORS 开放 *、无需 key）：
 *   金价：https://api.gold-api.com/price/XAU  → 返回 XAU 美元/盎司
 *   汇率：https://open.er-api.com/v6/latest/USD → 返回 rates.CNY
 * 换算：如意金参考价(元/克) = XAU美元/盎司 ÷ 31.1034768 × 美元兑人民币
 */
(function () {
  'use strict';
  const XAU_URL = 'https://api.gold-api.com/price/XAU';
  const FX_URL = 'https://open.er-api.com/v6/latest/USD';
  const GRAMS_PER_OZ = 31.1034768;
  const FALLBACK_USD_CNY = 7.2;

  function fetchJson(url, timeoutMs) {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, timeoutMs || 10000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(() => clearTimeout(timer));
  }

  /* 返回 { price: 元/克, usdPerOz, usdCny, updatedAt } */
  async function getPrice() {
    const [xau, fx] = await Promise.all([
      fetchJson(XAU_URL, 10000),
      fetchJson(FX_URL, 10000),
    ]);
    const usdCny = (fx && fx.rates && fx.rates.CNY) ? Number(fx.rates.CNY) : FALLBACK_USD_CNY;
    const perGram = (Number(xau.price) || 0) / GRAMS_PER_OZ * usdCny;
    return {
      price: perGram,
      usdPerOz: Number(xau.price) || 0,
      usdCny: usdCny,
      updatedAt: xau.updatedAt || '',
    };
  }

  window.GoldAPI = { getPrice, _fetchJson: fetchJson, GRAMS_PER_OZ };
})();
