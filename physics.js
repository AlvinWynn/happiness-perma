/* physics.js — 轻量粒子物理引擎
 * 每个幸福图标 = 一个圆形粒子，被约束在自己所属的日方格(矩形)内。
 * 支持：重力加速、触边微回弹、粒子间软排斥(避免完全重叠)、拖拽。
 * 不做跨格碰撞——每个日方格是独立沙盒。
 */
(function () {
  'use strict';

  // 失重悬浮模型：图标默认悬在格子中央附近轻轻漂浮(呼吸感)，
  // 重力感应只施加温和牵引让整团朝倾斜方向缓缓移动；碰边/碰撞才回弹。
  const TILT_PULL = 240;       // 重力感应牵引力(越大越跟手；不宜过大否则被压到边)
  const CENTER_PULL = 2.2;     // 回正力：把图标缓缓拉回格子中央(弹簧刚度)
  const CENTER_DAMP = 0.4;     // 回正阻尼(防止来回过冲)
  const BREATH = 16;           // 呼吸扰动加速度(制造悬浮的不规则微动)
  const RESTITUTION = 0.7;     // 触边回弹系数
  const COLL_BOUNCE = 0.9;     // 图标互撞回弹(弹性)
  const FRICTION = 0.98;       // 触边切向保留(可斜向滑)
  const AIR = 0.985;           // 空气阻尼(让漂浮缓和、不越漂越快)
  const MAX_SPEED = 140;       // 速度上限(避免被牵引/扰动加速到乱飞)
  const REST_VEL = 2;
  const PACK = 0.78;           // 碰撞间距系数(<1→图标挨得更近)

  class Particle {
    constructor(opts) {
      this.id = opts.id;
      this.emoji = opts.emoji;
      this.star = !!opts.star;      // 是否当日星标
      this.cellId = opts.cellId;   // 所属日方格 key，如 "2026-6-12"
      this.x = opts.x;
      this.y = opts.y;
      this.vx = (opts.seed % 7 - 3) * 4;   // 入场给点微小漂移速度(确定性、可复现)
      this.vy = (opts.seed % 5 - 2) * 4;
      this.r = opts.r;
      this.phase = (opts.seed % 17) * 0.37; // 失重弹跳相位，使各图标错开节奏
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
        // 在格子中央附近错落散布(失重悬浮，会被回正力聚到中间)
        const seed = i + ev.uid % 13;
        const ang = seed * 2.39996;            // 黄金角散布
        const rad = Math.min(cell.w, cell.h) * 0.18 * ((seed % 3 + 1) / 3);
        this.particles.push(new Particle({
          id: ev.uid,
          emoji: ev.emoji,
          star: starUid != null && ev.uid === starUid,
          cellId,
          x: cell.x + cell.w / 2 + Math.cos(ang) * rad,
          y: cell.y + cell.h / 2 + Math.sin(ang) * rad,
          r,
          seed,
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
      this.t = (this.t || 0) + dt;
      // 重力(感应)平滑趋近目标：消除抖动、转向柔和
      const smooth = 1 - Math.pow(0.02, dt);
      this.gx += (this.tgx - this.gx) * smooth;
      this.gy += (this.tgy - this.gy) * smooth;
      // 失重悬浮积分：中心回正(悬在格中央) + 重力牵引(缓缓漂移) + 呼吸扰动
      for (const p of ps) {
        if (p.dragging) continue;
        const c = this.cells.get(p.cellId);
        let ax = 0, ay = 0;
        if (c) {
          // 1) 回正力：把图标拉向格子中央(弹簧)，使其悬浮在中间而非堆到某条边。
          //    牵引会把"平衡点"从中央偏移，所以倾斜时整团停在偏向倾斜方向的位置悬浮。
          const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
          const reachX = c.w / 2 - p.r, reachY = c.h / 2 - p.r;
          // 牵引导致的中心偏移(归一化到格子半径)，倾斜越大整团越靠那一侧但不贴边
          const offX = Math.max(-1, Math.min(1, this.gx)) * reachX * 0.6;
          const offY = Math.max(-1, Math.min(1, this.gy)) * reachY * 0.6;
          const tx = cx + offX, ty = cy + offY; // 目标悬浮点
          ax += (tx - p.x) * CENTER_PULL - p.vx * CENTER_DAMP;
          ay += (ty - p.y) * CENTER_PULL - p.vy * CENTER_DAMP;
        }
        // 2) 重力牵引：温和地朝倾斜方向推(让移动跟手、缓慢)
        ax += this.gx * TILT_PULL;
        ay += this.gy * TILT_PULL;
        // 3) 呼吸扰动：基于时间与各自相位的平滑微动，制造失重悬浮的不规则感
        ax += Math.cos(this.t * 0.9 + p.phase) * BREATH;
        ay += Math.sin(this.t * 1.1 + p.phase * 1.7) * BREATH;

        p.vx = (p.vx + ax * dt) * AIR;
        p.vy = (p.vy + ay * dt) * AIR;
        // 限速，避免被牵引/扰动越加越快乱飞
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_SPEED) { p.vx *= MAX_SPEED / sp; p.vy *= MAX_SPEED / sp; }
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
            const min = (a.r + b.r) * PACK; // 收紧间距，图标可挨得更近
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
                const imp = -rvn * 0.5 * (1 + COLL_BOUNCE);
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
