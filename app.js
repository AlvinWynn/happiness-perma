/* app.js — 幸福感知器主逻辑
 * 周/月视图 / 记录弹层(三层选择) / 当日星标 / 本地存储 / 重力感应 / 物理世界联动
 */
(function () {
  'use strict';

  const CATS = (window.HAPPINESS_DATA && window.HAPPINESS_DATA.categories) || [];
  const STORE_KEY = 'happiness_events_v1';
  const STAR_KEY = 'happiness_stars_v1';
  const WEEK_FIRST_MON = true; // 周一为每周第一天

  // ---------- 存储 ----------
  // DB：    { "2026-6-12": [ {uid, catId, subId, tag, emoji, color, ts} ], ... }
  // STARS： { "2026-6-12": uid }  当日星标事件的 uid(未设置则默认当天第一条)
  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch { return {}; }
  }
  let DB = load(STORE_KEY);
  let STARS = load(STAR_KEY);
  const saveDB = () => localStorage.setItem(STORE_KEY, JSON.stringify(DB));
  const saveStars = () => localStorage.setItem(STAR_KEY, JSON.stringify(STARS));

  function cellKey(y, m, d) { return `${y}-${m + 1}-${d}`; } // m 为 0-based
  function uid() { return Date.now() % 1e9 + Math.floor(Math.random() * 1000); }

  function addEvent(key, ev) {
    if (!DB[key]) DB[key] = [];
    DB[key].push(ev);
    saveDB();
  }
  function removeEvent(key, evUid) {
    if (!DB[key]) return;
    DB[key] = DB[key].filter(e => e.uid !== evUid);
    if (!DB[key].length) delete DB[key];
    saveDB();
    if (STARS[key] === evUid) { delete STARS[key]; saveStars(); } // 星标被删→回退默认
  }
  // 某天的星标 uid：显式设置优先，否则默认当天第一条
  function starUidFor(key) {
    const list = DB[key] || [];
    if (!list.length) return null;
    if (STARS[key] != null && list.some(e => e.uid === STARS[key])) return STARS[key];
    return list[0].uid;
  }

  // ---------- 状态 ----------
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let viewMode = 'week';            // 'week' | 'month'
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-based(月视图用)
  let weekStart = mondayOf(today);  // 周视图：当前周的周一
  let activeKey = null;             // 当前弹层操作的日期 key

  // ---------- DOM ----------
  const $ = sel => document.querySelector(sel);
  const calendarEl = $('#calendar');
  const monthTitle = $('#monthTitle');
  const canvas = $('#physicsCanvas');
  const world = new PhysicsWorld(canvas);

  // ---------- 日期工具 ----------
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstWeekday(y, m) {
    let wd = new Date(y, m, 1).getDay();
    return WEEK_FIRST_MON ? (wd === 0 ? 6 : wd - 1) : wd;
  }
  function mondayOf(date) {
    const x = new Date(date);
    const wd = x.getDay();
    const diff = WEEK_FIRST_MON ? (wd === 0 ? -6 : 1 - wd) : -wd;
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function sameDate(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // ---------- 视图渲染 ----------
  function render() {
    if (viewMode === 'week') renderWeek();
    else renderMonth();
    document.body.classList.toggle('view-week', viewMode === 'week');
    document.body.classList.toggle('view-month', viewMode === 'month');
  }

  function makeCell(key, dayNum, isToday) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.key = key;
    if (isToday) cell.classList.add('today');
    const num = document.createElement('span');
    num.className = 'daynum';
    num.textContent = dayNum;
    cell.appendChild(num);
    if ((DB[key] || []).length) cell.classList.add('has-events');
    cell.addEventListener('click', () => openSheet(key));
    return cell;
  }

  function renderWeek() {
    calendarEl.className = 'calendar week';
    calendarEl.innerHTML = '';
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    const a = days[0], b = days[6];
    monthTitle.textContent =
      `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日`;
    // 左上角：缩小版月历(框出当前周)
    calendarEl.appendChild(renderMiniMonth(days));
    // 其余 7 格：周一→周日
    const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    days.forEach((d, i) => {
      const key = cellKey(d.getFullYear(), d.getMonth(), d.getDate());
      calendarEl.appendChild(makeDayCell(key, labels[i], d.getDate(), sameDate(d, today)));
    });
    requestAnimationFrame(syncPhysics);
  }

  // 周视图日格：顶部星期+日期，下方 phys-zone 容纳重力图标
  function makeDayCell(key, label, dayNum, isToday) {
    const cell = document.createElement('div');
    cell.className = 'cell day-cell';
    cell.dataset.key = key;
    if (isToday) cell.classList.add('today');
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `<span class="dh-label">${label}</span><span class="dh-num">${dayNum}</span>`;
    cell.appendChild(head);
    const zone = document.createElement('div');
    zone.className = 'phys-zone';
    cell.appendChild(zone);
    if ((DB[key] || []).length) cell.classList.add('has-events');
    cell.addEventListener('click', () => openSheet(key));
    return cell;
  }

  // 左上角缩小版月历：框出当前周所在的整行
  function renderMiniMonth(weekDays) {
    const wrap = document.createElement('div');
    wrap.className = 'mini-month';
    const y = weekStart.getFullYear(), m = weekStart.getMonth();
    const title = document.createElement('div');
    title.className = 'mini-title';
    title.textContent = `${m + 1}月`;
    wrap.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'mini-grid';
    ['一', '二', '三', '四', '五', '六', '日'].forEach(w => {
      const h = document.createElement('span');
      h.className = 'mini-wd'; h.textContent = w; grid.appendChild(h);
    });
    const lead = firstWeekday(y, m);
    const total = daysInMonth(y, m);
    const weekSet = new Set(weekDays.map(d => cellKey(d.getFullYear(), d.getMonth(), d.getDate())));
    // 当前周落在本月内的首尾日，用于画方框两端
    const inMonth = weekDays.filter(d => d.getFullYear() === y && d.getMonth() === m);
    const firstK = inMonth.length ? cellKey(y, m, inMonth[0].getDate()) : null;
    const lastK = inMonth.length ? cellKey(y, m, inMonth[inMonth.length - 1].getDate()) : null;
    for (let i = 0; i < lead; i++) {
      const s = document.createElement('span');
      s.className = 'mini-day blank'; grid.appendChild(s);
    }
    for (let d = 1; d <= total; d++) {
      const s = document.createElement('span');
      s.className = 'mini-day'; s.textContent = d;
      const k = cellKey(y, m, d);
      if (weekSet.has(k)) s.classList.add('in-week');
      if (k === firstK) s.classList.add('wk-start');
      if (k === lastK) s.classList.add('wk-end');
      if (y === today.getFullYear() && m === today.getMonth() && d === today.getDate())
        s.classList.add('mini-today');
      grid.appendChild(s);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function renderMonth() {
    calendarEl.className = 'calendar month';
    calendarEl.innerHTML = '';
    monthTitle.textContent = `${viewYear} 年 ${viewMonth + 1} 月`;
    const lead = firstWeekday(viewYear, viewMonth);
    const total = daysInMonth(viewYear, viewMonth);
    for (let i = 0; i < lead; i++) {
      const blank = document.createElement('div');
      blank.className = 'cell blank';
      calendarEl.appendChild(blank);
    }
    for (let d = 1; d <= total; d++) {
      const key = cellKey(viewYear, viewMonth, d);
      const isToday = viewYear === today.getFullYear() &&
                      viewMonth === today.getMonth() && d === today.getDate();
      calendarEl.appendChild(makeCell(key, d, isToday));
    }
    requestAnimationFrame(syncPhysics);
  }

  // 把 DOM 方格坐标同步给物理世界，并按视图重建粒子
  function syncPhysics() {
    const baseRect = calendarEl.getBoundingClientRect();
    const fullW = calendarEl.scrollWidth;
    const fullH = calendarEl.scrollHeight;
    // 月视图图标放大、周视图保持原大小
    world.viewScale = viewMode === 'month' ? 1.5 : 1;
    world.resize(fullW, fullH);
    canvas.style.width = fullW + 'px';
    canvas.style.height = fullH + 'px';
    canvas.style.left = calendarEl.offsetLeft + 'px';
    canvas.style.top = calendarEl.offsetTop + 'px';
    const cellMap = new Map();
    const eventsByCell = {};
    calendarEl.querySelectorAll('.cell:not(.blank)').forEach(cell => {
      const key = cell.dataset.key;
      // 周视图图标限制在 phys-zone(头部以下)；月视图用整格
      const bound = cell.querySelector('.phys-zone') || cell;
      const r = bound.getBoundingClientRect();
      cellMap.set(key, {
        x: r.left - baseRect.left, y: r.top - baseRect.top,
        w: r.width, h: r.height,
      });
      const list = DB[key] || [];
      if (!list.length) return;
      if (viewMode === 'month') {
        // 月视图：仅显示当日星标图标
        const sUid = starUidFor(key);
        const sev = list.find(e => e.uid === sUid) || list[0];
        eventsByCell[key] = [sev];
      } else {
        eventsByCell[key] = list; // 周视图：显示全部
      }
    });
    world.setCells(cellMap);
    world.rebuildAll(eventsByCell, {}); // 不传星标→无金色光环
    world.start();
  }

  // 局部刷新某格物理(记录增删/改星标后)
  function refreshCell(key) {
    const list = DB[key] || [];
    if (viewMode === 'month') {
      const sUid = starUidFor(key);
      const sev = list.find(e => e.uid === sUid) || list[0];
      world.rebuildCell(key, sev ? [sev] : [], null);
    } else {
      world.rebuildCell(key, list, null);
    }
  }

  // ---------- 记录弹层 ----------
  const sheet = $('#sheet');
  const sheetDate = $('#sheetDate');
  const catList = $('#catList');
  const subList = $('#subList');
  const tagList = $('#tagList');
  const todayEvents = $('#todayEvents');

  function openSheet(key) {
    activeKey = key;
    const [, m, d] = key.split('-').map(Number);
    sheetDate.textContent = `${m} 月 ${d} 日 · 记录幸福`;
    renderCats();
    subList.classList.add('hidden');
    tagList.classList.add('hidden');
    renderTodayEvents();
    sheet.classList.remove('hidden');
  }
  function closeSheet() { sheet.classList.add('hidden'); activeKey = null; }

  function renderCats() {
    catList.classList.remove('hidden');
    catList.innerHTML = '';
    CATS.forEach(cat => {
      const b = document.createElement('button');
      b.className = 'cat-chip';
      b.style.setProperty('--c', cat.color);
      b.innerHTML = `<span class="chip-emoji">${cat.emoji}</span><span>${cat.name}</span>`;
      b.addEventListener('click', () => renderSubs(cat));
      catList.appendChild(b);
    });
  }

  function renderSubs(cat) {
    subList.classList.remove('hidden');
    subList.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'sub-back';
    back.textContent = `‹ ${cat.name}`;
    back.addEventListener('click', () => {
      subList.classList.add('hidden');
      tagList.classList.add('hidden');
    });
    subList.appendChild(back);
    (cat.children || []).forEach(sub => {
      const b = document.createElement('button');
      b.className = 'sub-chip';
      b.style.setProperty('--c', cat.color);
      b.innerHTML = `<span class="chip-emoji">${sub.emoji}</span><span>${sub.name}</span>`;
      b.addEventListener('click', () => renderTags(cat, sub));
      subList.appendChild(b);
    });
    tagList.classList.add('hidden');
  }

  function renderTags(cat, sub) {
    tagList.classList.remove('hidden');
    tagList.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'tag-hint';
    hint.textContent = `点击记录一条「${sub.name}」`;
    tagList.appendChild(hint);
    (sub.defaultTags || []).forEach(tag => {
      const b = document.createElement('button');
      b.className = 'tag-chip';
      b.style.setProperty('--c', cat.color);
      b.textContent = tag;
      b.addEventListener('click', () => {
        commitEvent(cat, sub, tag);
        b.classList.add('picked');
        setTimeout(() => b.classList.remove('picked'), 400);
      });
      tagList.appendChild(b);
    });
    const customWrap = document.createElement('div');
    customWrap.className = 'custom-wrap';
    const input = document.createElement('input');
    input.className = 'custom-input';
    input.placeholder = '自定义一条…';
    input.maxLength = 40;
    const add = document.createElement('button');
    add.className = 'custom-add';
    add.textContent = '＋';
    add.addEventListener('click', () => {
      const v = input.value.trim();
      if (v) { commitEvent(cat, sub, v); input.value = ''; }
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add.click(); });
    customWrap.appendChild(input);
    customWrap.appendChild(add);
    tagList.appendChild(customWrap);
  }

  function commitEvent(cat, sub, tag) {
    const ev = {
      uid: uid(), catId: cat.id, subId: sub.id, tag,
      emoji: sub.emoji || cat.emoji, color: cat.color, ts: Date.now(),
    };
    addEvent(activeKey, ev);
    const cell = calendarEl.querySelector(`.cell[data-key="${activeKey}"]`);
    if (cell) cell.classList.add('has-events');
    refreshCell(activeKey);
    renderTodayEvents();
  }

  function renderTodayEvents() {
    const list = DB[activeKey] || [];
    todayEvents.innerHTML = '';
    if (!list.length) return;
    const multi = list.length >= 2;
    const sUid = starUidFor(activeKey);

    const h = document.createElement('h3');
    h.className = 'today-title';
    h.textContent = multi
      ? `今日 ${list.length} 条 · 点 ☆ 选当日星标`
      : `今日已记录 1 条（即当日星标 ★）`;
    todayEvents.appendChild(h);

    list.slice().reverse().forEach(ev => {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.style.setProperty('--c', ev.color);
      const isStar = ev.uid === sUid;
      if (isStar) row.classList.add('is-star');

      // 星标按钮：仅多条时可点；单条时显示为已星标且不可改
      const star = document.createElement('button');
      star.className = 'ev-star';
      star.textContent = isStar ? '★' : '☆';
      star.title = '设为当日星标';
      if (multi) {
        star.addEventListener('click', () => {
          STARS[activeKey] = ev.uid;
          saveStars();
          refreshCell(activeKey);
          renderTodayEvents();
        });
      } else {
        star.disabled = true;
      }
      row.appendChild(star);

      const em = document.createElement('span');
      em.className = 'ev-emoji'; em.textContent = ev.emoji;
      const tg = document.createElement('span');
      tg.className = 'ev-tag'; tg.textContent = ev.tag;
      row.appendChild(em); row.appendChild(tg);

      const del = document.createElement('button');
      del.className = 'ev-del';
      del.textContent = '×';
      del.addEventListener('click', () => {
        removeEvent(activeKey, ev.uid);
        const cell = calendarEl.querySelector(`.cell[data-key="${activeKey}"]`);
        if (cell && !(DB[activeKey] || []).length) cell.classList.remove('has-events');
        refreshCell(activeKey);
        renderTodayEvents();
      });
      row.appendChild(del);
      todayEvents.appendChild(row);
    });
  }

  sheet.querySelectorAll('[data-close]').forEach(el =>
    el.addEventListener('click', closeSheet));

  // ---------- 导航 + 视图切换 ----------
  $('#prevMonth').addEventListener('click', () => {
    if (viewMode === 'week') {
      weekStart.setDate(weekStart.getDate() - 7);
    } else {
      viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    }
    render();
  });
  $('#nextMonth').addEventListener('click', () => {
    if (viewMode === 'week') {
      weekStart.setDate(weekStart.getDate() + 7);
    } else {
      viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    }
    render();
  });

  document.querySelectorAll('.vt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.view;
      if (mode === viewMode) return;
      if (mode === 'month') {
        // 周→月：定位到当前周所在的月
        viewYear = weekStart.getFullYear();
        viewMonth = weekStart.getMonth();
      } else {
        // 月→周：若当月含今天则定位今天那周，否则该月第一周
        const inThisMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();
        weekStart = mondayOf(inThisMonth ? today : new Date(viewYear, viewMonth, 1));
      }
      viewMode = mode;
      document.querySelectorAll('.vt-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === mode));
      render();
    });
  });

  // ---------- 重力感应 ----------
  const enableBtn = $('#enableMotion');
  const motionHint = $('#motionHint');
  let motionOn = false;

  function handleOrientation(e) {
    // 把屏幕当托盘，重力=真实重力向量在屏幕平面的投影(sin)，自然且可倒置。
    // gamma 左右倾斜[-90,90] -> 屏幕X；beta 前后倾斜[-180,180] -> 屏幕Y。
    const gamma = e.gamma || 0;
    const beta = e.beta || 0;
    const rad = Math.PI / 180;
    // sin 投影：平放=0、竖直=±1、倒置自然变负(图标会"往上"掉向倒置后的下方)
    const gx = Math.sin(gamma * rad);
    const gy = Math.sin(beta * rad);
    world.setGravity(gx, gy); // 平滑在物理引擎内做，避免机械抖动
  }

  function enableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { motionHint.textContent = '此设备无重力传感器'; return; }
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(state => {
        if (state === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation);
          motionOn = true;
          enableBtn.classList.add('on');
          enableBtn.textContent = '📱 重力已开启';
        } else {
          motionHint.textContent = '未授权重力感应';
        }
      }).catch(() => { motionHint.textContent = '授权失败'; });
    } else {
      window.addEventListener('deviceorientation', handleOrientation);
      motionOn = true;
      enableBtn.classList.add('on');
      enableBtn.textContent = '📱 重力已开启';
    }
  }
  enableBtn.addEventListener('click', enableMotion);

  // 默认开启重力：非 iOS 直接挂载；iOS 需用户手势，故首次触屏自动请求授权
  (function autoEnableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission === 'function') {
      // iOS：等首次交互(任意点击)自动弹授权，无需用户去找按钮
      const once = () => {
        if (!motionOn) enableMotion();
        document.removeEventListener('touchend', once);
        document.removeEventListener('click', once);
      };
      document.addEventListener('touchend', once, { once: false });
      document.addEventListener('click', once, { once: false });
    } else {
      // Android 等：直接开启
      window.addEventListener('deviceorientation', handleOrientation);
      motionOn = true;
      enableBtn.classList.add('on');
      enableBtn.textContent = '📱 重力已开启';
    }
  })();

  // 注：canvas 为 pointer-events:none，点击始终穿透到日历方格。

  // ---------- 启动 ----------
  window.addEventListener('resize', () => requestAnimationFrame(syncPhysics));
  render();
})();
