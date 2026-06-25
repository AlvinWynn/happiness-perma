/* physics.js — 轻量粒子物理引擎
 * 每个幸福图标 = 一个圆形粒子，被约束在自己所属的日方格(矩形)内。
 * 模式：自由漂浮——缓慢飘动、相互碰撞弹开、触边回弹，有呼吸/漂浮感。
 * 不做跨格碰撞——每个日方格是独立沙盒。
 */
(function () {
  'use strict';

  const FLOAT_SPEED = 26;      // px/s，目标漂浮速度(缓慢)
  const SPEED_PULL = 0.6;      // 速度向目标值缓慢回拉的强度(维持漂浮感、不停不飞)
  const WALL_BOUNCE = 1;       // 触边回弹系数(1=不损失能量，持续漂浮)
  const COLL_BOUNCE = 1;       // 图标相互碰撞回弹系数(弹性碰撞)
  const WANDER = 8;            // px/s²，轻微随机扰动，制造呼吸感的不规则游走

  class Particle {
    constructor(opts) {
      this.id = opts.id;
      this.emoji = opts.emoji;
      this.star = !!opts.star;      // 是否当日星标
      this.cellId = opts.cellId;   // 所属日方格 key，如 "2026-6-12"
      this.x = opts.x;
      this.y = opts.y;
      // 入场给一个确定性的缓慢漂浮方向(可复现，不同种子方向各异)
      const ang = (opts.seed * 2.39996);   // 黄金角散布
      this.vx = Math.cos(ang) * FLOAT_SPEED;
      this.vy = Math.sin(ang) * FLOAT_SPEED;
      this.phase = opts.seed * 1.7;  // 呼吸相位
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
      this.t = 0;               // 累计时间(秒)，用于呼吸扰动
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

    // 图标半径：默认固定理想大小，不随数量缩小；
    // 仅当该数量的图标按固定大小已装不下整格时，才缩到刚好能装下。
    radiusFor(count, cell) {
      const ideal = Math.min(cell.w * 0.24, cell.h * 0.42);
      const fit = (r) =>
        Math.max(1, Math.floor(cell.w / (2 * r))) *
        Math.max(1, Math.floor(cell.h / (2 * r)));
      if (fit(ideal) >= Math.max(count, 1)) return ideal;
      // 装不下：按面积反推缩小，留一点余量
      const r = Math.sqrt((cell.w * cell.h) / (4 * count)) * 0.9;
      return Math.max(6, Math.min(r, ideal));
    }

    // 用某格的全部事件重建该格粒子(在记录新增/月份切换时调用)
    // starUid: 该格星标事件的 uid(可选)
    rebuildCell(cellId, events, starUid) {
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
          star: starUid != null && ev.uid === starUid,
          cellId,
          x: cell.x + r + col * (r * 2) + (r * 0.3),
          y: cell.y + r + row * (r * 2),
          r,
          seed: i + ev.uid % 13,
        }));
      });
    }

    // 全量重建(视图切换)。eventsByCell: {cellId: events[]}, starByCell: {cellId: starUid}
    rebuildAll(eventsByCell, starByCell) {
      this.particles = [];
      for (const [cellId, events] of Object.entries(eventsByCell)) {
        this.rebuildCell(cellId, events, starByCell && starByCell[cellId]);
      }
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
      this.t += dt;
      // 漂浮积分：轻微随机游走 + 速度向目标漂浮速度缓拉(不停不飞)，营造呼吸感
      for (const p of ps) {
        if (p.dragging) continue;
        // 基于时间与相位的平滑扰动(确定性，无需随机数)
        const wx = Math.cos(this.t * 0.7 + p.phase) + Math.cos(this.t * 1.3 + p.phase * 2.1);
        const wy = Math.sin(this.t * 0.6 + p.phase * 1.7) + Math.sin(this.t * 1.1 + p.phase);
        p.vx += wx * WANDER * dt;
        p.vy += wy * WANDER * dt;
        // 把速度缓缓拉回目标漂浮速率：太慢则加速、太快则减速
        const sp = Math.hypot(p.vx, p.vy) || 0.0001;
        const f = 1 + (FLOAT_SPEED - sp) / sp * SPEED_PULL * dt;
        p.vx *= f; p.vy *= f;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      // 同格弹性碰撞：重叠则分离 + 沿法线交换速度，相互弹向反方向
      for (let iter = 0; iter < 4; iter++) {
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i], b = ps[j];
            if (a.cellId !== b.cellId) continue;
            let dx = b.x - a.x, dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            const min = a.r + b.r;
            if (dist < min) {
              if (dist < 0.001) { // 完全重合：确定性偏移避免除零
                dx = (a.id % 2 ? 1 : -1) * 0.5; dy = 0.5; dist = 0.707;
              }
              const overlap = (min - dist);
              const nx = dx / dist, ny = dy / dist;
              const aMove = b.dragging ? overlap : overlap * 0.5;
              const bMove = a.dragging ? overlap : overlap * 0.5;
              if (!a.dragging) { a.x -= nx * aMove; a.y -= ny * aMove; }
              if (!b.dragging) { b.x += nx * bMove; b.y += ny * bMove; }
              // 弹性碰撞：沿法线交换速度分量，彼此弹向反方向
              const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
              if (rvn < 0) {
                const imp = -rvn * 0.5 * (1 + COLL_BOUNCE);
                if (!a.dragging) { a.vx -= imp * nx; a.vy -= imp * ny; }
                if (!b.dragging) { b.vx += imp * nx; b.vy += imp * ny; }
              }
            }
          }
        }
        for (const p of ps) {
          const c = this.cells.get(p.cellId);
          if (!c) continue;
          p.x = Math.max(c.x + p.r + 1, Math.min(c.x + c.w - p.r - 1, p.x));
          p.y = Math.max(c.y + p.r + 1, Math.min(c.y + c.h - p.r - 1, p.y));
        }
      }
      // 触边回弹(几乎无损耗，持续漂浮)
      for (const p of ps) {
        const c = this.cells.get(p.cellId);
        if (!c) continue;
        const pad = 1;
        const left = c.x + p.r + pad, right = c.x + c.w - p.r - pad;
        const top = c.y + p.r + pad, bottom = c.y + c.h - p.r - pad;
        if (p.x < left)  { p.x = left;  p.vx = Math.abs(p.vx) * WALL_BOUNCE; }
        if (p.x > right) { p.x = right; p.vx = -Math.abs(p.vx) * WALL_BOUNCE; }
        if (p.y < top)   { p.y = top;   p.vy = Math.abs(p.vy) * WALL_BOUNCE; }
        if (p.y > bottom){ p.y = bottom;p.vy = -Math.abs(p.vy) * WALL_BOUNCE; }
      }
    }

    _render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      for (const p of this.particles) {
        // 星标图标：金色光环
        if (p.star) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 1.05, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 200, 60, 0.28)';
          ctx.fill();
          ctx.lineWidth = Math.max(1.5, p.r * 0.12);
          ctx.strokeStyle = 'rgba(245, 170, 30, 0.9)';
          ctx.stroke();
        }
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
