/* store.js —— 全局数据层（localStorage 持久化）
 * 所有读写均通过 Store 暴露的方法进行，便于后续替换为云端同步层。
 */
(function () {
  'use strict';
  const KEY = 'ffa_state_v1';

  const BOARD_DEFS = [
    { key: 'premarital', name: '婚前资产' },
    { key: 'family', name: '家庭共同资产' },
    { key: 'education', name: '教育专项资产' },
  ];

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultState() {
    const boards = {};
    BOARD_DEFS.forEach(b => { boards[b.key] = { key: b.key, name: b.name, cash: [], invest: [] }; });
    return {
      version: 1,
      settings: {
        hideAmount: false,        // 金额隐藏
        colorScheme: 'redUp',      // 红涨绿跌（默认，A股习惯）/ greenUp 绿涨红跌
        autoRefreshInvest: true,   // 进入投资页自动刷新
        snapshotLimit: 30,         // 刷新快照最大留存
      },
      boards,
      trades: [],
      snapshots: [],
      dcaPlans: [],
      dcaDone: {},
      lastRefresh: null,         // { time, ok, fail, trading, navDate }
    };
  }

  function mergeDefaults(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    if (s.settings) Object.assign(d.settings, s.settings);
    if (s.boards) {
      BOARD_DEFS.forEach(b => {
        if (s.boards[b.key]) {
          d.boards[b.key].cash = Array.isArray(s.boards[b.key].cash) ? s.boards[b.key].cash : [];
          d.boards[b.key].invest = Array.isArray(s.boards[b.key].invest) ? s.boards[b.key].invest : [];
        }
      });
    }
    d.trades = Array.isArray(s.trades) ? s.trades : [];
    d.snapshots = Array.isArray(s.snapshots) ? s.snapshots : [];
    d.dcaPlans = Array.isArray(s.dcaPlans) ? s.dcaPlans : [];
    d.dcaDone = (s.dcaDone && typeof s.dcaDone === 'object') ? s.dcaDone : {};
    d.lastRefresh = (s.lastRefresh && typeof s.lastRefresh === 'object') ? s.lastRefresh : null;
    return d;
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      return mergeDefaults(JSON.parse(raw));
    } catch (e) { console.error('load failed', e); return defaultState(); }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { if (window.UI) UI.toast('保存失败：' + e.message); }
    // remote 模式：防抖推送全量状态到后端（后端为唯一真值源，实现多设备同步）
    if (window.Remote && window.Remote.isEnabled()) window.Remote.push(state);
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ---------------- 现金类 ---------------- */
  function addCash(boardKey, item) {
    const b = state.boards[boardKey]; if (!b) return;
    const rec = {
      id: uid(),
      type: item.type === 'expense' ? 'expense' : 'income',
      amount: Math.abs(Number(item.amount) || 0),
      note: (item.note || '').toString().slice(0, 60),
      hidden: false,                 // 隐藏：数字不可见且不计总额
      time: item.time || Date.now(),
    };
    b.cash.unshift(rec);
    save();
    return rec;
  }
  function updateCash(boardKey, id, patch) {
    const b = state.boards[boardKey]; if (!b) return;
    const c = b.cash.find(x => x.id === id); if (!c) return;
    if (patch.amount !== undefined) c.amount = Math.abs(Number(patch.amount) || 0);
    if (patch.type !== undefined) c.type = patch.type === 'expense' ? 'expense' : 'income';
    if (patch.note !== undefined) c.note = patch.note.toString().slice(0, 60);
    if (patch.hidden !== undefined) c.hidden = !!patch.hidden;
    if (patch.time !== undefined) c.time = patch.time;
    save();
  }
  function deleteCash(boardKey, id) {
    const b = state.boards[boardKey]; if (!b) return;
    b.cash = b.cash.filter(c => c.id !== id);
    save();
  }

  /* ---------------- 投资持仓 ---------------- */
  function addHolding(boardKey, h) {
    const b = state.boards[boardKey]; if (!b) return;
    const rec = {
      id: uid(),
      code: (h.code || '').toString().trim(),
      name: (h.name || '').toString().trim() || '未命名基金',
      kind: h.kind === 'gold' ? 'gold' : 'fund',
      shares: Math.max(0, Number(h.shares) || 0),
      avgCost: Math.max(0, Number(h.avgCost) || 0),
      lastNav: 0, prevNav: 0, todayChangePct: 0,
      marketValue: 0, todayProfit: 0, totalProfit: 0,
      navHistory: [], note: (h.note || '').toString().slice(0, 200),
      hidden: false,                 // 隐藏：数字不可见且不计总额
    };
    b.invest.push(rec);
    save();
    return rec;
  }
  function updateHolding(boardKey, id, patch) {
    const b = state.boards[boardKey]; if (!b) return;
    const h = b.invest.find(x => x.id === id); if (!h) return;
    Object.assign(h, patch);
    if (patch.note !== undefined) h.note = patch.note.toString().slice(0, 200);
    if (patch.hidden !== undefined) h.hidden = !!patch.hidden;
    save();
  }
  function deleteHolding(boardKey, id) {
    const b = state.boards[boardKey]; if (!b) return;
    b.invest = b.invest.filter(x => x.id !== id);
    save();
  }

  /* ---------------- 交易记录 ---------------- */
  function addTrade(t) {
    const action = t.action === 'sell' ? 'sell' : 'buy';
    const rec = {
      id: uid(),
      board: t.board,
      code: (t.code || '').toString().trim(),
      action: action,
      shares: Math.max(0, Number(t.shares) || 0),
      price: Math.max(0, Number(t.price) || 0),
      time: t.time || Date.now(),
      note: (t.note || '').toString().slice(0, 60),
      dca: !!(t.dca && action === 'buy'),
    };
    state.trades.unshift(rec);
    const b = state.boards[rec.board];
    if (b && rec.code) {
      const h = b.invest.find(x => x.code === rec.code);
      if (h) {
        if (rec.action === 'buy') {
          const totalCost = h.shares * h.avgCost + rec.shares * rec.price;
          const totalShares = h.shares + rec.shares;
          h.avgCost = totalShares > 0 ? totalCost / totalShares : 0;
          h.shares = totalShares;
        } else {
          h.shares = Math.max(0, h.shares - rec.shares);
        }
        save();
      }
    }
    // 定投计划：若本次为带 dca 的买入，标记匹配计划已完成本期
    if (rec.action === 'buy' && rec.dca && rec.board && rec.code) {
      state.dcaPlans.forEach(p => {
        if (p.enabled !== false && p.board === rec.board && p.code === rec.code) state.dcaDone[p.id] = rec.time;
      });
    }
    save();
    return rec;
  }
  function deleteTrade(id) {
    state.trades = state.trades.filter(t => t.id !== id);
    save();
  }

  /* ---------------- 刷新快照 ---------------- */
  function addSnapshot(snap) {
    snap.id = snap.id || uid();
    state.snapshots.unshift(snap);
    const limit = Number(state.settings.snapshotLimit) || 30;
    if (state.snapshots.length > limit) state.snapshots.length = limit;
    save();
  }

  /* ---------------- 设置 / 重置 ---------------- */
  function setLastRefresh(info) { state.lastRefresh = info || null; save(); }
  function updateSettings(patch) { Object.assign(state.settings, patch); save(); }
  function resetAll() { state = defaultState(); save(); }
  function replaceState(parsed) { state = mergeDefaults(parsed); save(); }

  /* ---------------- 定投计划 ---------------- */
  function addDcaPlan(plan) {
    const rec = Object.assign({ id: uid(), enabled: true, lastDone: 0 }, plan);
    state.dcaPlans.push(rec);
    save();
  }
  function updateDcaPlan(id, patch) {
    const p = state.dcaPlans.find(x => x.id === id); if (!p) return;
    Object.assign(p, patch);
    save();
  }
  function deleteDcaPlan(id) {
    state.dcaPlans = state.dcaPlans.filter(x => x.id !== id);
    delete state.dcaDone[id];
    save();
  }

  /* ---------------- 计算规则 ---------------- */
  function cashTotal(boardKey) {
    const b = state.boards[boardKey]; if (!b) return 0;
    return b.cash.reduce((s, c) => s + (c.hidden ? 0 : (c.type === 'expense' ? -c.amount : c.amount)), 0);
  }
  function investTotal(boardKey) {
    const b = state.boards[boardKey]; if (!b) return 0;
    return b.invest.reduce((s, h) => s + (h.hidden ? 0 : (h.marketValue || 0)), 0);
  }
  function boardTotal(boardKey) { return cashTotal(boardKey) + investTotal(boardKey); }
  function boardInvestTodayProfit(boardKey) {
    const b = state.boards[boardKey]; if (!b) return 0;
    return b.invest.reduce((s, h) => s + (h.hidden ? 0 : (h.todayProfit || 0)), 0);
  }
  function boardInvestTotalProfit(boardKey) {
    const b = state.boards[boardKey]; if (!b) return 0;
    return b.invest.reduce((s, h) => s + (h.hidden ? 0 : (h.totalProfit || 0)), 0);
  }
  function globalTotals() {
    let mv = 0, today = 0, total = 0, cash = 0;
    BOARD_DEFS.forEach(b => {
      mv += investTotal(b.key);
      cash += cashTotal(b.key);
      state.boards[b.key].invest.forEach(h => { if (!h.hidden) { today += h.todayProfit || 0; total += h.totalProfit || 0; } });
    });
    return { marketValue: mv, cash, todayProfit: today, totalProfit: total, grandTotal: mv + cash };
  }
  function allHoldings() {
    const out = [];
    BOARD_DEFS.forEach(b => state.boards[b.key].invest.forEach(h =>
      out.push(Object.assign({ boardKey: b.key, boardName: b.name }, h))));
    return out;
  }
  function allCash() {
    const out = [];
    BOARD_DEFS.forEach(b => state.boards[b.key].cash.forEach(c =>
      out.push(Object.assign({ boardKey: b.key, boardName: b.name }, c))));
    return out;
  }

  window.Store = {
    BOARD_DEFS,
    get state() { return state; },
    save, uid,
    addCash, updateCash, deleteCash,
    addHolding, updateHolding, deleteHolding,
    addTrade, deleteTrade,
    addSnapshot, updateSettings, resetAll, replaceState, setLastRefresh,
    addDcaPlan, updateDcaPlan, deleteDcaPlan,
    cashTotal, investTotal, boardTotal, boardInvestTodayProfit, boardInvestTotalProfit,
    globalTotals, allHoldings, allCash,
  };
})();
