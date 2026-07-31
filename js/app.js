/* app.js —— 路由、页面渲染与全部交互逻辑 */
(function () {
  'use strict';

  const APP_VERSION = '2026-08-01-1';

  const TABS = [
    { key: 'home', label: '首页' },
    { key: 'invest', label: '投资专区' },
    { key: 'ledger', label: '收支明细' },
    { key: 'profile', label: '个人中心' },
  ];

  let currentTab = 'home';
  const expandedItems = new Set();      // 已展开的明细行 id（现金/投资通用，点击才显示操作）
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
  /* 兼容后端返回的旧字段结构 */
  function adaptQuote(d) {
    if (!d) return null;
    if (d.nav !== undefined) return d;                 // 已是新结构
    const nav = Number(d.dwjz) || 0;
    return {
      code: d.code || '', name: d.name || '',
      nav: nav, navDate: d.jzrq || '', navChangePct: 0, prevNav: nav,
      gsz: Number(d.gsz) || 0, gszzl: Number(d.gszzl) || 0, gztime: d.gztime || '',
      hasEstimate: (Number(d.gsz) || 0) > 0,
    };
  }

  async function fetchQuotes(codes) {
    if (window.Remote && Remote.isEnabled()) {
      const map = {};
      for (const c of codes) {
        try { map[c] = adaptQuote(await Remote.quote(c)); } catch (e) { /* 单只失败忽略 */ }
      }
      return map;
    }
    return await FundAPI.getBatch(codes);
  }

  async function refreshAll(showToast) {
    if (refreshing) return;
    const holdings = Store.allHoldings();
    if (holdings.length === 0) { if (showToast) UI.toast('暂无持仓可刷新'); return; }
    refreshing = true;
    setRefreshingUI(true);
    if (showToast) UI.toast('正在获取最新净值…');

    const trading = FundAPI.isTradingTime();
    const fundHoldings = holdings.filter(h => h.kind !== 'gold');
    const goldHoldings = holdings.filter(h => h.kind === 'gold');
    const codes = [];
    fundHoldings.forEach(h => { if (h.code && /^\d{6}$/.test(h.code) && codes.indexOf(h.code) === -1) codes.push(h.code); });

    let map = {}, netError = null;
    try {
      // 兜底超时：任何情况下都不能让刷新状态卡死，否则之后再也点不动刷新
      map = await Promise.race([
        fetchQuotes(codes),
        new Promise((_, rej) => setTimeout(() => rej(new Error('网络超时，请稍后重试')), 20000)),
      ]);
    } catch (e) { netError = e; }

    let ok = 0, fail = 0;
    let navDate = '';
    if (!netError) {
      for (const h of fundHoldings) {
        const d = map[h.code];
        if (!d || !d.nav) { fail++; continue; }
        // 交易时段且有盘中估值 → 用估值；否则用官方已公布净值
        const useEst = trading && d.hasEstimate;
        const latestNav = useEst ? d.gsz : d.nav;
        const prevNav = useEst ? d.nav : d.prevNav;
        const todayChangePct = useEst ? d.gszzl : d.navChangePct;
        // 展示用净值日期：盘中估算记「当日」，官方净值记接口返回的净值日（如 7.29）
        const showDate = useEst ? todayYMD() : (d.navDate || '');
        Store.updateHolding(h.boardKey, h.id, {
          name: d.name || h.name,
          lastNav: latestNav,
          prevNav: prevNav,
          navDate: showDate,
          estMode: useEst,
          todayChangePct: todayChangePct,
          marketValue: h.shares * latestNav,
          todayProfit: (latestNav - prevNav) * h.shares,
          totalProfit: (latestNav - h.avgCost) * h.shares,
          navHistory: pushNav(h.navHistory, { t: Date.now(), nav: latestNav }),
        });
        if (!navDate) navDate = d.navDate || '';
        ok++;
      }
      // 实体黄金：统一拉一次金价，刷新所有黄金持仓市值
      if (goldHoldings.length) {
        let gp = null, gerr = null;
        try {
          gp = await Promise.race([
            GoldAPI.getPrice(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('金价获取超时')), 20000)),
          ]);
        } catch (e) { gerr = e; }
        if (gp && gp.price > 0) {
          for (const h of goldHoldings) {
            const prev = h.lastNav || 0;
            const price = gp.price;
            const chg = prev > 0 ? (price - prev) / prev * 100 : 0;
            Store.updateHolding(h.boardKey, h.id, {
              name: h.name || '如意金(实体黄金)',
              lastNav: price,
              prevNav: prev,
              navDate: '',
              todayChangePct: chg,
              marketValue: h.shares * price,
              todayProfit: (price - prev) * h.shares,
              totalProfit: (price - h.avgCost) * h.shares,
              navHistory: pushNav(h.navHistory, { t: Date.now(), nav: price }),
            });
            if (!navDate) navDate = '金价 ' + (gp.updatedAt ? String(gp.updatedAt).slice(0, 10) : '');
            ok++;
          }
        } else {
          goldHoldings.forEach(() => fail++);
          if (goldHoldings.length && ok === 0 && !netError && gerr) netError = gerr;
        }
      }
      const g = Store.globalTotals();
      Store.addSnapshot({
        time: Date.now(),
        trading: trading,
        navDate: navDate,
        totalMarketValue: g.marketValue,
        todayProfit: g.todayProfit,
        boards: Store.BOARD_DEFS.map(b => ({ key: b.key, name: b.name, total: Store.boardTotal(b.key) })),
        items: Store.allHoldings().map(h => ({
          code: h.code, name: h.name, nav: h.lastNav, marketValue: h.marketValue, changePct: h.todayChangePct,
        })),
      });
      Store.setLastRefresh({ time: Date.now(), ok: ok, fail: fail, trading: trading, navDate: navDate });
    }

    refreshing = false;
    setRefreshingUI(false);
    render();
    if (!showToast) return;
    if (netError) { UI.toast('刷新失败：' + (netError.message || '网络异常，请检查网络')); return; }
    if (ok === 0) { UI.toast('未获取到净值，请检查基金代码是否正确'); return; }
    const src = (trading ? '盘中估值' : '官方净值' + (navDate ? '（' + navDate + '）' : ''));
    UI.toast(fail === 0
      ? ('已更新 ' + ok + ' 只 · ' + src)
      : ('更新 ' + ok + ' 只，' + fail + ' 只失败 · ' + src));
  }

  function setRefreshingUI(on) {
    document.querySelectorAll('[data-action="refresh"], [data-action="refresh-invest"], #refresh-btn').forEach(b => {
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
      const isInteractive = (t) => !!(t && t.closest && t.closest('button,[data-action],input,textarea,select,a'));
      item.addEventListener('touchstart', e => { if (isInteractive(e.target)) return; start(e.touches[0].clientX); }, { passive: true });
      item.addEventListener('touchmove', e => move(e.touches[0].clientX), { passive: true });
      item.addEventListener('touchend', end);
      item.addEventListener('mousedown', e => {
        if (isInteractive(e.target)) return;
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

  /* 持仓录入：份额 / 总金额 / 平均成本 三者联动
   * 按份额：填「份额 + 平均成本」→ 自动算总金额
   * 按金额：填「总金额 + 平均成本」→ 自动算份额
   */
  function openHoldingSheet(presetBoard, edit) {
    const h = edit || {};
    const initShares = Number(h.shares) || 0;
    const initCost = Number(h.avgCost) || 0;
    const initAmount = initShares > 0 && initCost > 0 ? (initShares * initCost) : 0;
    UI.sheet({
      title: edit ? '编辑持仓' : '新增投资持仓',
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: presetBoard || h.boardKey || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'code', label: '6位基金代码', type: 'text', value: h.code || '', placeholder: '如 110011' },
        { key: 'name', label: '基金名称', type: 'text', value: h.name && h.name !== '未命名基金' ? h.name : '', placeholder: '可选，刷新时自动获取' },
        {
          key: 'mode', label: '录入方式', type: 'segmented', value: 'shares',
          options: [{ value: 'shares', label: '按份额' }, { value: 'amount', label: '按总金额' }],
        },
        { key: 'avgCost', label: '平均成本（元/份）', type: 'number', value: initCost || '', placeholder: '0.000' },
        { key: 'shares', label: '持仓份额', type: 'number', value: initShares || '', placeholder: '0.00' },
        { key: 'amount', label: '总金额（元）', type: 'number', value: initAmount ? initAmount.toFixed(2) : '', placeholder: '0.00' },
      ],
      onInput: (v, api) => {
        const cost = Number(v.avgCost) || 0;
        if (v.mode === 'amount') {
          api.readonly('shares', true); api.readonly('amount', false);
          const amt = Number(v.amount) || 0;
          const sh = cost > 0 ? amt / cost : 0;
          api.set('shares', sh > 0 ? sh.toFixed(2) : '');
          api.hint('shares', cost > 0 ? '由总金额 ÷ 平均成本自动算出' : '请先填写平均成本');
          api.hint('amount', '');
        } else {
          api.readonly('shares', false); api.readonly('amount', true);
          const sh = Number(v.shares) || 0;
          const amt = sh * cost;
          api.set('amount', amt > 0 ? amt.toFixed(2) : '');
          api.hint('amount', cost > 0 ? '由份额 × 平均成本自动算出' : '请先填写平均成本');
          api.hint('shares', '');
        }
      },
      submitText: '保存',
      onSubmit: (v) => {
        if (!/^\d{6}$/.test((v.code || '').trim())) throw new Error('请输入6位基金代码');
        const cost = Number(v.avgCost) || 0;
        let shares = Number(v.shares) || 0;
        if (v.mode === 'amount') {
          const amt = Number(v.amount) || 0;
          if (amt <= 0) throw new Error('请输入有效总金额');
          if (cost <= 0) throw new Error('按总金额录入时必须填写平均成本');
          shares = amt / cost;
        }
        if (shares <= 0) throw new Error('请输入有效份额');
        const patch = { code: v.code.trim(), name: (v.name || '').trim() || '未命名基金', shares: shares, avgCost: cost };
        if (edit) Store.updateHolding(presetBoard || h.boardKey, h.id, patch);
        else Store.addHolding(v.board, patch);
      },
    }).then(() => render());
  }

  /* 实体黄金（如意金）录入：克数 + 买入均价(元/克)，金价刷新自动获取 */
  function openGoldSheet(presetBoard, edit) {
    const h = edit || {};
    const initGrams = Number(h.shares) || 0;
    const initCostG = Number(h.avgCost) || 0;
    const initAmount = initGrams > 0 && initCostG > 0 ? (initGrams * initCostG) : 0;
    UI.sheet({
      title: edit ? '编辑实体黄金' : '新增实体黄金（如意金）',
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: presetBoard || h.boardKey || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'name', label: '名称', type: 'text', value: h.name && h.name !== '如意金(实体黄金)' ? h.name : '', placeholder: '如 如意金积存' },
        {
          key: 'mode', label: '录入方式', type: 'segmented', value: 'shares',
          options: [{ value: 'shares', label: '按克数' }, { value: 'amount', label: '按金额' }],
        },
        { key: 'avgCost', label: '买入均价（元/克）', type: 'number', value: initCostG || '', placeholder: '0.000' },
        { key: 'shares', label: '持有克数', type: 'number', value: initGrams || '', placeholder: '0.000' },
        { key: 'amount', label: '总金额（元）', type: 'number', value: initAmount ? initAmount.toFixed(2) : '', placeholder: '0.00' },
        { key: 'note', label: '说明', type: 'note', value: '如意金价格点「刷新净值」自动获取（国际金价换算，单位 元/克）' },
      ],
      onInput: (v, api) => {
        const cost = Number(v.avgCost) || 0;
        if (v.mode === 'amount') {
          api.readonly('shares', true); api.readonly('amount', false);
          const amt = Number(v.amount) || 0;
          const sh = cost > 0 ? amt / cost : 0;
          api.set('shares', sh > 0 ? sh.toFixed(3) : '');
          api.hint('shares', cost > 0 ? '由总金额 ÷ 均价自动算出' : '请先填写买入均价');
          api.hint('amount', '');
        } else {
          api.readonly('shares', false); api.readonly('amount', true);
          const sh = Number(v.shares) || 0;
          const amt = sh * cost;
          api.set('amount', amt > 0 ? amt.toFixed(2) : '');
          api.hint('amount', cost > 0 ? '由克数 × 均价自动算出' : '请先填写买入均价');
          api.hint('shares', '');
        }
      },
      submitText: '保存',
      onSubmit: (v) => {
        const cost = Number(v.avgCost) || 0;
        let grams = Number(v.shares) || 0;
        if (v.mode === 'amount') {
          const amt = Number(v.amount) || 0;
          if (amt <= 0) throw new Error('请输入有效总金额');
          if (cost <= 0) throw new Error('按金额录入时必须填写买入均价');
          grams = amt / cost;
        }
        if (grams <= 0) throw new Error('请输入有效克数');
        const name = (v.name || '').trim() || '如意金(实体黄金)';
        const patch = { kind: 'gold', code: 'RUYI', name: name, shares: grams, avgCost: cost };
        if (edit) Store.updateHolding(presetBoard || h.boardKey, h.id, patch);
        else Store.addHolding(v.board, patch);
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
    const initMode = preset.mode === 'amount' ? 'amount' : 'shares';
    UI.sheet({
      title: isSell ? '卖出登记' : (preset.dca ? '定投登记' : '买入登记'),
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: preset.board || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'code', label: '基金代码', type: 'text', value: preset.code || '', placeholder: '如 110011' },
        { key: 'action', label: '方向', type: 'select', value: preset.action || 'buy', options: [{ value: 'buy', label: '买入' }, { value: 'sell', label: '卖出' }] },
        ...dcaField,
        {
          key: 'mode', label: '录入方式', type: 'segmented', value: initMode,
          options: [{ value: 'shares', label: '按份额' }, { value: 'amount', label: '按金额' }],
        },
        { key: 'price', label: '成交净值', type: 'number', value: preset.price || '', placeholder: '0.0000' },
        { key: 'shares', label: '交易份额', type: 'number', value: preset.shares || '', placeholder: '0.00' },
        { key: 'amount', label: '交易金额（元）', type: 'number', value: preset.amount || '', placeholder: '0.00' },
        { key: 'note', label: '备注', type: 'text', value: preset.note || '', placeholder: '可选' },
      ],
      onInput: (v, api) => {
        const price = Number(v.price) || 0;
        if (v.mode === 'amount') {
          api.readonly('shares', true); api.readonly('amount', false);
          const amt = Number(v.amount) || 0;
          const sh = price > 0 ? amt / price : 0;
          api.set('shares', sh > 0 ? sh.toFixed(2) : '');
          api.hint('shares', price > 0 ? '由金额 ÷ 成交净值自动算出' : '请先填写成交净值');
          api.hint('amount', '');
        } else {
          api.readonly('shares', false); api.readonly('amount', true);
          const sh = Number(v.shares) || 0;
          const amt = sh * price;
          api.set('amount', amt > 0 ? amt.toFixed(2) : '');
          api.hint('amount', price > 0 ? '由份额 × 成交净值自动算出' : '请先填写成交净值');
          api.hint('shares', '');
        }
      },
      submitText: '登记',
      onSubmit: (v) => {
        if (!/^\d{6}$/.test((v.code || '').trim())) throw new Error('请输入6位基金代码');
        const price = Number(v.price) || 0;
        if (price <= 0) throw new Error('请输入有效成交净值');
        let shares = Number(v.shares) || 0;
        if (v.mode === 'amount') {
          const amt = Number(v.amount) || 0;
          if (amt <= 0) throw new Error('请输入有效交易金额');
          shares = amt / price;
        }
        if (shares <= 0) throw new Error('请输入有效份额');
        Store.addTrade({
          board: v.board, code: v.code.trim(), action: v.action,
          shares: shares, price: price, note: v.note,
          dca: v.action === 'buy' && v.dca === 'yes',
        });
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

  /* 板块级入口：先选一只持仓，再为它建定投计划 */
  function openDcaPlanPicker(boardKey) {
    const list = Store.state.boards[boardKey] ? Store.state.boards[boardKey].invest : [];
    if (!list || list.length === 0) {
      UI.toast('该板块暂无持仓，请先添加基金');
      return;
    }
    const opts = list.map(h => {
      const p = findPlan(boardKey, h.code);
      return { value: h.id, label: h.name + ' (' + h.code + ')' + (p ? ' · 已有计划' : '') };
    });
    UI.sheet({
      title: '选择要定投的基金',
      fields: [{ key: 'id', label: '基金', type: 'select', value: opts[0].value, options: opts }],
      submitText: '下一步',
      onSubmit: (v) => {
        const h = list.find(x => x.id === v.id);
        if (!h) return true;
        const exist = findPlan(boardKey, h.code);
        if (exist) openDcaPlanSheet(exist);
        else openDcaPlanSheet(null, { board: boardKey, code: h.code, name: h.name, price: h.lastNav || 0 });
        return true;
      },
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

  function paramHint(freq) {
    if (freq === 'weekly') return '每周几（1=周一 … 7=周日）';
    if (freq === 'interval') return '间隔天数，如 14 表示每两周';
    return '每月几号（1-28）';
  }

  /* 定投计划：可按「固定金额」或「固定份额」定投 */
  function openDcaPlanSheet(edit, preset) {
    const p = edit || preset || {};
    const freq = p.freq || 'monthly';
    const param = (p.param != null && p.param !== '') ? p.param : 1;
    const mode = p.mode === 'shares' ? 'shares' : 'amount';   // 默认按金额，符合多数人的定投习惯
    UI.sheet({
      title: edit ? '编辑定投计划' : '新建定投计划',
      fields: [
        { key: 'board', label: '归属板块', type: 'select', value: p.board || Store.BOARD_DEFS[0].key, options: Store.BOARD_DEFS.map(b => ({ value: b.key, label: b.name })) },
        { key: 'code', label: '6位基金代码', type: 'text', value: p.code || '', placeholder: '如 110011' },
        { key: 'name', label: '基金名称', type: 'text', value: (p.name && p.name !== '未命名基金') ? p.name : '', placeholder: '可选，刷新时自动获取' },
        { key: 'freq', label: '定投频率', type: 'select', value: freq, options: [{ value: 'monthly', label: '每月固定日' }, { value: 'weekly', label: '每周固定日' }, { value: 'interval', label: '每隔 N 天' }] },
        { key: 'param', label: '扣款日', type: 'number', value: param, placeholder: paramHint(freq), hint: paramHint(freq) },
        {
          key: 'mode', label: '定投方式', type: 'segmented', value: mode,
          options: [{ value: 'amount', label: '按金额' }, { value: 'shares', label: '按份额' }],
        },
        { key: 'amount', label: '每期金额（元）', type: 'number', value: p.amount || '', placeholder: '如 1000' },
        { key: 'shares', label: '每期份额', type: 'number', value: p.shares || '', placeholder: '如 500' },
        { key: 'price', label: '参考成交净值', type: 'number', value: p.price || '', placeholder: '可选，记账时可改' },
        { key: 'note', label: '备注', type: 'text', value: p.note || '', placeholder: '可选' },
        { key: 'tip', label: '', type: 'note', value: '到扣款日后打开 App，首页会弹出提醒，点「记一笔」即可一键入账。' },
      ],
      onInput: (v, api) => {
        api.hint('param', paramHint(v.freq));
        const byAmount = v.mode !== 'shares';
        api.show('amount', byAmount);
        api.show('shares', !byAmount);
        api.hint('amount', byAmount ? '每期固定投入这个金额，份额按当日净值自动算' : '');
        api.hint('shares', byAmount ? '' : '每期固定申购这么多份额');
      },
      submitText: '保存计划',
      onSubmit: (v) => {
        if (!/^\d{6}$/.test((v.code || '').trim())) throw new Error('请输入6位基金代码');
        const byAmount = v.mode !== 'shares';
        const amount = Math.max(0, Number(v.amount) || 0);
        const shares = Math.max(0, Number(v.shares) || 0);
        if (byAmount && amount <= 0) throw new Error('请输入每期定投金额');
        if (!byAmount && shares <= 0) throw new Error('请输入每期定投份额');
        let param = Number(v.param) || 1;
        if (v.freq === 'monthly') param = Math.min(28, Math.max(1, param));
        if (v.freq === 'weekly') param = Math.min(7, Math.max(1, param));
        if (v.freq === 'interval') param = Math.max(1, param);
        const plan = {
          board: v.board,
          code: v.code.trim(),
          name: (v.name || '').trim(),
          freq: v.freq,
          param: param,
          mode: byAmount ? 'amount' : 'shares',
          amount: byAmount ? amount : 0,
          shares: byAmount ? 0 : shares,
          price: Math.max(0, Number(v.price) || 0),
          note: (v.note || '').slice(0, 60),
          enabled: true,
        };
        if (edit) { plan.id = p.id; Store.updateDcaPlan(p.id, plan); UI.toast('定投计划已更新'); }
        else { Store.addDcaPlan(plan); UI.toast('定投计划已创建'); }
      },
    }).then(() => render());
  }

  /* 该基金已有的定投计划（同板块同代码） */
  function findPlan(boardKey, code) {
    return (Store.state.dcaPlans || []).find(p => p.board === boardKey && p.code === code);
  }
  /* 计划的「每期投入」文案 */
  function planAmountLabel(p) {
    if (p.mode === 'shares' || (!p.amount && p.shares)) return '每期 ' + UI.fmtNum(p.shares) + ' 份';
    return '每期 ' + UI.fmtMoney(p.amount);
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
  /* 首页：单一综合页。按板块分组，每组内同时列出「现金」与「投资」明细，
   * 每条明细默认收起，点击才展开显示 备注/买入/卖出/定投/编辑/隐藏/删除 等操作。 */
  function renderHome() {
    const g = Store.globalTotals();
    const ring = buildRing();
    const body = renderDcaReminder() + Store.BOARD_DEFS.map(b => renderBoardSection(b.key)).join('');
    return '' +
      '<div class="total-card">' +
      '<div class="total-label">总资产（元）</div>' +
      '<div class="total-value">' + UI.fmtMoney(g.grandTotal) + '</div>' +
      '<div class="total-profit ' + (g.totalProfit > 0 ? 'tp-up' : (g.totalProfit < 0 ? 'tp-down' : 'tp-flat')) + '">总盈亏 <span class="' + UI.changeClass(g.totalProfit) + '">' + UI.fmtMoney(g.totalProfit) + '</span></div>' +
      '<div class="ring-wrap">' + ring + '</div>' +
      '</div>' +
      refreshStatusBar() +
      body +
      '<div class="quick-bar">' +
      '<button class="quick-btn" data-action="add-cash"><span class="q-ico">✎</span>记一笔</button>' +
      '<button class="quick-btn" data-action="add-holding"><span class="q-ico">📈</span>加投资</button>' +
      '<button class="quick-btn" data-action="refresh"><span class="q-ico">↻</span>净值更新</button>' +
      '<button class="quick-btn" data-action="transfer"><span class="q-ico">⇄</span>调拨</button>' +
      '</div>';
  }

  /* 现金明细行（可点击展开操作） */
  function cashRowHtml(c, boardKey) {
    const hidden = !!c.hidden;
    const expanded = expandedItems.has(c.id);
    const right = hidden
      ? '<span class="li-amount muted">已隐藏</span>'
      : '<div class="li-amount ' + (c.type === 'expense' ? 'down' : 'up') + '">' + (c.type === 'expense' ? '-' : '+') + UI.fmtMoney(c.amount) + '</div>';
    const detail = expanded ? '' +
      '<div class="item-detail">' +
      noteLine(c.note) +
      '<div class="item-actions">' +
      '<button class="btn-mini" data-action="edit-note" data-kind="cash" data-board="' + boardKey + '" data-id="' + c.id + '">' + (c.note ? '✎ 备注' : '＋备注') + '</button>' +
      '<button class="btn-mini" data-action="toggle-hidden" data-kind="cash" data-board="' + boardKey + '" data-id="' + c.id + '">' + (hidden ? '显示' : '隐藏') + '</button>' +
      '<button class="btn-mini danger" data-action="delete-cash" data-board="' + boardKey + '" data-id="' + c.id + '">删除</button>' +
      '</div></div>' : '';
    return '' +
      '<div class="cash-row item ' + (hidden ? 'is-hidden' : '') + '">' +
      '<div class="item-head" data-action="expand-item" data-kind="cash" data-board="' + boardKey + '" data-id="' + c.id + '">' +
      '<div class="li-main">' +
      '<div class="li-title">' + (c.type === 'expense' ? '支出' : '收入') + '</div>' +
      '<div class="li-sub">' + boardName(boardKey) + ' · ' + UI.fmtTime(c.time) + '</div>' +
      '</div>' +
      '<div class="li-right">' + right + '</div>' +
      '</div>' + detail +
      '</div>';
  }

  /* 投资持仓明细行（可点击展开操作 + 盈亏/详情） */
  function investRowHtml(h, boardKey) {
    const hidden = !!h.hidden;
    const expanded = expandedItems.has(h.id);
    const isGold = h.kind === 'gold';
    const plan = findPlan(boardKey, h.code);
    const isDca = !!plan || Store.state.trades.some(t => t.code === h.code && t.board === boardKey && t.dca);
    const w = periodReturn(h.navHistory, 7);
    const m = periodReturn(h.navHistory, 30);
    const q = periodReturn(h.navHistory, 90);
    const y = periodReturn(h.navHistory, 365);
    const rt = v => v === null ? '<span class="muted">—</span>' : '<span class="' + UI.changeClass(v) + '">' + UI.fmtPct(v) + '</span>';
    const planLine = plan
      ? '<div class="hd-plan">📅 定投计划：' + freqLabel(plan) + ' · ' + planAmountLabel(plan) +
        (isDue(plan) ? ' <span class="due-tag">待记</span>' : '') + '</div>'
      : '';
    const right = hidden
      ? '<span class="li-amount muted">已隐藏</span>'
      : '<div class="li-amount">' + UI.fmtMoney(h.marketValue) + '</div>' +
        '<div class="li-pct ' + UI.changeClass(h.todayChangePct) + '">' + UI.fmtPct(h.todayChangePct) + '</div>' +
        '<div class="li-pct ' + UI.changeClass(h.totalProfit) + '">累计 ' + UI.fmtMoney(h.totalProfit) + '</div>';
    let detailInner = '';
    if (expanded) {
      detailInner += noteLine(h.note);
      detailInner += holdPline(h);
      if (!hidden) {
        detailInner +=
          '<div class="hd-grid">' +
          '<div><span class="muted">' + (isGold ? '如意金价(元/克)' : '最新净值') + '</span>' + UI.fmtNum(h.lastNav, isGold ? 3 : 4) + (isGold ? '' : (h.navDate ? '<span class="muted">' + h.navDate + '</span>' : '')) + '</div>' +
          '<div><span class="muted">平均成本</span>' + UI.fmtNum(h.avgCost, 3) + '</div>' +
          '<div><span class="muted">持仓份额</span>' + UI.fmtNum(h.shares) + '</div>' +
          '<div><span class="muted">投入本金</span>' + UI.fmtMoney(h.shares * h.avgCost) + '</div>' +
          '<div><span class="muted">当前市值</span>' + UI.fmtMoney(h.marketValue) + '</div>' +
          '<div><span class="muted">累计盈亏</span><span class="' + UI.changeClass(h.totalProfit) + '">' + UI.fmtMoney(h.totalProfit) + '</span></div>' +
          '</div>' + planLine +
          '<div class="hd-returns">' +
          '<div>近1周 ' + rt(w) + '</div><div>近1月 ' + rt(m) + '</div>' +
          '<div>近3月 ' + rt(q) + '</div><div>近1年 ' + rt(y) + '</div>' +
          '</div>';
      }
      const actions = isGold
        ? '<button class="btn-mini" data-action="edit-holding" data-board="' + boardKey + '" data-id="' + h.id + '">编辑</button>' +
          '<button class="btn-mini" data-action="edit-note" data-kind="invest" data-board="' + boardKey + '" data-id="' + h.id + '">' + (h.note ? '✎ 备注' : '＋备注') + '</button>' +
          '<button class="btn-mini" data-action="toggle-hidden" data-kind="invest" data-board="' + boardKey + '" data-id="' + h.id + '">' + (hidden ? '显示' : '隐藏') + '</button>' +
          '<button class="btn-mini danger" data-action="delete-invest" data-board="' + boardKey + '" data-id="' + h.id + '">删除</button>'
        : '<button class="btn-mini act-buy" data-action="trade" data-board="' + boardKey + '" data-id="' + h.id + '" data-dir="buy">买入</button>' +
          '<button class="btn-mini act-sell" data-action="trade" data-board="' + boardKey + '" data-id="' + h.id + '" data-dir="sell">卖出</button>' +
          '<button class="btn-mini dca-btn" data-action="dca-plan" data-board="' + boardKey + '" data-id="' + h.id + '">' + (plan ? '定投计划 ·<span class="dca-btn-sub"> ' + freqLabel(plan) + '</span>' : '＋ 定投计划') + '</button>' +
          '<button class="btn-mini" data-action="edit-holding" data-board="' + boardKey + '" data-id="' + h.id + '">编辑</button>' +
          '<button class="btn-mini" data-action="edit-note" data-kind="invest" data-board="' + boardKey + '" data-id="' + h.id + '">' + (h.note ? '✎ 备注' : '＋备注') + '</button>' +
          '<button class="btn-mini" data-action="toggle-hidden" data-kind="invest" data-board="' + boardKey + '" data-id="' + h.id + '">' + (hidden ? '显示' : '隐藏') + '</button>' +
          '<button class="btn-mini danger" data-action="delete-invest" data-board="' + boardKey + '" data-id="' + h.id + '">删除</button>';
      detailInner += '<div class="item-actions">' + actions + '</div>';
    }
    return '' +
      '<div class="hold-row item ' + (hidden ? 'is-hidden' : '') + '">' +
      '<div class="item-head" data-action="expand-item" data-kind="invest" data-board="' + boardKey + '" data-id="' + h.id + '">' +
      '<div class="li-main">' +
      '<div class="li-title">' + escapeHtml(h.name) + (isGold ? ' <span class="gold-badge">金</span>' : ' <span class="li-code">' + h.code + '</span>') + (isDca ? ' <span class="dca-badge">定投</span>' : '') + '</div>' +
      '<div class="li-sub">' + boardName(boardKey) + ' · ' + (isGold ? '克数 ' : '份额 ') + UI.fmtNum(h.shares, isGold ? 3 : undefined) + ' · 成本 ' + UI.fmtNum(h.avgCost, 3) + '</div>' +
      '</div>' +
      '<div class="li-right">' + right + '</div>' +
      '</div>' +
      (expanded ? '<div class="item-detail">' + detailInner + '</div>' : '') +
      '</div>';
  }

  /* 板块分区：头部(名称+现金/投资小计) + 现金明细 + 投资明细 + 添加入口 */
  function renderBoardSection(boardKey) {
    const def = Store.BOARD_DEFS.find(b => b.key === boardKey);
    const b = Store.state.boards[boardKey];
    const cash = b.cash, invest = b.invest;
    const cashTotal = Store.cashTotal(boardKey);
    const investTotal = Store.investTotal(boardKey);
    const boardTotal = Store.boardTotal(boardKey);
    const investProfit = Store.boardInvestTotalProfit(boardKey);
    const cashRows = cash.length === 0 ? '' : cash.map(c => cashRowHtml(c, boardKey)).join('');
    const investRows = invest.length === 0 ? '' : invest.map(h => investRowHtml(h, boardKey)).join('');
    const empty = (cash.length === 0 && invest.length === 0)
      ? '<div class="empty">暂无记录，用下方按钮添加</div>' : '';
    return '' +
      '<section class="board-card">' +
      '<div class="board-head" data-board="' + boardKey + '">' +
      '<div class="bh-left"><div class="board-name">' + def.name + '</div>' +
      '<div class="board-sub">现金 ' + UI.fmtMoney(cashTotal) + ' · 投资 ' + UI.fmtMoney(investTotal) + '</div></div>' +
      '<div class="bh-right"><div class="board-total">' + UI.fmtMoney(boardTotal) + '</div>' +
      '<div class="board-profit ' + UI.changeClass(investProfit) + '">累计 ' + UI.fmtMoney(investProfit) + '</div></div>' +
      '</div>' +
      '<div class="board-body">' +
      cashRows + investRows + empty +
      '<div class="sub-add-row">' +
      '<button class="sub-add" data-action="add-cash-board" data-board="' + boardKey + '">＋ 记一笔现金</button>' +
      '<button class="sub-add" data-action="add-invest-board" data-board="' + boardKey + '">＋ 添加持仓</button>' +
      '<button class="sub-add gold" data-action="add-gold-board" data-board="' + boardKey + '">＋ 实体黄金</button>' +
      '</div>' +
      '</div>' +
      '</section>';
  }

  /* 净值刷新状态条：让「什么时候刷的、刷到哪天的净值」一目了然 */
  function refreshStatusBar() {
    const r = Store.state.lastRefresh;
    const hasHolding = Store.allHoldings().length > 0;
    let text;
    if (!hasHolding) text = '还没有持仓，添加基金后即可刷新净值';
    else if (!r || !r.time) text = '尚未刷新过净值，点右侧按钮获取';
    else {
      const src = r.trading ? '盘中估值' : ('官方净值' + (r.navDate ? ' ' + r.navDate : ''));
      text = '上次刷新 ' + UI.fmtTime(r.time) + ' · ' + src +
        (r.fail ? ' · ' + r.fail + ' 只失败' : '');
    }
    return '<div class="refresh-bar">' +
      '<span class="rb-text">' + text + '</span>' +
      '<button class="rb-btn" data-action="refresh">↻ 刷新净值</button>' +
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
      '<div class="dca-i-sub">' + boardName(p.board) + ' · 应投 ' + planAmountLabel(p).replace('每期 ', '') + '</div>' +
      '</div>' +
      '<button class="dca-rec-btn" data-action="dca-record" data-plan="' + p.id + '">记一笔</button>' +
      '</div>').join('');
    return '<div class="dca-reminder">' +
      '<div class="dca-r-head">🔔 你有 ' + plans.length + ' 笔定投待记</div>' +
      items + '</div>';
  }

  /* 今日 YYYY-MM-DD（本地） */
  function todayYMD() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /* 净值日期 → 展示标签：官方净值如 "7.29日"；盘中估算如 "7.30估值"；无日期回退 "本日" */
  function navDayLabel(h) {
    const d = h && h.navDate ? h.navDate : '';
    if (!d) return '本日';
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(d);
    const md = m ? (parseInt(m[2], 10) + '.' + parseInt(m[3], 10)) : d.replace(/\s[\d:]+$/, '');
    return (h && h.estMode) ? (md + '估值') : (md + '日');
  }
  /* 每只基金下方：当日盈亏金额 + 涨跌幅 / 累计盈亏金额 */
  function holdPline(h) {
    const tp = Number(h.todayProfit) || 0;
    const tpp = Number(h.todayChangePct) || 0;
    const tot = Number(h.totalProfit) || 0;
    const dl = navDayLabel(h);
    return '<div class="hd-pline">' +
      '<div class="pl-item"><span class="pl-k">' + dl + '盈亏</span>' +
        '<span class="pl-v ' + UI.changeClass(tp) + '">' + UI.fmtMoney(tp) + '</span>' +
        '<span class="pl-p ' + UI.changeClass(tpp) + '">' + UI.fmtPct(tpp) + '</span></div>' +
      '<div class="pl-item"><span class="pl-k">累计盈亏</span>' +
        '<span class="pl-v ' + UI.changeClass(tot) + '">' + UI.fmtMoney(tot) + '</span></div>' +
      '</div>';
  }
  /* 备注按钮 + 备注展示（现金/投资通用，UI 简洁不冗余） */
  function noteBtn(kind, board, id, hasNote) {
    return '<button class="li-note-btn" data-action="edit-note" data-kind="' + kind + '" data-board="' + board + '" data-id="' + id + '">' +
      (hasNote ? '✎ 备注' : '＋备注') + '</button>';
  }
  function noteLine(note) {
    return note ? '<div class="li-note">📝 ' + escapeHtml(note) + '</div>' : '';
  }

  /* ---------------- 渲染：收支明细（与时间轴一致，沿用首页可展开明细行） ---------------- */
  function renderLedger() {
    let items = Store.allCash().slice().sort((a, b) => b.time - a.time);
    if (ledgerFilter.board !== 'all') items = items.filter(c => c.boardKey === ledgerFilter.board);
    const html = items.length === 0
      ? '<div class="empty">暂无收支记录</div>'
      : items.map(c => cashRowHtml(c, c.boardKey)).join('');
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
      '<div class="pc-row"><span>进入首页自动刷新净值</span>' + toggle('autoRefreshInvest', s.autoRefreshInvest) + '</div>' +
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
              '<div class="li-sub">' + boardName(p.board) + ' · ' + freqLabel(p) + ' · ' + planAmountLabel(p) +
              (due ? ' · <span class="due-tag">待记</span>' : '') + '</div>' +
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
      '<div class="profile-card">' +
      '<div class="pc-title">版本</div>' +
      '<div class="pc-row"><span>当前版本</span><span class="muted">' + APP_VERSION + '</span></div>' +
      '<div class="pc-row clickable" data-action="force-update"><span>检查更新（清缓存重载）</span><span>›</span></div>' +
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
      '<div class="swipe-inner"><div class="li"><div class="li-main">' + o.main + '</div><div class="li-right">' + o.right + '</div></div></div>' +
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
    else if (currentTab === 'ledger') html = renderLedger();
    else if (currentTab === 'profile') html = renderProfile();
    else html = renderHome();
    page.innerHTML = html;
    page.scrollTop = 0;
    bindSwipe(page);
    // 标题
    const titles = { home: '资产总览', ledger: '收支明细', profile: '个人中心' };
    document.getElementById('top-title').textContent = titles[currentTab] || '资产总览';
    // tab 高亮
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  }

  /* 备注弹窗：现金/投资通用，单文本框，保存即写回 */
  function openNoteSheet(kind, board, id) {
    const isCash = kind === 'cash';
    const b = Store.state.boards[board];
    if (!b) return;
    const item = isCash ? b.cash.find(x => x.id === id) : b.invest.find(x => x.id === id);
    if (!item) return;
    UI.sheet({
      title: isCash ? '现金备注' : '投资备注',
      submitText: '保存',
      fields: [{ key: 'note', label: '备注', type: 'textarea', value: item.note || '', placeholder: '例如：这笔是年终奖 / 长期持有不动' }],
      onSubmit: (v) => {
        const note = (v.note || '').trim();
        if (isCash) Store.updateCash(board, id, { note: note });
        else Store.updateHolding(board, id, { note: note });
        render();
      },
    });
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
    if (a === 'edit-note') { openNoteSheet(el.dataset.kind, board, id); return; }
    if (a === 'add-cash-board') { openCashSheet(board); return; }
    if (a === 'add-invest-board') { openHoldingSheet(board, null); return; }
    if (a === 'sell-invest-board') { openSellBoard(board); return; }
    if (a === 'add-cash') { openCashSheet(null); return; }
    if (a === 'refresh' || a === 'refresh-invest') { refreshAll(true); return; }
    if (a === 'transfer') { openTransferSheet(); return; }
    if (a === 'add-holding') { openHoldingSheet(null, null); return; }
    if (a === 'add-gold') { openGoldSheet(null, null); return; }
    if (a === 'add-gold-board') { openGoldSheet(board, null); return; }
    if (a === 'edit-holding') {
      const h = Store.state.boards[board].invest.find(x => x.id === id);
      if (h && h.kind === 'gold') openGoldSheet(board, h);
      else openHoldingSheet(board, h);
      return;
    }
    if (a === 'delete-invest') {
      UI.confirm({ title: '删除持仓', message: '确认删除该持仓？删除后相关交易记录仍保留。', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteHolding(board, id); expandedItems.delete(id); render(); }
      }); return;
    }
    if (a === 'delete-cash') {
      UI.confirm({ title: '删除记录', message: '确认删除该条收支记录？', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteCash(board, id); expandedItems.delete(id); render(); }
      }); return;
    }
    if (a === 'delete-trade') {
      UI.confirm({ title: '删除交易', message: '确认删除该条交易记录？持仓份额不会自动回滚。', okText: '删除' }).then(ok => {
        if (ok) { Store.deleteTrade(id); render(); }
      }); return;
    }
    /* 明细行点击展开/收起：点一下才显示 备注/买入/卖出/定投/编辑/隐藏 等操作 */
    if (a === 'expand-item') { if (expandedItems.has(id)) expandedItems.delete(id); else expandedItems.add(id); render(); return; }
    /* 隐藏明细：数字遮罩 + 不计入总额 */
    if (a === 'toggle-hidden') {
      const kind = el.dataset.kind;
      const b = Store.state.boards[board]; if (!b) return;
      const item = kind === 'cash' ? b.cash.find(x => x.id === id) : b.invest.find(x => x.id === id);
      if (!item) return;
      if (kind === 'cash') Store.updateCash(board, id, { hidden: !item.hidden });
      else Store.updateHolding(board, id, { hidden: !item.hidden });
      render(); return;
    }
    if (a === 'trade') {
      const h = Store.state.boards[board].invest.find(x => x.id === id);
      openTradeSheet({ board: board, code: h ? h.code : '', action: el.dataset.dir || 'buy' }); return;
    }
    // 每笔持仓下的「定投计划」：已有则编辑，没有则用该基金信息预填新建
    if (a === 'dca-plan') {
      const h = Store.state.boards[board] ? Store.state.boards[board].invest.find(x => x.id === id) : null;
      if (!h) return;
      const exist = findPlan(board, h.code);
      if (exist) openDcaPlanSheet(exist);
      else openDcaPlanSheet(null, { board: board, code: h.code, name: h.name, price: h.lastNav || 0 });
      return;
    }
    // 板块级：先选基金再建计划
    if (a === 'dca-plan-board') { openDcaPlanPicker(board); return; }
    if (a === 'dca') {
      const h = Store.state.boards[board].invest.find(x => x.id === id);
      openTradeSheet({ board: board, code: h ? h.code : '', action: 'buy', dca: true }); return;
    }
    if (a === 'dca-record') {
      const plan = (Store.state.dcaPlans || []).find(x => x.id === el.dataset.plan);
      if (!plan) return;
      const byAmount = plan.mode !== 'shares';
      openTradeSheet({
        board: plan.board, code: plan.code, action: 'buy', dca: true,
        mode: byAmount ? 'amount' : 'shares',
        amount: byAmount ? plan.amount : '',
        shares: byAmount ? '' : plan.shares,
        price: plan.price, note: plan.note,
      });
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
    if (a === 'force-update') { forceUpdate(); return; }
    if (a === 'snapshot-history') { openSnapshotHistory(); return; }
    if (a === 'export') { exportData(); return; }
    if (a === 'import') { importData(); return; }
    if (a === 'reset') {
      UI.confirm({ title: '清空全部数据', message: '将删除所有资产、交易与快照，且不可恢复。建议先导出备份。', okText: '清空' }).then(ok => {
        if (ok) { Store.resetAll(); expandedItems.clear(); render(); UI.toast('已清空'); }
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

  /* 强制取回最新版本：清空 PWA 缓存 + 注销 SW 后重载（不动 localStorage，数据不会丢） */
  async function forceUpdate() {
    UI.toast('正在获取最新版本…');
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch (e) { /* 忽略，直接重载 */ }
    location.reload(true);
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
              expandedItems.clear();
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
        // 进入首页自动刷新：5 分钟内刚刷过就不重复请求
        if (currentTab === 'home' && Store.state.settings.autoRefreshInvest) {
          const last = (Store.state.lastRefresh && Store.state.lastRefresh.time) || 0;
          if (Date.now() - last > 5 * 60 * 1000) refreshAll(false);
        }
        render();
      });
    });
    document.getElementById('page').addEventListener('click', onClick);
    document.getElementById('page').addEventListener('change', onChange);
    document.getElementById('eye-btn').addEventListener('click', () => {
      Store.updateSettings({ hideAmount: !Store.state.settings.hideAmount });
      render();
    });
    const rBtn = document.getElementById('refresh-btn');
    if (rBtn) rBtn.addEventListener('click', () => refreshAll(true));

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
    if (navigator.serviceWorker && location.protocol.indexOf('http') === 0) {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        // 发现新版本时立即接管，避免手机一直停留在旧页面
        if (reg && reg.update) reg.update().catch(() => {});
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!window.__ffaReloaded) { window.__ffaReloaded = true; location.reload(); }
        });
      } catch (e) { /* 注册失败不影响使用 */ }
    }
  }

  window.App = { init, render, refreshAll };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
