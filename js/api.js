/* api.js —— 天天基金公开行情接口（JSONP，无需后端）
 * 估值接口：https://fundgz.1234567.com.cn/js/{code}.js?callback=xxx
 * 返回字段：fundcode, name, dwjz(上一交易日单位净值), gsz(估算值), gszzl(估算涨跌幅), gztime, jzrq
 */
(function () {
  'use strict';

  function isTradingTime() {
    const d = new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return false; // 周末非交易
    const mins = d.getHours() * 60 + d.getMinutes();
    const m1s = 9 * 60 + 30, m1e = 11 * 60 + 30; // 09:30-11:30
    const m2s = 13 * 60, m2e = 15 * 60;          // 13:00-15:00
    return (mins >= m1s && mins <= m1e) || (mins >= m2s && mins <= m2e);
  }

  function getEstimate(code) {
    return new Promise((resolve, reject) => {
      const cb = 'ffa_cb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
      const script = document.createElement('script');
      let done = false;
      const timeout = setTimeout(() => { if (!done) { cleanup(); reject(new Error('请求超时')); } }, 9000);

      function cleanup() {
        clearTimeout(timeout);
        done = true;
        try { delete window[cb]; } catch (e) {}
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cb] = function (data) {
        cleanup();
        if (!data || !data.fundcode) { reject(new Error('未获取到基金数据')); return; }
        resolve({
          code: data.fundcode,
          name: data.name || '',
          dwjz: parseFloat(data.dwjz) || 0,
          gsz: parseFloat(data.gsz) || 0,
          gszzl: parseFloat(data.gszzl) || 0,
          gztime: data.gztime || '',
          jzrq: data.jzrq || '',
        });
      };
      script.onerror = () => { if (!done) { cleanup(); reject(new Error('网络错误')); } };
      script.src = 'https://fundgz.1234567.com.cn/js/' + encodeURIComponent(code) +
        '.js?rt=' + Date.now() + '&callback=' + cb;
      document.head.appendChild(script);
    });
  }

  window.FundAPI = { isTradingTime, getEstimate };
})();
