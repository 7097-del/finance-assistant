/* remote.js —— 后端同步客户端（自动模式 + 口令认证）
 * 设计：前端默认自动探测同一来源是否存在后端（/api/ping）。
 *   - 存在 → remote 模式：口令登录后，以「全量状态」与后端同步，多设备共享同一账本。
 *   - 不存在（纯静态托管 / 本地文件打开）→ localStorage 模式，行为保持不变。
 * 所有网络调用容错降级：失败时不影响本地使用。
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'ffa_token';
  let base = '';                 // 同源
  let enabled = false;
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let suppress = false;          // 拉取期间抑制一次 push，避免回写噪声
  let pushTimer = null;

  function setEnabled(v) { enabled = !!v; }
  function isEnabled() { return enabled; }
  function setToken(t) { token = t || ''; if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
  function getToken() { return token; }
  function setSuppress(v) { suppress = !!v; }

  function authHeader() { return token ? { Authorization: 'Bearer ' + token } : {}; }
  async function req(method, url, body) {
    const opt = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()) };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(base + url, opt);
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { ok: r.ok, status: r.status, j };
  }

  async function ping() {
    try {
      const r = await fetch(base + '/api/ping', { method: 'GET' });
      // 仅当返回 JSON 且成功，才认定「存在后端」。
      // 静态托管（GitHub Pages 等）对 /api/ping 返回的是 HTML 404 页，
      // Service Worker 在网络失败兜底时也会返回 index.html（同样为 HTML），
      // 这些都不是后端，必须排除，否则会被误判为「有后端」而弹出设口令。
      if (!r.ok) return false;
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('application/json') === -1) return false;
      let j = null;
      try { j = await r.json(); } catch (e) { return false; }
      return !!(j && (j.code === 200 || j.ok === true || j.msg === 'ok'));
    } catch (e) { return false; }
  }
  async function setup(pass) {
    const { j } = await req('POST', '/api/auth/setup', { passcode: pass });
    if (!j || j.code !== 200) throw new Error((j && j.msg) || '设置失败');
    setToken(j.data.token); return true;
  }
  async function login(pass) {
    const { j } = await req('POST', '/api/auth/login', { passcode: pass });
    if (!j || j.code !== 401 && j.code !== 200) { /* fallthrough */ }
    if (!j || j.code !== 200) throw new Error((j && j.msg) || '登录失败');
    setToken(j.data.token); return true;
  }
  async function status() {
    try { const { ok, j } = await req('GET', '/api/auth/status'); return (ok && j) ? j.data : { setup: false }; }
    catch (e) { return { setup: false }; }
  }
  async function pull() {
    const { ok, j } = await req('GET', '/api/sync');
    if (!ok || !j || j.code !== 200) throw new Error((j && j.msg) || '拉取失败');
    return j.data;
  }
  function push(stateObj) {
    if (!enabled || !token || suppress) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      req('POST', '/api/sync', stateObj).catch(() => {});
    }, 250);
  }
  async function quote(code) {
    const { ok, j } = await req('GET', '/api/fund/quote?fundCode=' + encodeURIComponent(code));
    if (!ok || !j || j.code !== 200) throw new Error((j && j.msg) || '行情获取失败');
    return j.data;
  }

  window.Remote = {
    setEnabled, isEnabled, setToken, getToken, setSuppress,
    ping, setup, login, status, pull, push, quote,
  };
})();
