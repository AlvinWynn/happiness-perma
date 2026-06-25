/* app.js — 幸福感知器主逻辑
 * 日历渲染 / 记录弹层(三层选择) / 本地存储 / 重力感应 / 物理世界联动
 */
(function () {
  'use strict';

  const CATS = (window.HAPPINESS_DATA && window.HAPPINESS_DATA.categories) || [];
  const STORE_KEY = 'happiness_events_v1';
  const WEEK_FIRST_MON = true; // 周一为每周第一天

  // ---------- 存储 ----------
  // 结构：{ "2026-6-12": [ {uid, catId, subId, tag, emoji, color, ts} ], ... }
  function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveAll(data) {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }
  let DB = loadAll();

  function cellKey(y, m, d) { return `${y}-${m + 1}-${d}`; } // m 为 0-based
  function uid() { return Date.now() % 1e9 + Math.floor(Math.random() * 1000); }

  function addEvent(key, ev) {
    if (!DB[key]) DB[key] = [];
    DB[key].push(ev);
    saveAll(DB);
  }
  function removeEvent(key, evUid) {
    if (!DB[key]) return;
    DB[key] = DB[key].filter(e => e.uid !== evUid);
    if (!DB[key].length) delete DB[key];
    saveAll(DB);
  }

  // ---------- 状态 ----------
  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0-based
  let activeKey = null; // 当前弹层操作的日期 key

  // ---------- DOM ----------
  const $ = sel => document.querySelector(sel);
  const calendarEl = $('#calendar');
  const monthTitle = $('#monthTitle');
  const canvas = $('#physicsCanvas');
  const world = new PhysicsWorld(canvas);

  // ---------- 日历渲染 ----------
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstWeekday(y, m) {
    let wd = new Date(y, m, 1).getDay(); // 0=周日
    return WEEK_FIRST_MON ? (wd === 0 ? 6 : wd - 1) : wd;
  }

  function renderCalendar() {
    monthTitle.textContent = `${viewYear} 年 ${viewMonth + 1} 月`;
    calendarEl.innerHTML = '';
    const lead = firstWeekday(viewYear, viewMonth);
    const total = daysInMonth(viewYear, viewMonth);

    for (let i = 0; i < lead; i++) {
      const blank = document.createElement('div');
      blank.className = 'cell blank';
      calendarEl.appendChild(blank);
    }
    for (let d = 1; d <= total; d++) {
      const key = cellKey(viewYear, viewMonth, d);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.key = key;
      const isToday = viewYear === today.getFullYear() &&
                      viewMonth === today.getMonth() && d === today.getDate();
      if (isToday) cell.classList.add('today');

      const num = document.createElement('span');
      num.className = 'daynum';
      num.textContent = d;
      cell.appendChild(num);

      const count = (DB[key] || []).length;
      if (count) cell.classList.add('has-events');

      cell.addEventListener('click', () => openSheet(key, d));
      calendarEl.appendChild(cell);
    }

    // 网格布满整行需要的尾随空格(可选，CSS grid 已自适应)
    requestAnimationFrame(syncPhysics);
  }

  // 把 DOM 方格坐标同步给物理世界，并重建粒子
  function syncPhysics() {
    // canvas 以 .calendar 的内容盒为坐标原点，覆盖全部(含滚动)高度
    const baseRect = calendarEl.getBoundingClientRect();
    const fullW = calendarEl.scrollWidth;
    const fullH = calendarEl.scrollHeight;
    world.resize(fullW, fullH);
    canvas.style.width = fullW + 'px';
    canvas.style.height = fullH + 'px';
    // 让 canvas 左上角与 .calendar 内容盒对齐(补偿 wrap 的 padding)
    canvas.style.left = calendarEl.offsetLeft + 'px';
    canvas.style.top = calendarEl.offsetTop + 'px';
    const cellMap = new Map();
    const eventsByCell = {};
    calendarEl.querySelectorAll('.cell:not(.blank)').forEach(cell => {
      const key = cell.dataset.key;
      const r = cell.getBoundingClientRect();
      cellMap.set(key, {
        x: r.left - baseRect.left,
        y: r.top - baseRect.top,
        w: r.width,
        h: r.height,
      });
      if (DB[key] && DB[key].length) eventsByCell[key] = DB[key];
    });
    world.setCells(cellMap);
    world.rebuildAll(eventsByCell);
    world.start();
  }

  // ---------- 记录弹层 ----------
  const sheet = $('#sheet');
  const sheetDate = $('#sheetDate');
  const catList = $('#catList');
  const subList = $('#subList');
  const tagList = $('#tagList');
  const todayEvents = $('#todayEvents');

  function openSheet(key, day) {
    activeKey = key;
    sheetDate.textContent = `${viewMonth + 1} 月 ${day} 日 · 记录幸福`;
    renderCats();
    subList.classList.add('hidden');
    tagList.classList.add('hidden');
    renderTodayEvents();
    sheet.classList.remove('hidden');
  }
  function closeSheet() {
    sheet.classList.add('hidden');
    activeKey = null;
  }

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
    // 自定义输入
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
      uid: uid(),
      catId: cat.id,
      subId: sub.id,
      tag,
      emoji: sub.emoji || cat.emoji,
      color: cat.color,
      ts: Date.now(),
    };
    addEvent(activeKey, ev);
    // 更新日历该格状态 + 物理
    const cell = calendarEl.querySelector(`.cell[data-key="${activeKey}"]`);
    if (cell) cell.classList.add('has-events');
    const cellMeta = world.cells.get(activeKey);
    if (cellMeta) world.rebuildCell(activeKey, DB[activeKey]);
    renderTodayEvents();
  }

  function renderTodayEvents() {
    const list = DB[activeKey] || [];
    todayEvents.innerHTML = '';
    if (!list.length) return;
    const h = document.createElement('h3');
    h.className = 'today-title';
    h.textContent = `今日已记录 ${list.length} 条`;
    todayEvents.appendChild(h);
    list.slice().reverse().forEach(ev => {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.style.setProperty('--c', ev.color);
      row.innerHTML = `<span class="ev-emoji">${ev.emoji}</span><span class="ev-tag">${ev.tag}</span>`;
      const del = document.createElement('button');
      del.className = 'ev-del';
      del.textContent = '×';
      del.addEventListener('click', () => {
        removeEvent(activeKey, ev.uid);
        const cell = calendarEl.querySelector(`.cell[data-key="${activeKey}"]`);
        if (cell && !(DB[activeKey] || []).length) cell.classList.remove('has-events');
        world.rebuildCell(activeKey, DB[activeKey] || []);
        renderTodayEvents();
      });
      row.appendChild(del);
      todayEvents.appendChild(row);
    });
  }

  sheet.querySelectorAll('[data-close]').forEach(el =>
    el.addEventListener('click', closeSheet));

  // ---------- 月份导航 ----------
  $('#prevMonth').addEventListener('click', () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  });
  $('#nextMonth').addEventListener('click', () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  });

  // ---------- 重力感应 ----------
  const enableBtn = $('#enableMotion');
  const motionHint = $('#motionHint');
  let motionOn = false;

  function handleOrientation(e) {
    // gamma: 左右倾斜[-90,90]，beta: 前后倾斜[-180,180]
    const g = (e.gamma || 0) / 90;   // 左右 -> gx
    const b = (e.beta || 0) / 90;    // 前后 -> gy 分量
    world.setGravity(
      Math.max(-1, Math.min(1, g)),
      Math.max(-0.2, Math.min(1.5, 0.5 + b * 0.7)) // 偏向朝下，倾斜叠加
    );
  }

  function enableMotion() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) {
      motionHint.textContent = '此设备无重力传感器，可拖拽图标';
      return;
    }
    if (typeof DOE.requestPermission === 'function') {
      // iOS 13+ 需授权
      DOE.requestPermission().then(state => {
        if (state === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation);
          motionOn = true;
          enableBtn.classList.add('on');
          enableBtn.textContent = '📱 重力已开启';
        } else {
          motionHint.textContent = '未授权，已降级为可拖拽';
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

  // 注：canvas 为 pointer-events:none，点击始终穿透到日历方格。
  // 桌面无传感器时图标自然沉底；重力感应是手机上的主交互。
  // (拖拽功能留待后续：需让 canvas 在命中图标时选择性接管事件)

  // ---------- 启动 ----------
  window.addEventListener('resize', () => requestAnimationFrame(syncPhysics));
  renderCalendar();
})();
