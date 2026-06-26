/* physics.js — 轻量粒子物理引擎
 * 每个幸福图标 = 一个圆形粒子，被约束在自己所属的日方格(矩形)内。
 * 支持：重力加速、触边微回弹、粒子间软排斥(避免完全重叠)、拖拽。
 * 不做跨格碰撞——每个日方格是独立沙盒。
 */
(function () {
  'use strict';

  const GRAVITY = 300;         // px/s^2，重力强度(更低→更强失重漂浮感)
  const RESTITUTION = 0.72;    // 触边回弹系数(更高→撞边轻弹更明显)
  const FRICTION = 0.99;       // 触边后的切向保留(接近1→不削减斜向速度，可45°滑行)
  const AIR = 0.998;           // 空气阻尼(越接近1越漂浮、动能越持久)
  const REST_VEL = 2;          // 低于此速度且贴边则视为静止
  const REPEL = 0.18;          // 粒子软排斥强度

  class Particle {
    constructor(opts) {
      this.id = opts.id;
      this.emoji = opts.emoji;
      this.star = !!opts.star;      // 是否当日星标
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
      this.viewScale = 1;       // 图标大小缩放(月视图放大、周视图=1)
      // 重力方向：默认朝下。重力感应写入 target，实际重力每帧平滑趋近(消除机械抖动)。
      this.gx = 0;
      this.gy = 1;
      this.tgx = 0;
      this.tgy = 1;
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
      const ideal = Math.min(cell.w * 0.19, cell.h * 0.33) * this.viewScale;
      const fit = (r) =>
        Math.max(1, Math.floor(cell.w / (2 * r))) *
        Math.max(1, Math.floor(cell.h / (2 * r)));
      if (fit(ideal) >= Math.max(count, 1)) return ideal;
      // 装不下：按面积反推缩小，留一点余量
      const r = Math.sqrt((cell.w * cell.h) / (4 * count)) * 0.9;
      return Math.max(5, Math.min(r, ideal));
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

    setGravity(gx, gy) {
      // 写入目标重力；实际重力在 _step 中平滑趋近，避免传感器抖动造成机械顿挫
      this.tgx = gx;
      this.tgy = gy;
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
      // 重力平滑趋近目标(低通滤波)：消除传感器抖动、转向更柔和。
      // base 越大越柔(环绕转圈时图标过渡更顺滑)。
      const smooth = 1 - Math.pow(0.02, dt);
      this.gx += (this.tgx - this.gx) * smooth;
      this.gy += (this.tgy - this.gy) * smooth;
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
      // 同格碰撞分离：完整推开重叠的图标(多次迭代解开连锁重叠)，避免相互压盖
      for (let iter = 0; iter < 4; iter++) {
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i], b = ps[j];
            if (a.cellId !== b.cellId) continue;
            let dx = b.x - a.x, dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            const min = a.r + b.r;
            if (dist < min) {
              if (dist < 0.001) { // 完全重合：给个确定性偏移避免除零
                dx = (a.id % 2 ? 1 : -1) * 0.5; dy = 0.5; dist = 0.707;
              }
              const overlap = (min - dist);
              const nx = dx / dist, ny = dy / dist;
              // 把两者各推开一半，彻底分离
              const aMove = b.dragging ? overlap : overlap * 0.5;
              const bMove = a.dragging ? overlap : overlap * 0.5;
              if (!a.dragging) { a.x -= nx * aMove; a.y -= ny * aMove; }
              if (!b.dragging) { b.x += nx * bMove; b.y += ny * bMove; }
              // 沿法线交换一点速度，碰撞后自然弹开而非粘连
              const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
              if (rvn < 0) {
                const imp = -rvn * 0.5 * (1 + RESTITUTION);
                if (!a.dragging) { a.vx -= imp * nx; a.vy -= imp * ny; }
                if (!b.dragging) { b.vx += imp * nx; b.vy += imp * ny; }
              }
            }
          }
        }
        // 每次迭代后夹回边界，防止被推出格子
        for (const p of ps) {
          const c = this.cells.get(p.cellId);
          if (!c) continue;
          p.x = Math.max(c.x + p.r + 1, Math.min(c.x + c.w - p.r - 1, p.x));
          p.y = Math.max(c.y + p.r + 1, Math.min(c.y + c.h - p.r - 1, p.y));
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
