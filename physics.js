/* physics.js — 轻量粒子物理引擎
 * 每个幸福图标 = 一个圆形粒子，被约束在自己所属的日方格(矩形)内。
 * 支持：重力加速、触边微回弹、粒子间软排斥(避免完全重叠)、拖拽。
 * 不做跨格碰撞——每个日方格是独立沙盒。
 */
(function () {
  'use strict';

  const GRAVITY = 1400;        // px/s^2，重力强度
  const RESTITUTION = 0.4;     // 触边回弹系数(0=不弹, 1=完全弹)，0.4≈“微微回弹”
  const FRICTION = 0.86;       // 触底后的切向摩擦
  const AIR = 0.992;           // 空气阻尼，防止永久抖动
  const REST_VEL = 6;          // 低于此速度且贴边则视为静止
  const REPEL = 0.18;          // 粒子软排斥强度

  class Particle {
    constructor(opts) {
      this.id = opts.id;
      this.emoji = opts.emoji;
      this.cellId = opts.cellId;   // 所属日方格 key，如 "2026-6-12"
      this.x = opts.x;
      this.y = opts.y;
      this.vx = (opts.seed % 7 - 3) * 12;  // 入场给点随机横向速度，确定性(可复现)
      this.vy = 0;
      this.r = opts.r;
      this.dragging = false;
    }
  }

  class PhysicsWorld {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.particles = [];
      this.cells = new Map();   // cellId -> {x,y,w,h} 屏幕坐标(CSS px)
      // 重力方向：默认朝下。重力感应会改写 gx/gy。
      this.gx = 0;
      this.gy = 1;
      this.running = false;
      this.lastT = 0;
      this._loop = this._loop.bind(this);
    }

    resize(cssW, cssH) {
      this.canvas.width = cssW * this.dpr;
      this.canvas.height = cssH * this.dpr;
      this.canvas.style.width = cssW + 'px';
      this.canvas.style.height = cssH + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    // 设置/更新每个日方格的矩形边界(相对 canvas 左上角)
    setCells(cellMap) {
      this.cells = cellMap;
      // 清掉已不存在格子的粒子
      this.particles = this.particles.filter(p => this.cells.has(p.cellId));
    }

    // 根据某格当前的图标数量算半径：越多越小
    radiusFor(count, cell) {
      const base = Math.min(cell.w, cell.h);
      // 1个≈base*0.32，数量多则收缩，地板 8px
      const r = base * 0.34 / Math.sqrt(Math.max(count, 1));
      return Math.max(8, Math.min(r, base * 0.34));
    }

    // 用某格的全部事件重建该格粒子(在记录新增/月份切换时调用)
    rebuildCell(cellId, events) {
      this.particles = this.particles.filter(p => p.cellId !== cellId);
      const cell = this.cells.get(cellId);
      if (!cell || !events || !events.length) return;
      const r = this.radiusFor(events.length, cell);
      events.forEach((ev, i) => {
        // 在格子顶部错落落下
        const cols = Math.max(1, Math.floor(cell.w / (r * 2)));
        const col = i % cols;
        const row = Math.floor(i / cols);
        this.particles.push(new Particle({
          id: ev.uid,
          emoji: ev.emoji,
          cellId,
          x: cell.x + r + col * (r * 2) + (r * 0.3),
          y: cell.y + r + row * (r * 2),
          r,
          seed: i + ev.uid % 13,
        }));
      });
    }

    // 全量重建(月份切换)
    rebuildAll(eventsByCell) {
      this.particles = [];
      for (const [cellId, events] of Object.entries(eventsByCell)) {
        this.rebuildCell(cellId, events);
      }
    }

    setGravity(gx, gy) {
      this.gx = gx;
      this.gy = gy;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastT = 0;
      requestAnimationFrame(this._loop);
    }
    stop() { this.running = false; }

    _loop(t) {
      if (!this.running) return;
      if (!this.lastT) this.lastT = t;
      let dt = (t - this.lastT) / 1000;
      this.lastT = t;
      if (dt > 0.05) dt = 0.05; // 防止后台切回时大跳
      this._step(dt);
      this._render();
      requestAnimationFrame(this._loop);
    }

    _step(dt) {
      const ps = this.particles;
      // 积分
      for (const p of ps) {
        if (p.dragging) continue;
        p.vx += this.gx * GRAVITY * dt;
        p.vy += this.gy * GRAVITY * dt;
        p.vx *= AIR;
        p.vy *= AIR;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      // 同格软排斥(简单两两，单格数量小，开销可忽略)
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], b = ps[j];
          if (a.cellId !== b.cellId) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          const min = a.r + b.r;
          if (dist < min) {
            const push = (min - dist) * REPEL;
            const nx = dx / dist, ny = dy / dist;
            if (!a.dragging) { a.x -= nx * push; a.y -= ny * push; }
            if (!b.dragging) { b.x += nx * push; b.y += ny * push; }
          }
        }
      }
      // 边界约束 + 回弹
      for (const p of ps) {
        const c = this.cells.get(p.cellId);
        if (!c) continue;
        const pad = 1;
        const left = c.x + p.r + pad, right = c.x + c.w - p.r - pad;
        const top = c.y + p.r + pad, bottom = c.y + c.h - p.r - pad;
        if (p.x < left)  { p.x = left;  p.vx = -p.vx * RESTITUTION; p.vy *= FRICTION; }
        if (p.x > right) { p.x = right; p.vx = -p.vx * RESTITUTION; p.vy *= FRICTION; }
        if (p.y < top)   { p.y = top;   p.vy = -p.vy * RESTITUTION; p.vx *= FRICTION; }
        if (p.y > bottom){ p.y = bottom;p.vy = -p.vy * RESTITUTION; p.vx *= FRICTION; }
        // 沉睡
        if (Math.abs(p.vx) < REST_VEL && Math.abs(p.vy) < REST_VEL) {
          // 仍受重力会被唤醒，这里只是降抖动
          if (Math.abs(this.gx) < 0.05 && Math.abs(this.gy - 1) < 0.05) {
            // 接近静态向下重力时贴底则清零横向抖动
          }
        }
      }
    }

    _render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      for (const p of this.particles) {
        const fontSize = p.r * 1.4;
        ctx.font = fontSize + 'px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.emoji, p.x, p.y + p.r * 0.05);
      }
    }

    // 命中测试(用于拖拽)：返回最上层粒子
    hit(x, y) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        if (Math.hypot(p.x - x, p.y - y) <= p.r) return p;
      }
      return null;
    }
  }

  window.PhysicsWorld = PhysicsWorld;
})();
