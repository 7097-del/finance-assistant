/* app.js —— 路由、页面渲染与全部交互逻辑 */
(function () {
  'use strict';

  const TABS = [
    { key: 'home', label: '首页' },
    { key: 'invest', label: '投资专区' },
    { key: 'ledger', label: '收支明细' },
    { key: 'profile', label: '个人中心' },
  ];

  let currentTab = 'home';
  const foldState = {};                 // 板块折叠状态（内存）
  const expandedHoldings = new Set();   // 持仓展开详情
  let refreshing = false;
  const investFilter = { board: 'all', kw: '' };
  const ledgerFilter = { board: 'all' };
  const tradeFilter = { board: 'all' };

  /* ---------------- 工具 ---------------- */
  function pushNav(history, entry) {
    history = history || [];
    history.push(entry);
    if (history.length > 400) history.shift();
    return history;
  }
  function periodReturn(navHistory, days) {
    if (!navHistory || navHistory.length < 2) return null;
    const sorted = navHistory.slice().sort((a, b) => a.t - b.t);
    const latest = sorted[sorted.length - 1];
    const target = latest.t - days * 86400000;
    let pick = null;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].t <= target) pick = sorted[i];
      else break;
    }
    if (!pick || pick.nav <= 0) return null;
    return (latest.nav / pick.nav - 1) * 100;
  }
  function boardSelectOptions(selected) {
    return Store.BOARD_DEFS.map(b =>
      '<option value="' + b.key + '"' + (selected === b.key ? ' selected' : '') + '>' + b.name + '</option>').join('');
  }

  /* ---------------- 定投计划：到期计算 ---------------- */
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function nextDue(plan, fromTs) {
    const from = new Date(fromTs);
    if (plan.freq === 'weekly') {
      const tgt = ((Number(plan.param) || 1) % 7 + 7) % 7; // 1=周一..7=周日 → 0=周日..6=周六
      let diff = (tgt - from.getDay() + 7) % 7; if (diff === 0) diff = 7;
      const d = new Date(from); d.setDate(d.getDate() + diff); d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    if (plan.freq === 'interval') {
      const n = Math.max(1, Number(plan.param) || 1);
      return fromTs + n * 86400000;
    }
    // monthly
    const day = Math.min(Math.max(1, Number(plan.param) || 1), 28);
    const y = from.getFullYear(), m = from.getMonth();
    let cand = new Date(y, m, Math.min(day, daysInMonth(y, m)), 0, 0, 0, 0);
    if (cand.getTime() <= fromTs) {
      cand = new Date(y, m + 1, Math.min(day, daysInMonth(y, m + 1)), 0, 0, 0, 0);
    }
    return cand.getTime();
  }
  function isDue(plan) {
    const last = (Store.state.dcaDone && Store.state.dcaDone[plan.id]) || 0;
    return Date.now() >= nextDue(plan, last || 0);
  }
  function freqLabel(plan) {
    if (plan.freq === 'weekly') return '每周' + ['日', '一', '二', '三', '四', '五', '六'][((Number(plan.param) || 1) % 7)];
    if (plan.freq === 'interval') return '每' + (Number(plan.param) || 1) + '天';
    return '每月' + (Number(plan.param) || 1) + '号';
  }
  function boardName(key) { const d = Store.BOARD_DEFS.find(b => b.key === key); return d ? d.name : key; }

  /* ---------------- 净值刷新 ---------------- */
  async function getQuote(code) {
    if (window.Remote && Remote.isEnabled()) return await Remote.quote(code);
    return await FundAPI.getEstimate(code);
  }
  async function refreshAll(showToast) {
    if (refreshing) return;
    const holdings = Store.allHoldings();
    if (holdings.length === 0) { if (showToast) UI.toast('暂无持仓可刷新'); return; }
    refreshing = true;
    setRefreshingUI(true);
    let ok = 0, fail = 0;
    const trading = FundAPI.isTradingTime();
    for (const h of holdings) {
      try {
        const d = await getQuote(h.code);
        const latestNav = trading ? d.gsz : d.dwjz;
        const prevNav = d.dwjz;
        const todayChangePct = trading ? d.gszzl : 0;
        const marketValue = h.shares * latestNav;
        const todayProfit = (latestNav - prevNav) * h.shares;
        const totalProfit = (latestNav - h.avgCost) * h.shares;
        Store.updateHolding(h.boardKey, h.id, {
          name: d.name || h.name,
          lastNav: latestNav, prevNav: prevNav, todayChangePct: todayChangePct,
          marketValue: marketValue, todayProfit: todayProfit, totalProfit: totalProfit,
          navHistory: pushNav(h.navHistory, { t: Date.now(), nav: latestNav }),
        });
        ok++;
      } catch (e) { fail++; console.warn('刷新失败', h.code, e); }
    }
    const g = Store.globalTotals();
    Store.addSnapshot({
      time: Date.now(),
      trading: trading,
      totalMarketValue: g.marketValue,
      todayProfit: g.todayProfit,
      boards: Store.BOARD_DEFS.map(b => ({ key: b.key, name: b.name, total: Store.boardTotal(b.key) })),
      items: Store.allHoldings().map(h => ({
        code: h.code, name: h.name, nav: h.lastNav, marketValue: h.marketValue, changePct: h.todayChangePct,
      })),
    });
    refreshing = false;
    setRefreshingUI(false);
    render();
    if (showToast) UI.toast(fail === 0 ? ('刷新完成，' + ok + ' 只基金已更新') : ('刷新完成：' + ok + ' 成功，' + fail + ' 失败'));
  }
  function setRefreshingUI(on) {
    document.querySelectorAll('[data-action="refresh"], [data-action="refresh-invest"]').forEach(b => {
      b.classList.toggle('loading', on);
      b.disabled = on;
    });
  }

  /* ---------------- 通用：左滑删除绑定 ---------------- */
  function bindSwipe(root) {
    root.querySelectorAll('.swipe-item').forEach(item => {
      const inner = item.querySelector('.swipe-inner');
      if (!inner) return;
      const delW = 76;
      let startX = 0, curX = 0, dragging = false, opened = false;
      function start(x) { startX = x; dragging = true; opened = false; inner.style.transition = 'none'; }
      function move(x) {
        if (!dragging) return;
        curX = x - startX;
        if (curX > 0) curX = 0;
        if (curX < -delW - 40) curX = -delW - 40;
        inner.style.transform = 'translateX(' + curX + 'px)';
      }
      function end() {
        if (!dragging) return;
        dragging = false;
        inner.style.transition = 'transform .2s';
        if (curX < -delW / 2) { inner.style.transform = 'translateX(-' + delW + 'px)'; opened = true; }
        else { inner.style.transform = 'translateX(0)'; opened = false; }
      }
      item.addEventListener('touchstart', e => start(e.touches[0].clientX), { passive: true });
      item.addEventListener('touchmove', e => move(e.touches[0].clientX), { passive: true });
      item.addEventListener('touchend', end);
      item.addEventListener('mousedown', e => {
        start(e.clientX);
        const mm = ev => move(ev.clientX);
        const mu = () => { end(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
        document.addEventListener('mousemove', mm);
        document.addEventListener('mouseup', mu);
      });
    });
  }

  /* ---------------- 录入表单 ---------------- */
  function openCashSheet(presetBoard) {
    UI.sheet({
      title: '记一笔（现金收支）',
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: presetBoard || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'type', label: '收支分类', type: 'segmented', value: 'expense', options: [{ value: 'expense', label: '支出' }, { value: 'income', label: '收入' }] },
        { key: 'amount', label: '金额（元）', type: 'number', placeholder: '0.00' },
        { key: 'note', label: '备注', type: 'text', placeholder: '可选' },
      ],
      submitText: '保存',
      onSubmit: (v) => {
        if (!v.amount || Number(v.amount) <= 0) throw new Error('请输入有效金额');
        Store.addCash(v.board, { type: v.type, amount: v.amount, note: v.note });
      },
    }).then(() => render());
  }

  function openHoldingSheet(presetBoard, edit) {
    const h = edit || {};
    UI.sheet({
      title: edit ? '编辑持仓' : '新增投资持仓',
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: presetBoard || h.boardKey || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'code', label: '6位基金代码', type: 'text', value: h.code || '', placeholder: '如 110011' },
        { key: 'name', label: '基金名称', type: 'text', value: h.name && h.name !== '未命名基金' ? h.name : '', placeholder: '可选，刷新时自动获取' },
        { key: 'shares', label: '持仓份额', type: 'number', value: h.shares || '', placeholder: '0.00' },
        { key: 'avgCost', label: '平均成本（元）', type: 'number', value: h.avgCost || '', placeholder: '0.00' },
      ],
      submitText: '保存',
      onSubmit: (v) => {
        if (!/^\d{6}$/.test((v.code || '').trim())) throw new Error('请输入6位基金代码');
        if (!v.shares || Number(v.shares) <= 0) throw new Error('请输入有效份额');
        if (edit) {
          Store.updateHolding(h.boardKey, h.id, {
            code: v.code.trim(), name: v.name.trim() || '未命名基金',
            shares: Number(v.shares), avgCost: Number(v.avgCost) || 0,
          });
        } else {
          Store.addHolding(v.board, { code: v.code.trim(), name: v.name.trim(), shares: Number(v.shares), avgCost: Number(v.avgCost) || 0 });
        }
      },
    }).then(() => render());
  }

  function openTradeSheet(preset) {
    preset = preset || {};
    const isSell = preset.action === 'sell';
    const dcaField = isSell ? [] : [{
      key: 'dca', label: '类型', type: 'segmented', value: preset.dca ? 'yes' : 'no',
      options: [{ value: 'no', label: '普通买入' }, { value: 'yes', label: '定投' }],
    }];
    UI.sheet({
      title: isSell ? '卖出登记' : (preset.dca ? '定投登记' : '买入登记'),
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: preset.board || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'code', label: '基金代码', type: 'text', value: preset.code || '', placeholder: '如 110011' },
        { key: 'action', label: '方向', type: 'select', value: preset.action || 'buy', options: [{ value: 'buy', label: '买入' }, { value: 'sell', label: '卖出' }] },
        ...dcaField,
        { key: 'shares', label: '交易份额', type: 'number', value: preset.shares || '', placeholder: '0.00' },
        { key: 'price', label: '成交净值', type: 'number', value: preset.price || '', placeholder: '0.00' },
        { key: 'note', label: '备注', type: 'text', value: preset.note || '', placeholder: '可选' },
      ],
      submitText: '登记',
      onSubmit: (v) => {
        if (!/^\d{6}$/.test((v.code || '').trim())) throw new Error('请输入6位基金代码');
        if (!v.shares || Number(v.shares) <= 0) throw new Error('请输入有效份额');
        if (!v.price || Number(v.price) <= 0) throw new Error('请输入有效成交净值');
        Store.addTrade({ board: v.board, code: v.code.trim(), action: v.action, shares: Number(v.shares), price: Number(v.price), note: v.note, dca: v.action === 'buy' && v.dca === 'yes' });
      },
    }).then(() => render());
  }

  function openSellBoard(boardKey) {
    const list = Store.state.boards[boardKey] ? Store.state.boards[boardKey].invest : [];
    if (!list || list.length === 0) { UI.toast('该板块暂无持仓，无法卖出'); return; }
    const opts = list.map(h => ({ value: h.id, label: h.name + ' (' + h.code + ') · 份额 ' + UI.fmtNum(h.shares) }));
    UI.sheet({
      title: '卖出持仓',
      fields: [{ key: 'id', label: '选择要卖出的基金', type: 'select', options: opts }],
      submitText: '下一步',
      onSubmit: (v) => {
        const h = list.find(x => x.id === v.id);
        if (h) openTradeSheet({ board: boardKey, code: h.code, action: 'sell' });
        return true;
      }
    });
  }

  function openTransferSheet() {
    UI.sheet({
      title: '资产调拨',
      fields: [
        { key: 'from', label: '调出板块', type: 'select', value: Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'to', label: '调入板块', type: 'select', value: Store.BOARD_DEFS[1].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'amount', label: '调拨金额（元）', type: 'number', placeholder: '0.00' },
        { key: 'note', label: '备注', type: 'text', placeholder: '可选' },
      ],
      submitText: '确认调拨',
      onSubmit: (v) => {
        if (v.from === v.to) throw new Error('调出与调入板块不能相同');
        if (!v.amount || Number(v.amount) <= 0) throw new Error('请输入有效金额');
        const t = Date.now();
        Store.addCash(v.from, { type: 'expense', amount: v.amount, note: (v.note ? v.note + ' · ' : '') + '调拨出', time: t });
        Store.addCash(v.to, { type: 'income', amount: v.amount, note: (v.note ? v.note + ' · ' : '') + '调拨入', time: t });
      },
    }).then(() => render());
  }

  function openDcaPlanSheet(edit) {
    const p = edit || {};
    const freq = p.freq || 'monthly';
    const param = (p.param != null) ? p.param : 1;
    const hint = freq === 'weekly' ? '1=周一…7=周日' : (freq === 'interval' ? '间隔天数' : '每月几号(1-28)');
    UI.sheet({
      title: edit ? '编辑定投计划' : '新增定投计划',
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: p.board || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'code', label: '6位基金代码', type: 'text', value: p.code || '', placeholder: '如 110011' },
        { key: 'name', label: '基金名称', type: 'text', value: (p.name && p.name !== '未命名基金') ? p.name : '', placeholder: '可选，刷新时自动获取' },
        { key: 'freq', label: '频率', type: 'select', value: freq, options: [{ value: 'monthly', label: '每月固定日' }, { value: 'weekly', label: '每周固定日' }, { value: 'interval', label: '每隔N天' }] },
        { key: 'param', label: '日期参数（' + hint + '）', type: 'number', value: param, placeholder: hint },
        { key: 'shares', label: '默认定投份额', type: 'number', value: p.shares || '', placeholder: '0.00' },
        { key: 'price', label: '默认成交净值', type: 'number', value: p.price || '', placeholder: '可选，记录时可改' },
        { key: 'note', label: '备注', type: 'text', value: p.note || '', placeholder: '可选' },
      ],
      submitText: '保存',
      onSubmit: (v) => {
        if (!/^\d{6}$/.test((v.code || '').trim())) throw new Error('请输入6位基金代码');
        const plan = {
          board: v.board,
          code: v.code.trim(),
          name: v.name.trim(),
          freq: v.freq,
          param: Number(v.param) || 1,
          shares: Math.max(0, Number(v.shares) || 0),
          price: Math.max(0, Number(v.price) || 0),
          note: (v.note || '').slice(0, 60),
          enabled: true,
        };
        if (edit) { plan.id = p.id; Store.updateDcaPlan(p.id, plan); }
        else Store.addDcaPlan(plan);
      },
    }).then(() => render());
  }

  function openSnapshotHistory() {
    const snaps = Store.state.snapshots;
    const body = snaps.length === 0
      ? '<div class="empty">暂无刷新快照，点击「净值更新」后自动生成</div>'
      : snaps.map(s => {
        const boardLines = (s.boards || []).map(b =>
          '<div class="snap-board"><span>' + b.name + '</span><span>' + UI.fmtMoney(b.total) + '</span></div>').join('');
        return '<div class="snap-item">' +
          '<div class="snap-head"><span>' + UI.fmtTime(s.time) + '</span><span class="' + UI.changeClass(s.todayProfit) + '">' + UI.fmtMoney(s.todayProfit) + '</span></div>' +
          '<div class="snap-sub">投资市值 ' + UI.fmtMoney(s.totalMarketValue) + (s.trading ? ' · 交易时段估值' : ' · 上一交易日净值') + '</div>' +
          boardLines +
          '</div>';
      }).join('');
    UI.sheet({ title: '刷新历史快照（' + snaps.length + '）', fields: [], submitText: '关闭',
      onSubmit: () => {} });
    // 用自定义内容替换 body
    const overlay = document.querySelector('.sheet-overlay .sheet-body');
    if (overlay) overlay.innerHTML = '<div class="snap-list">' + body + '</div>';
  }

  /* ---------------- 渲染：首页 ---------------- */
  function renderHome() {
    const g = Store.globalTotals();
    const ring = buildRing();
    const boardsHtml = Store.BOARD_DEFS.map(b => renderBoardCard(b.key)).join('');
    const reminder = renderDcaReminder();
    return '' +
      (reminder ? reminder : '') +
      '<div class="total-card">' +
      '<div class="total-label">总资产（元）</div>' +
      '<div class="total-value">' + UI.fmtMoney(g.grandTotal) + '</div>' +
      '<div class="total-profit">总盈亏 <span class="' + UI.changeClass(g.totalProfit) + '">' + UI.fmtMoney(g.totalProfit) + '</span></div>' +
      '<div class="ring-wrap">' + ring + '</div>' +
      '</div>' +
      boardsHtml +
      '<div class="quick-bar">' +
      '<button class="quick-btn" data-action="add-cash"><span class="q-ico">✎</span>记一笔</button>' +
      '<button class="quick-btn" data-action="refresh"><span class="q-ico">↻</span>净值更新</button>' +
      '<button class="quick-btn" data-action="transfer"><span class="q-ico">⇄</span>资产调拨</button>' +
      '</div>';
  }

  function buildRing() {
    const g = Store.globalTotals();
    const segs = Store.BOARD_DEFS.map((b, i) => ({ name: b.name, val: Math.max(0, Store.boardTotal(b.key)), color: ['#3b82f6', '#f59e0b', '#10b981'][i] }));
    const total = segs.reduce((s, x) => s + x.val, 0);
    let gradient = '';
    if (total <= 0) {
      gradient = 'conic-gradient(#e5e7eb 0 100%)';
    } else {
      let acc = 0;
      gradient = 'conic-gradient(' + segs.map(s => {
        const start = acc / total * 360;
        acc += s.val;
        const end = acc / total * 360;
        return s.color + ' ' + start + 'deg ' + end + 'deg';
      }).join(',') + ')';
    }
    const legend = segs.map((s, i) =>
      '<div class="legend-item"><span class="dot" style="background:' + s.color + '"></span>' + s.name + ' ' + (total > 0 ? (s.val / total * 100).toFixed(1) : '0.0') + '%</div>').join('');
    return '<div class="ring"><div class="ring-graphic" style="background:' + gradient + '"><div class="ring-hole"><div class="ring-hole-label">投资市值</div><div class="ring-hole-val">' + UI.fmtMoney(g.marketValue) + '</div></div></div>' +
      '<div class="legend">' + legend + '</div></div>';
  }

  function renderDcaReminder() {
    const plans = (Store.state.dcaPlans || []).filter(p => p.enabled !== false && isDue(p));
    if (plans.length === 0) return '';
    const items = plans.map(p =>
      '<div class="dca-item">' +
      '<div class="dca-i-main">' +
      '<div class="dca-i-name">' + escapeHtml(p.name || p.code) + ' <span class="li-code">' + p.code + '</span></div>' +
      '<div class="dca-i-sub">' + boardName(p.board) + ' · 应投 ' + UI.fmtNum(p.shares) + ' 份' + (p.price ? (' @ ' + UI.fmtNum(p.price)) : '') + '</div>' +
      '</div>' +
      '<button class="dca-rec-btn" data-action="dca-record" data-plan="' + p.id + '">记一笔</button>' +
      '</div>').join('');
    return '<div class="dca-reminder">' +
      '<div class="dca-r-head">🔔 你有 ' + plans.length + ' 笔定投待记</div>' +
      items + '</div>';
  }

  function renderBoardCard(boardKey) {
    const def = Store.BOARD_DEFS.find(b => b.key === boardKey);
    const cash = Store.state.boards[boardKey].cash;
    const invest = Store.state.boards[boardKey].invest;
    const cashTotal = Store.cashTotal(boardKey);
    const investTotal = Store.investTotal(boardKey);
    const boardTotal = Store.boardTotal(boardKey);
    const investProfit = Store.boardInvestTotalProfit(boardKey);
    const folded = foldState[boardKey];
    const cashHtml = cash.length === 0 ? '' : cash.map(c => swipeItem({
      kind: 'cash', board: boardKey, id: c.id,
      main: '<div class="li-title">' + (c.type === 'expense' ? '支出' : '收入') + (c.note ? ' · ' + escapeHtml(c.note) : '') + '</div>' +
        '<div class="li-sub">' + UI.fmtTime(c.time) + '</div>',
      right: '<div class="li-amount ' + (c.type === 'expense' ? 'down' : 'up') + '">' + (c.type === 'expense' ? '-' : '+') + UI.fmtMoney(c.amount) + '</div>',
    })).join('');
    const investHtml = invest.length === 0 ? '' : invest.map(h => swipeItem({
      kind: 'invest', board: boardKey, id: h.id,
      main: '<div class="li-title">' + escapeHtml(h.name) + ' <span class="li-code">' + h.code + '</span></div>' +
        '<div class="li-sub">份额 ' + UI.fmtNum(h.shares) + ' · 成本 ' + UI.fmtNum(h.avgCost) + '</div>',
      right: '<div class="li-amount">' + UI.fmtMoney(h.marketValue) + '</div>' +
        '<div class="li-pct ' + UI.changeClass(h.todayChangePct) + '">' + UI.fmtPct(h.todayChangePct) + '</div>',
    })).join('');
    const empty = (cash.length === 0 && invest.length === 0) ? '<div class="empty">暂无记录，点击下方明细「+」添加</div>' : '';
    const detailHtml = '' +
      '<div class="board-detail">' +
      '<div class="bd-row">' +
      '<span class="bd-label">💰 现金</span>' +
      '<span class="bd-val">' + UI.fmtMoney(cashTotal) + '</span>' +
      '<button class="bd-add" data-action="add-cash-board" data-board="' + boardKey + '" title="记一笔现金收支">＋</button>' +
      '</div>' +
      '<div class="bd-row">' +
      '<span class="bd-label">📈 投资</span>' +
      '<span class="bd-val">' + UI.fmtMoney(investTotal) + '</span>' +
      '<button class="bd-add" data-action="add-invest-board" data-board="' + boardKey + '" title="新增基金持仓">＋</button>' +
      '<button class="bd-sell" data-action="sell-invest-board" data-board="' + boardKey + '" title="卖出基金持仓">卖</button>' +
      '</div>' +
      '</div>';
    return '' +
      '<section class="board-card">' +
      '<div class="board-head" data-action="toggle-fold" data-board="' + boardKey + '">' +
      '<div class="bh-left"><div class="board-name">' + def.name + '</div>' +
      '<div class="board-sub">现金 ' + UI.fmtMoney(cashTotal) + ' · 投资 ' + UI.fmtMoney(investTotal) + '</div></div>' +
      '<div class="bh-right"><div class="board-total">' + UI.fmtMoney(boardTotal) + '</div>' +
      '<div class="board-profit ' + UI.changeClass(investProfit) + '">累计 ' + UI.fmtMoney(investProfit) + '</div></div>' +
      '<span class="fold-icon">' + (folded ? '▸' : '▾') + '</span>' +
      '</div>' +
      (folded ? '' :
        '<div class="board-body">' + detailHtml + cashHtml + investHtml + empty +
        '<button class="record-btn" data-action="record" data-board="' + boardKey + '">+ 记录到「' + def.name + '」</button>' +
        '</div>') +
      '</section>';
  }

  /* ---------------- 渲染：投资专区 ---------------- */
  function renderInvest() {
    let holdings = Store.allHoldings();
    if (investFilter.board !== 'all') holdings = holdings.filter(h => h.boardKey === investFilter.board);
    if (investFilter.kw) {
      const kw = investFilter.kw.toLowerCase();
      holdings = holdings.filter(h => (h.code + h.name).toLowerCase().includes(kw));
    }
    const listHtml = holdings.length === 0
      ? '<div class="empty">暂无持仓' + (Store.allHoldings().length === 0 ? '，点击下方「+ 添加持仓」开始' : '') + '</div>'
      : holdings.map(h => renderHoldingRow(h)).join('');
    const trades = Store.state.trades.filter(t => investFilter.board === 'all' || t.board === investFilter.board);
    const tradeHtml = trades.length === 0
      ? '<div class="empty">暂无交易记录</div>'
      : trades.map(t => {
        const def = Store.BOARD_DEFS.find(b => b.key === t.board);
        return swipeItem({
          kind: 'trade', board: t.board, id: t.id,
          main: '<div class="li-title"><span class="' + (t.action === 'buy' ? 'up' : 'down') + '">' + (t.action === 'buy' ? '买入' : '卖出') + '</span> ' + t.code + (t.note ? ' · ' + escapeHtml(t.note) : '') + '</div>' +
            '<div class="li-sub">' + def.name + ' · ' + UI.fmtTime(t.time) + '</div>',
          right: '<div class="li-amount">份额 ' + UI.fmtNum(t.shares) + '</div><div class="li-sub">净值 ' + UI.fmtNum(t.price) + '</div>',
        });
      }).join('');

    return '' +
      '<div class="filter-bar">' +
      '<select class="f-select" data-filter="board">' + '<option value="all">全部板块</option>' + boardSelectOptions(investFilter.board) + '</select>' +
      '<input class="f-input" data-filter="kw" placeholder="搜索代码/名称" value="' + (investFilter.kw || '') + '">' +
      '<button class="btn-mini" data-action="refresh-invest">↻ 刷新</button>' +
      '</div>' +
      '<div class="section-head"><span>全部持仓（' + holdings.length + '）</span><button class="btn-mini primary" data-action="add-holding">+ 添加持仓</button></div>' +
      listHtml +
      '<div class="section-head"><span>交易记录（' + trades.length + '）</span><button class="btn-mini" data-action="snapshot-history">刷新历史</button></div>' +
      tradeHtml;
  }

  function renderHoldingRow(h) {
    const expanded = expandedHoldings.has(h.id);
    const isDca = Store.state.trades.some(t => t.code === h.code && t.board === h.boardKey && t.dca);
    const w = periodReturn(h.navHistory, 7);
    const m = periodReturn(h.navHistory, 30);
    const q = periodReturn(h.navHistory, 90);
    const y = periodReturn(h.navHistory, 365);
    const rt = v => v === null ? '<span class="muted">—</span>' : '<span class="' + UI.changeClass(v) + '">' + UI.fmtPct(v) + '</span>';
    const detail = expanded ? '' +
      '<div class="hold-detail">' +
      '<div class="hd-grid">' +
      '<div><span class="muted">最新净值</span>' + UI.fmtNum(h.lastNav) + '</div>' +
      '<div><span class="muted">平均成本</span>' + UI.fmtNum(h.avgCost) + '</div>' +
      '<div><span class="muted">持仓份额</span>' + UI.fmtNum(h.shares) + '</div>' +
      '<div><span class="muted">市值</span>' + UI.fmtMoney(h.marketValue) + '</div>' +
      '</div>' +
      '<div class="hd-returns">' +
      '<div>近1周 ' + rt(w) + '</div><div>近1月 ' + rt(m) + '</div>' +
      '<div>近3月 ' + rt(q) + '</div><div>近1年 ' + rt(y) + '</div>' +
      '</div>' +
      '<div class="hd-actions">' +
      '<button class="btn-mini" data-action="edit-holding" data-board="' + h.boardKey + '" data-id="' + h.id + '">编辑</button>' +
      '<button class="btn-mini danger" data-action="delete-invest" data-board="' + h.boardKey + '" data-id="' + h.id + '">删除</button>' +
      '</div></div>' : '';
    return '' +
      '<div class="hold-row" data-action="expand" data-id="' + h.id + '">' +
      '<div class="hold-main">' +
      '<div class="li-title">' + escapeHtml(h.name) + ' <span class="li-code">' + h.code + '</span>' + (isDca ? ' <span class="dca-badge">定投</span>' : '') + '</div>' +
      '<div class="li-sub">' + h.boardName + ' · 份额 ' + UI.fmtNum(h.shares) + '</div>' +
      '</div>' +
      '<div class="hold-right">' +
      '<div class="li-amount">' + UI.fmtMoney(h.marketValue) + '</div>' +
      '<div class="li-pct ' + UI.changeClass(h.todayChangePct) + '">' + UI.fmtPct(h.todayChangePct) + '</div>' +
      '<div class="li-pct ' + UI.changeClass(h.totalProfit) + '">累计 ' + UI.fmtMoney(h.totalProfit) + '</div>' +
      '</div>' +
      (expanded ? '<span class="expand-ico">▴</span>' : '<span class="expand-ico">▾</span>') +
      '</div>' +
      '<div class="hold-actions">' +
      '<button class="btn-mini" data-action="trade" data-board="' + h.boardKey + '" data-id="' + h.id + '" data-dir="buy">买入</button>' +
      '<button class="btn-mini dca-btn" data-action="dca" data-board="' + h.boardKey + '" data-id="' + h.id + '">定投</button>' +
      '<button class="btn-mini" data-action="trade" data-board="' + h.boardKey + '" data-id="' + h.id + '" data-dir="sell">卖出</button>' +
      '</div>' + detail;
  }

  /* ---------------- 渲染：收支明细 ---------------- */
  function renderLedger() {
    let items = Store.allCash().sort((a, b) => b.time - a.time);
    if (ledgerFilter.board !== 'all') items = items.filter(c => c.boardKey === ledgerFilter.board);
    const html = items.length === 0
      ? '<div class="empty">暂无收支记录</div>'
      : items.map(c => swipeItem({
        kind: 'cash', board: c.boardKey, id: c.id,
        main: '<div class="li-title">' + (c.type === 'expense' ? '支出' : '收入') + ' · ' + c.boardName + (c.note ? ' · ' + escapeHtml(c.note) : '') + '</div>' +
          '<div class="li-sub">' + UI.fmtTime(c.time) + '</div>',
        right: '<div class="li-amount ' + (c.type === 'expense' ? 'down' : 'up') + '">' + (c.type === 'expense' ? '-' : '+') + UI.fmtMoney(c.amount) + '</div>',
      })).join('');
    return '' +
      '<div class="filter-bar">' +
      '<select class="f-select" data-filter="ledger-board"><option value="all">全部板块</option>' + boardSelectOptions(ledgerFilter.board) + '</select>' +
      '<span class="muted">共 ' + items.length + ' 条</span>' +
      '</div>' + html;
  }

  /* ---------------- 渲染：个人中心 ---------------- */
  function renderProfile() {
    const s = Store.state.settings;
    const plans = Store.state.dcaPlans || [];
    const schemeOpts = '<option value="redUp"' + (s.colorScheme === 'redUp' ? ' selected' : '') + '>红涨绿跌</option>' +
      '<option value="greenUp"' + (s.colorScheme === 'greenUp' ? ' selected' : '') + '>绿涨红跌</option>';
    const snapOpts = [10, 20, 30, 50, 100].map(n =>
      '<option value="' + n + '"' + (s.snapshotLimit === n ? ' selected' : '') + '>' + n + ' 条</option>').join('');
    return '' +
      '<div class="profile-card">' +
      '<div class="pc-title">显示与配色</div>' +
      '<div class="pc-row"><span>隐藏金额</span>' + toggle('hideAmount', s.hideAmount) + '</div>' +
      '<div class="pc-row"><span>涨跌配色</span><select class="f-select" data-setting="colorScheme">' + schemeOpts + '</select></div>' +
      '</div>' +
      '<div class="profile-card">' +
      '<div class="pc-title">投资专区</div>' +
      '<div class="pc-row"><span>进入投资页自动刷新净值</span>' + toggle('autoRefreshInvest', s.autoRefreshInvest) + '</div>' +
      '<div class="pc-row"><span>刷新历史最大留存</span><select class="f-select" data-setting="snapshotLimit">' + snapOpts + '</select></div>' +
      '</div>' +
      '<div class="profile-card">' +
      '<div class="pc-title">定投计划</div>' +
      (plans.length === 0
        ? '<div class="empty" style="padding:10px 0">还没有定投计划，点下方添加</div>'
        : plans.map(p => {
            const due = isDue(p);
            return '<div class="dca-plan-row" data-action="edit-dca" data-id="' + p.id + '">' +
              '<div class="dca-p-main">' +
              '<div class="li-title">' + escapeHtml(p.name || p.code) + ' <span class="li-code">' + p.code + '</span></div>' +
              '<div class="li-sub">' + boardName(p.board) + ' · ' + freqLabel(p) + (due ? ' · <span class="due-tag">待记</span>' : '') + '</div>' +
              '</div>' +
              '<button class="btn-mini danger" data-action="delete-dca" data-id="' + p.id + '">删除</button>' +
              '</div>';
          }).join('')) +
      '<div class="pc-row clickable" data-action="add-dca"><span>＋ 新增定投计划</span><span>›</span></div>' +
      '</div>' +
      '<div class="profile-card">' +
      '<div class="pc-title">数据管理</div>' +
      '<div class="pc-row clickable" data-action="export"><span>导出备份（JSON）</span><span>›</span></div>' +
      '<div class="pc-row clickable" data-action="import"><span>导入备份（JSON）</span><span>›</span></div>' +
      '<div class="pc-row clickable danger" data-action="reset"><span>清空全部数据</span><span>›</span></div>' +
      '</div>' +
      '<div class="about">家庭财务助手 · 纯私密理财工具<br>' +
      (window.Remote && Remote.isEnabled()
        ? '数据已云端同步，多设备用同一口令登录即共享账本'
        : '数据仅存储于本机，请定期导出备份') +
      '</div>';
  }
  function toggle(key, on) {
    return '<label class="switch"><input type="checkbox" data-setting="' + key + '"' + (on ? ' checked' : '') + '><span class="slider"></span></label>';
  }

  /* ---------------- 通用片段 ---------------- */
  function swipeItem(o) {
    return '' +
      '<div class="swipe-item" data-kind="' + o.kind + '" data-board="' + o.board + '" data-id="' + o.id + '">' +
      '<div class="swipe-inner"><div class="li">' + o.main + o.right + '</div></div>' +
      '<button class="swipe-del" data-action="delete-' + o.kind + '" data-board="' + o.board + '" data-id="' + o.id + '">删除</button>' +
      '</div>';
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 顶层渲染 ---------------- */
  function render() {
    const page = document.getElementById('page');
    let html = '';
    if (currentTab === 'home') html = renderHome();
    else if (currentTab === 'invest') html = renderInvest();
    else if (currentTab === 'ledger') html = renderLedger();
    else if (currentTab === 'profile') html = renderProfile();
    page.innerHTML = html;
    page.scrollTop = 0;
    bindSwipe(page);
    // 标题
    const titles = { home: '资产总览', invest: '投资专区', ledger: '收支明细', profile: '个人中心' };
    document.getElementById('top-title').textContent = titles[currentTab];
    // tab 高亮
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  }

  /* ---------------- 事件委托 ---------------- */
  function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const board = el.dataset.board, id = el.dataset.id;

    if (a === 'toggle-hide') {
      Store.updateSettings({ hideAmount: !Store.state.settings.hideAmount });
      render(); return;
    }
    if (a === 'record') { openCashSheet(board); return; }
    if (a === 'add-cash-board') { openCashSheet(board); return; }
    if (a === 'add-invest-board') { openHoldingSheet(board, null); return; }
    if (a === 'sell-invest-board') { openSellBoard(board); return; }
    if (a === 'add-cash') { openCashSheet(null); return; }
    if (a === 'refresh' || a === 'refresh-invest') { refreshAll(true); return; }
    if (a === 'transfer') { openTransferSheet(); return; }
    if (a === 'toggle-fold') { foldState[board] = !foldState[board]; render(); return; }
    if (a === 'add-holding') { openHoldingSheet(null, null); return; }
    if (a === 'edit-holding') { const h = Store.state.boards[board].invest.find(x => x.id === id); openHoldingSheet(board, h); return; }
    if (a === 'delete-invest') {
      UI.confirm({ title: '删除持仓', message: '确认删除该持仓？删除后相关交易记录仍保留。', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteHolding(board, id); expandedHoldings.delete(id); render(); }
      }); return;
    }
    if (a === 'delete-cash') {
      UI.confirm({ title: '删除记录', message: '确认删除该条收支记录？', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteCash(board, id); render(); }
      }); return;
    }
    if (a === 'delete-trade') {
      UI.confirm({ title: '删除交易', message: '确认删除该条交易记录？持仓份额不会自动回滚。', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteTrade(id); render(); }
      }); return;
    }
    if (a === 'expand') { if (expandedHoldings.has(id)) expandedHoldings.delete(id); else expandedHoldings.add(id); render(); return; }
    if (a === 'trade') {
      const h = Store.state.boards[board].invest.find(x => x.id === id);
      openTradeSheet({ board: board, code: h ? h.code : '', action: el.dataset.dir || 'buy' }); return;
    }
    if (a === 'dca') {
      const h = Store.state.boards[board].invest.find(x => x.id === id);
      openTradeSheet({ board: board, code: h ? h.code : '', action: 'buy', dca: true }); return;
    }
    if (a === 'dca-record') {
      const plan = (Store.state.dcaPlans || []).find(x => x.id === el.dataset.plan);
      if (!plan) return;
      openTradeSheet({ board: plan.board, code: plan.code, action: 'buy', dca: true, shares: plan.shares, price: plan.price, note: plan.note });
      return;
    }
    if (a === 'add-dca') { openDcaPlanSheet(null); return; }
    if (a === 'edit-dca') {
      const plan = (Store.state.dcaPlans || []).find(x => x.id === id);
      if (plan) openDcaPlanSheet(plan);
      return;
    }
    if (a === 'delete-dca') {
      UI.confirm({ title: '删除定投计划', message: '确认删除该定投计划？已记录的定投交易保留。', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteDcaPlan(id); render(); }
      });
      return;
    }
    if (a === 'snapshot-history') { openSnapshotHistory(); return; }
    if (a === 'export') { exportData(); return; }
    if (a === 'import') { importData(); return; }
    if (a === 'reset') {
      UI.confirm({ title: '清空全部数据', message: '将删除所有资产、交易与快照，且不可恢复。建议先导出备份。', okText: '清空' }).then(ok => {
        if (ok) { Store.resetAll(); expandedHoldings.clear(); render(); UI.toast('已清空'); }
      }); return;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset && t.dataset.filter) {
      const f = t.dataset.filter;
      if (f === 'board') investFilter.board = t.value;
      if (f === 'kw') investFilter.kw = t.value;
      if (f === 'ledger-board') { ledgerFilter.board = t.value; render(); return; }
      render(); return;
    }
    if (t.dataset && t.dataset.setting) {
      const k = t.dataset.setting;
      if (k === 'colorScheme') { Store.updateSettings({ colorScheme: t.value }); UI.setScheme(); }
      else if (k === 'snapshotLimit') { Store.updateSettings({ snapshotLimit: Number(t.value) }); }
      else if (k === 'hideAmount') { Store.updateSettings({ hideAmount: t.checked }); }
      else if (k === 'autoRefreshInvest') { Store.updateSettings({ autoRefreshInvest: t.checked }); }
      render(); return;
    }
  }

  /* ---------------- 导入 / 导出 ---------------- */
  function exportData() {
    const data = JSON.stringify(Store.state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = 'ffa-backup-' + d.getFullYear() + UI.pad(d.getMonth() + 1) + UI.pad(d.getDate()) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    UI.toast('已导出备份');
  }
  function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          UI.confirm({ title: '导入备份', message: '将覆盖当前全部数据，确认导入？', okText: '导入' }).then(ok => {
            if (ok) {
              Store.replaceState(parsed);
              expandedHoldings.clear();
              render();
              UI.toast('导入成功');
            }
          });
        } catch (err) { UI.toast('文件解析失败'); }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  /* ---------------- 后端认证 / 登录流程 ---------------- */
  function showAuth(setup) {
    const screen = document.getElementById('auth-screen');
    const title = document.getElementById('auth-title');
    const desc = document.getElementById('auth-desc');
    const passEl = document.getElementById('auth-pass');
    const errEl = document.getElementById('auth-err');
    title.textContent = setup ? '设置访问口令' : '输入访问口令';
    desc.textContent = setup
      ? '首次使用请设置一个口令（至少 4 位）；之后所有设备用同一口令登录，即可共享同一账本。'
      : '请输入你的访问口令以同步云端账本。';
    errEl.textContent = '';
    passEl.value = '';
    screen.classList.remove('hidden');

    return new Promise((resolve) => {
      const submit = async () => {
        const pass = passEl.value.trim();
        if (pass.length < 4) { errEl.textContent = '口令至少 4 位'; return; }
        try {
          if (setup) await Remote.setup(pass); else await Remote.login(pass);
          // 登录成功：拉取云端账本覆盖本地
          Remote.setSuppress(true);
          const data = await Remote.pull();
          Remote.setSuppress(false);
          if (data) Store.replaceState(data); else Store.resetAll();
          screen.classList.add('hidden');
          document.removeEventListener('keydown', onKey);
          btn.removeEventListener('click', submit);
          resolve(true);
        } catch (e) {
          Remote.setSuppress(false);
          errEl.textContent = (e && e.message) || '操作失败，请重试';
        }
      };
      const onKey = (e) => { if (e.key === 'Enter') submit(); };
      const btn = document.getElementById('auth-submit');
      btn.addEventListener('click', submit);
      document.addEventListener('keydown', onKey);
    });
  }

  async function ensureAuthed() {
    const st = await Remote.status();
    if (!Remote.getToken()) { await showAuth(!st.setup); return; }
    try {
      Remote.setSuppress(true);
      const data = await Remote.pull();
      Remote.setSuppress(false);
      if (data) Store.replaceState(data); else Store.resetAll();
    } catch (e) {
      Remote.setSuppress(false);
      Remote.setToken('');           // token 失效，重新登录
      await showAuth(false);
    }
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    UI.setScheme();
    // 绑定 tab
    document.querySelectorAll('.tabbar button').forEach(b => {
      b.addEventListener('click', () => {
        currentTab = b.dataset.tab;
        if (currentTab === 'invest' && Store.state.settings.autoRefreshInvest) refreshAll(false);
        render();
      });
    });
    document.getElementById('page').addEventListener('click', onClick);
    document.getElementById('page').addEventListener('change', onChange);
    document.getElementById('eye-btn').addEventListener('click', () => {
      Store.updateSettings({ hideAmount: !Store.state.settings.hideAmount });
      render();
    });

    // 自动探测后端：存在则进入「云端多设备」模式，否则保持本地模式
    let remote = false;
    try { remote = await Remote.ping(); } catch (e) { remote = false; }
    if (remote) {
      Remote.setEnabled(true);
      await ensureAuthed();
    } else {
      Remote.setEnabled(false);
    }

    render();

    // PWA Service Worker（仅在 http/https 下注册）
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  window.App = { init, render, refreshAll };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
