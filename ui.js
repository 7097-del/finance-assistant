/* ui.js —— 通用 UI 组件：金额格式化/隐藏、涨跌配色、toast、确认弹窗、底部表单 */
(function () {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function moneyHidden() { return Store.state.settings.hideAmount; }

  function fmtMoney(n) {
    const num = Number(n) || 0;
    if (moneyHidden()) return '••••••';
    const sign = num < 0 ? '-' : '';
    const s = Math.abs(num).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sign + '¥' + s;
  }
  function fmtNum(n, d) {
    d = d === undefined ? 2 : d;
    if (moneyHidden()) return '••••';
    return (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(n) {
    if (moneyHidden()) return '••••';
    const num = Number(n) || 0;
    return (num > 0 ? '+' : '') + num.toFixed(2) + '%';
  }
  function changeClass(n) {
    const num = Number(n) || 0;
    if (num > 0) return 'up';
    if (num < 0) return 'down';
    return 'flat';
  }
  function fmtTime(t) {
    const d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  let toastTimer = null;
  function toast(msg, type) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
  }

  function confirm(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML =
        '<div class="dialog">' +
        '<div class="dialog-title">' + (opts.title || '提示') + '</div>' +
        '<div class="dialog-body">' + (opts.message || '') + '</div>' +
        '<div class="dialog-actions">' +
        '<button class="btn-ghost" data-act="cancel">' + (opts.cancelText || '取消') + '</button>' +
        '<button class="btn-primary" data-act="ok">' + (opts.okText || '确认') + '</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      const close = (v) => { if (overlay.parentNode) document.body.removeChild(overlay); resolve(v); };
      overlay.querySelector('[data-act="cancel"]').onclick = () => close(false);
      overlay.querySelector('[data-act="ok"]').onclick = () => close(true);
      overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    });
  }

  /* 底部弹出表单
   * opts.fields = [{key,label,type,options,placeholder,value,hint}]
   *   type 支持：text / number / select / segmented / textarea / note(纯提示行)
   * opts.onInput(values, api) —— 任意字段变化时回调，用于字段联动
   *   api.set(key, val)      写入某字段的值
   *   api.hint(key, text)    更新某字段下方的灰色提示
   *   api.show(key, visible)  显示/隐藏某字段
   *   api.readonly(key, on)   置灰只读
   */
  function sheet(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay sheet-overlay';
      const fieldsHtml = (opts.fields || []).map(f => {
        const hint = '<span class="field-hint" data-hint="' + f.key + '">' + (f.hint || '') + '</span>';
        const wrapOpen = '<label class="field" data-field="' + f.key + '"><span>' + f.label + '</span>';
        if (f.type === 'note') {
          return '<div class="field field-note" data-field="' + f.key + '"><span class="field-hint" data-hint="' + f.key + '">' + (f.value || '') + '</span></div>';
        }
        if (f.type === 'select') {
          const os = (f.options || []).map(o =>
            '<option value="' + o.value + '"' + (f.value === o.value ? ' selected' : '') + '>' + o.label + '</option>').join('');
          return wrapOpen + '<select data-key="' + f.key + '">' + os + '</select>' + hint + '</label>';
        }
        if (f.type === 'segmented') {
          const os = (f.options || []).map(o =>
            '<button type="button" class="seg-btn' + (f.value === o.value ? ' active' : '') + '" data-val="' + o.value + '">' + o.label + '</button>').join('');
          return wrapOpen + '<div class="seg" data-seg="' + f.key + '">' + os + '<input type="hidden" data-key="' + f.key + '" value="' + (f.value || '') + '"></div>' + hint + '</label>';
        }
        if (f.type === 'textarea') {
          return wrapOpen + '<textarea data-key="' + f.key + '" placeholder="' + (f.placeholder || '') + '" rows="2">' + (f.value || '') + '</textarea>' + hint + '</label>';
        }
        const inputMode = f.type === 'number' ? ' inputmode="decimal"' : '';
        return wrapOpen + '<input data-key="' + f.key + '" type="' + (f.type || 'text') + '"' + inputMode +
          ' value="' + (f.value || '') + '" placeholder="' + (f.placeholder || '') + '">' + hint + '</label>';
      }).join('');
      overlay.innerHTML =
        '<div class="sheet">' +
        '<div class="sheet-header"><span>' + (opts.title || '录入') + '</span><button class="sheet-close" data-act="close">✕</button></div>' +
        '<div class="sheet-body">' + fieldsHtml + '</div>' +
        '<div class="sheet-footer"><button class="btn-primary block" data-act="submit">' + (opts.submitText || '保存') + '</button></div>' +
        '</div>';
      document.body.appendChild(overlay);

      const collect = () => {
        const values = {};
        overlay.querySelectorAll('[data-key]').forEach(el => { values[el.dataset.key] = el.value; });
        return values;
      };
      const api = {
        set(key, val) {
          const el = overlay.querySelector('[data-key="' + key + '"]');
          if (el && el.value !== String(val)) el.value = val;
        },
        get(key) {
          const el = overlay.querySelector('[data-key="' + key + '"]');
          return el ? el.value : '';
        },
        hint(key, text) {
          const el = overlay.querySelector('[data-hint="' + key + '"]');
          if (el) el.textContent = text || '';
        },
        show(key, visible) {
          const el = overlay.querySelector('[data-field="' + key + '"]');
          if (el) el.style.display = visible ? '' : 'none';
        },
        readonly(key, on) {
          const el = overlay.querySelector('[data-key="' + key + '"]');
          if (!el) return;
          el.readOnly = !!on;
          el.classList.toggle('is-readonly', !!on);
        },
      };
      const fire = () => { if (opts.onInput) { try { opts.onInput(collect(), api); } catch (e) {} } };

      // 分段选择器：点击切换 active 并写入隐藏 input
      overlay.querySelectorAll('.seg').forEach(seg => {
        const hidden = seg.querySelector('input[type="hidden"]');
        seg.querySelectorAll('.seg-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (hidden) hidden.value = btn.dataset.val;
            fire();
          });
        });
      });
      overlay.querySelectorAll('input,select,textarea').forEach(el => {
        el.addEventListener('input', fire);
        el.addEventListener('change', fire);
      });
      fire(); // 初始化一次联动

      const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); resolve(null); };
      overlay.querySelector('[data-act="close"]').onclick = close;
      overlay.querySelector('[data-act="submit"]').onclick = async () => {
        const values = collect();
        try {
          const r = opts.onSubmit ? await opts.onSubmit(values) : values;
          if (overlay.parentNode) document.body.removeChild(overlay);
          resolve(r);
        } catch (e) { toast(e && e.message ? e.message : '提交失败'); }
      };
    });
  }

  function setScheme() {
    document.body.setAttribute('data-scheme', Store.state.settings.colorScheme || 'redUp');
  }

  window.UI = { fmtMoney, fmtNum, fmtPct, changeClass, fmtTime, toast, confirm, sheet, setScheme, moneyHidden, pad };
})();
