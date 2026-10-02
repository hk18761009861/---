// 蜘蛛引擎：一只程序化蜘蛛在真实的网页文字上爬行。
// · 8 条腿 + 2 根触肢，两段式 IK，膝盖朝外固定弯向；四足交替步态，过度伸展会立刻收腿
// · 脚踩在真实的词上（elementFromPoint），并跟随这个词移动；排版跳动时松脚而不是被拖走
// · 被踩到的词会短暂"变异"：描边、锁定框、高亮、等宽放大、旋转、错切、RGB 分色、发光、乱码解码……
// · 残影、拉伸成色条的蛛丝、远距离下垂蛛丝、落脚波纹、小腿扫过的文字、感染相邻词
// · 收割：身体经过一个内容块时，射出一根收割丝，块被扫描并交给 onHarvest
//
// 帧纪律：update()/draw() 只读 DOM，所有写入排队到 commit() 一次性执行，
// 这样浏览器每帧只排版一次。
(() => {
  'use strict';

  // ---------- 小工具 ----------
  const R = Math.random;
  const pick = a => a[(R() * a.length) | 0];
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const V = (x = 0, y = 0) => ({ x, y });
  const add = (a, b) => V(a.x + b.x, a.y + b.y);
  const sub = (a, b) => V(a.x - b.x, a.y - b.y);
  const mul = (a, s) => V(a.x * s, a.y * s);
  const len = a => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  const mix = (a, b, t) => a + (b - a) * t;
  const rot = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return V(v.x * c - v.y * s, v.x * s + v.y * c); };
  const capLen = (v, m) => { const l = len(v); return l > m ? mul(v, m / l) : v; };
  const angLerp = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };
  const damp = (k, dt) => 1 - Math.exp(-k * dt);
  const range = ([a, b]) => a + R() * (b - a);
  const smooth = t => t * t * (3 - 2 * t);

  // ---------- 配色 ----------
  const C = {
    leg: '#6ff3ff', legHi: '#b9fbff', joint: '#ff3d7f', shell: 'rgba(8,24,58,.88)', rim: '#d6f6ff', eye: '#ff2a5f',
    blue: '#4d7cff', red: '#ff3b5c', violet: '#b05cff', cyan: '#3fe0ff', magenta: '#ff3fd8', pink: '#ff6fae',
    orange: '#ff8a3d', mint: '#5dffb4', green: '#3bff86', white: '#f4f6fa', yellow: '#ffe24a', sky: '#93dcff',
  };
  const THREAD_COLORS = [C.violet, C.orange, C.magenta, C.red, C.yellow];
  const BAR_COLORS = ['rgba(255,63,216,.78)', 'rgba(77,124,255,.74)', 'rgba(63,224,255,.62)', 'rgba(255,138,61,.72)', 'rgba(93,255,180,.6)'];
  const GLYPH_LATIN = '01<>/\\#%&$@*+=?ABCDEFXYZabcdefxyz';
  const GLYPH_CJK = '数据爬虫抓取节点链接索引协议字段解析缓存アイウエオカキクケコサシスセソ▓▒░█';

  function create(opts) {
    const content = opts.content, fx = opts.fx, cv = opts.canvas;
    const ctx = cv.getContext('2d');
    const onHarvest = opts.onHarvest || (() => {});
    const onFrame = opts.onFrame || (() => {});

    // ---------- 参数 ----------
    let SCALE = 1.35, LW = 1.3;
    const T = {
      cruise: 190, lure: 270, burstFloor: .55, stopChance: .07, stopTime: [.3, .85],
      arrive: 60, stepY: [150, 420],
      stepFrac: .3, urgentFrac: .5, overFrac: .92, placeFrac: .85, lead: .3, leadMax: .3, jump: 14,
      ambientEvery: [.03, .09], ambientPerTick: 2, shinRate: 10,
      threadEvery: [.15, .45], threadMax: 8, threadRange: 250,
    };
    let speedMul = 1;

    // ---------- 视口 / 画布 ----------
    let W = 0, H = 0, DPR = 1, colX = null;
    const sx = () => scrollX, sy = () => scrollY;
    function resize() {
      DPR = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      SCALE = W < 640 ? 1.0 : 1.35;
      LW = 1.3 * Math.sqrt(SCALE);
      cv.width = W * DPR; cv.height = H * DPR;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      for (const L of legs) setLegSize(L);
      if (colX == null) return;
      const nx = content.getBoundingClientRect().left + sx(), dx = nx - colX;
      colX = nx;
      if (dx) { shiftWorld(dx, 0); pickTarget(); }
    }
    function shiftWorld(dx, dy) {
      const seen = new Set();
      const sh = p => { if (p && !seen.has(p)) { seen.add(p); p.x += dx; p.y += dy; } };
      sh(S.p); sh(S.abd); sh(S.spin); sh(S.target);
      for (const L of legs) { sh(L.foot); sh(L.next); sh(L.from); sh(L.knee); sh(L.tip); }
      for (const t of threads) sh(t.a);
      for (const b of bars) sh(b.from);
      for (const f of flashes) sh(f.a);
      camY += dy; viewY += dy;
    }

    // ---------- 锚点：粘在某个 DOM 词上的点 ----------
    function grab(el) {
      if (!el || !content.contains(el)) return null;
      const w = el.closest('.w');
      if (!w) return null;
      const a = w.closest('a');
      return { at: w, mut: a && R() < .4 ? a : w };
    }
    function anchorPos(an) {
      if (an.el) {
        if (!an.el.isConnected) an.el = null;
        else {
          const r = an.el.getBoundingClientRect();
          if (r.width || r.height) {
            const x = r.left + an.u * r.width + sx(), y = r.top + an.v * r.height + sy();
            if (Math.abs(x - an.x) + Math.abs(y - an.y) > T.jump) an.el = null; // 排版跳动：松脚
            else { an.x = x; an.y = y; }
          }
        }
      }
      return V(an.x, an.y);
    }
    function findAnchor(P, rad = 16, tries = 5) {
      let best = null, bd = 1e9;
      for (let i = 0; i < tries; i++) {
        const q = V(P.x + (R() * 2 - 1) * rad, P.y + (R() * 2 - 1) * rad);
        const vx = q.x - sx(), vy = q.y - sy();
        if (vx < 1 || vy < 1 || vx >= W - 1 || vy >= H - 1) continue;
        const g = grab(document.elementFromPoint(vx, vy));
        if (!g) continue;
        const r = g.at.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const u = clamp((vx - r.left) / r.width, .08, .92), v = clamp((vy - r.top) / r.height, .25, .75);
        const d = dist(q, P);
        if (d < bd) { bd = d; best = { el: g.at, mut: g.mut, u, v, x: r.left + u * r.width + sx(), y: r.top + v * r.height + sy() }; }
      }
      return best || { el: null, mut: null, u: .5, v: .5, x: P.x, y: P.y };
    }

    // ---------- 变异 ----------
    const active = new Map();      // el -> {until}
    const scrambles = new Map();   // el -> {orig, t0, dur, next}
    const XCLS = ['xm', 'x-box', 'x-box2', 'x-corner', 'x-hl', 'x-ink', 'x-mono', 'x-serif', 'x-big', 'x-tiny', 'x-wide',
      'x-up', 'x-rot', 'x-skew', 'x-wave', 'x-strike', 'x-dash', 'x-blink', 'x-rgb', 'x-glow', 'x-pad'];
    const short = el => el.textContent.length < 26;
    const isCJK = s => /[぀-ヿ㐀-鿿가-힯]/.test(s);

    const RECIPES = [
      [22, () => ({ cls: ['x-box'], c: pick([C.blue, C.blue, C.cyan, C.red, C.violet, C.white]) })],
      [8, () => ({ cls: ['x-corner'], c: pick([C.mint, C.cyan, C.yellow, C.red]), life: 1.3 })],
      [6, () => ({ cls: ['x-box2'], c: pick([C.red, C.blue, C.mint]) })],
      [13, () => ({ cls: ['x-hl'], c: pick([C.cyan, C.cyan, C.sky, C.mint, C.orange]), t: '#05060f' })],
      [6, () => ({ cls: ['x-hl'], c: pick([C.blue, '#5a86ff', C.sky]), t: 'transparent' })],
      [9, el => short(el) ? ({ cls: ['x-hl', 'x-mono', 'x-big', 'x-pad'], c: pick([C.pink, C.magenta, C.mint, C.cyan]), t: pick(['#fff', '#1b0420', '#03140b']), s: pick(['1.5em', '1.8em', '2.1em']), life: 1.8 }) : null],
      [8, () => ({ cls: ['x-ink', 'x-mono'], c: pick([C.cyan, C.sky, C.white, C.red, C.violet]) })],
      [5, el => short(el) ? ({ cls: ['x-ink', 'x-serif', 'x-big', 'x-wide'], c: pick([C.sky, '#bccbff', C.white]), s: pick(['1.7em', '2.2em']), life: 1.6 }) : null],
      [5, el => short(el) ? ({ cls: ['x-ink', 'x-big'], c: pick([C.blue, '#6f8dff', C.cyan]), s: pick(['1.6em', '2em']), life: 1.6 }) : null],
      [5, () => ({ cls: ['x-tiny', 'x-mono', 'x-ink'], c: pick(['#9aa4b8', C.sky, C.white]) })],
      [6, () => ({ cls: ['x-box', 'x-ink'], c: pick([C.red, C.blue, C.violet, C.magenta]) })],
      [5, () => ({ cls: ['x-rgb'], c: C.white, life: .9 })],
      [4, () => ({ cls: ['x-glow'], c: pick([C.cyan, C.magenta, C.mint]), life: 1.3 })],
      [4, () => ({ cls: ['x-ink', 'x-wave'], c: pick([C.red, C.orange, C.magenta]) })],
      [3, () => ({ cls: ['x-strike'], c: pick([C.red, C.cyan]) })],
      [3, () => ({ cls: ['x-dash', 'x-ink'], c: pick([C.mint, C.yellow]) })],
      [3, () => ({ cls: ['x-skew', 'x-mono', 'x-ink'], c: pick([C.sky, C.white]) })],
      [3, () => ({ cls: ['x-blink', 'x-hl'], c: pick([C.red, C.magenta]), t: '#fff', life: .9 })],
      [2, () => ({ cls: ['x-up', 'x-mono', 'x-box'], c: C.white })],
      [7, el => short(el) && el.classList.contains('w') ? ({ cls: ['x-ink', 'x-mono'], c: pick([C.mint, C.green, C.cyan]), scramble: true, life: 1.3 }) : null],
    ];
    const RW = RECIPES.reduce((s, r) => s + r[0], 0);

    const Q = { mut: [], revert: [], add: [], remove: [], text: [], cls: [] };
    const mutate = (el, o = {}) => { if (el) Q.mut.push([el, o]); };

    function revert(el) {
      el.classList.remove(...XCLS);
      for (const p of ['--c', '--t', '--s', '--r']) el.style.removeProperty(p);
      const sc = scrambles.get(el);
      if (sc) { el.textContent = sc.orig; scrambles.delete(el); }
      active.delete(el);
    }
    function applyMutation(el, o) {
      if (!el.isConnected) return;
      if (active.has(el)) revert(el);
      let m = o.recipe || null;
      if (!m && o.rot != null && short(el)) m = { cls: ['x-rot', 'x-mono', 'x-ink'], c: pick([C.sky, C.cyan, C.white]), r: o.rot, life: 1.4 };
      for (let k = 0; k < 6 && !m; k++) {
        let x = R() * RW;
        for (const r of RECIPES) if ((x -= r[0]) <= 0) { m = r[1](el); break; }
      }
      if (!m) m = { cls: ['x-box'], c: C.blue };
      el.classList.add('xm', ...m.cls);
      el.style.setProperty('--c', m.c);
      if (m.t) el.style.setProperty('--t', m.t);
      if (m.s) el.style.setProperty('--s', m.s);
      if (m.r != null) el.style.setProperty('--r', m.r + 'rad');
      const life = (m.life || 1.3 + R() * 3.2) * (o.lifeMul || 1);
      if (m.scramble) scrambles.set(el, { orig: el.textContent, t0: now, dur: Math.min(life * .7, .75), next: 0 });
      active.set(el, { until: now + life });
    }
    function scrambleText(orig, k) { // k: 0..1 已解出的比例
      const pool = isCJK(orig) ? GLYPH_CJK : GLYPH_LATIN;
      let out = '';
      const n = orig.length, solved = Math.floor(n * k);
      for (let i = 0; i < n; i++) {
        const ch = orig[i];
        out += i < solved || ch === ' ' ? ch : pool[(R() * pool.length) | 0];
      }
      return out;
    }

    // ---------- 残影 ----------
    const ghosts = [];
    const ghostQ = [];
    function makeGhost(el) { // 读阶段：测量并构建，commit 时挂载
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      const g = document.createElement('div');
      g.className = 'ghost';
      g.textContent = (scrambles.get(el)?.orig || el.textContent).trim().slice(0, 34);
      g.style.color = pick([C.red, C.sky, C.white, C.blue, C.cyan, '#c9a4ff', C.mint]);
      g.style.fontSize = (18 + R() * 24) + 'px';
      g.style.setProperty('--o', (.55 + R() * .4).toFixed(2));
      g.style.setProperty('--dx', ((R() * 2 - 1) * 60).toFixed(0) + 'px');
      if (R() < .3) g.style.letterSpacing = '.25em';
      const life = .8 + R() * 1.8;
      g.style.animationDuration = life + 's';
      g.style.left = (r.left + sx() + (R() * 2 - 1) * 140) + 'px';
      g.style.top = (r.top + sy() + (R() * 2 - 1) * 22) + 'px';
      Q.add.push(g);
      ghosts.push({ g, until: now + life });
    }

    // ---------- 蛛丝色条：把词的文字拉伸成一条带子 ----------
    const bars = [];
    function bar(el, fromAnchor, toFn, color) {
      const b = document.createElement('div');
      b.className = 'silk';
      b.textContent = el ? (scrambles.get(el)?.orig || el.textContent).trim().slice(0, 60) : '';
      b.style.background = color;
      b.style.color = pick(['#fff', '#0a0a2a', 'rgba(255,255,255,.75)']);
      const h = (11 + R() * 14 * SCALE) | 0;
      b.style.height = b.style.lineHeight = h + 'px';
      Q.add.push(b);
      const o = { b, h, from: fromAnchor, to: toFn, until: now + .9 + R() * 1.5, geo: null };
      bars.push(o);
      return o;
    }

    // ---------- 蜘蛛身体 ----------
    // [静止角度(相对朝向, 右为正), 伸展长度, 髋部前后偏移]
    const LEG_DEF = [[.52, 120, 8], [1.12, 108, 3], [1.92, 106, -2], [2.58, 128, -6], [.2, 40, 11]];
    const legs = [];
    for (const side of [1, -1]) {
      LEG_DEF.forEach(([a, reach, hip], i) => {
        legs.push({
          side, idx: i, ang: a * side, base: reach, baseHip: hip, palp: i === 4,
          reach: 0, hip: 0, L1: 0, L2: 0,
          foot: null, next: null, from: null, t: 0, dur: .15, stepping: false,
          bend: 1, tint: null, tintUntil: 0, bar: null, knee: V(), tip: V(),
          group: (i + (side > 0 ? 0 : 1)) % 2, // 四足交替：两组轮流迈步
        });
      });
    }
    function setLegSize(L) {
      L.reach = L.base * SCALE; L.hip = L.baseHip * SCALE;
      L.L1 = L.reach * .56; L.L2 = L.reach * .64;
    }
    let LEG_MAX = 0;

    const S = {
      p: V(), v: V(), heading: Math.PI / 2, stopUntil: 0, brake: false,
      target: V(), tUntil: 0, phase: R() * 10, abd: V(), spin: V(), feed: 0,
    };
    let now = 0, paused = false, follow = true, followHold = 0, mode = 'idle';
    let camY = 0, viewY = 0, lastY = 0, started = false;
    const mouse = { x: 0, y: 0, t: -99 };
    let blocks = [], blockIdx = 0;  // 待收割的内容块（文档顺序）
    const harvestQ = [];

    const fwd = () => V(Math.cos(S.heading), Math.sin(S.heading));
    const hipPos = L => add(S.p, rot(V(L.hip, L.side * 3 * SCALE), S.heading));
    const restPos = L => {
      const k = L.palp ? 1 : .8;
      return add(hipPos(L), rot(V(Math.cos(L.ang) * L.reach * k, Math.sin(L.ang) * L.reach * k), S.heading));
    };
    const stepTarget = L => {
      const h = hipPos(L);
      const p = add(restPos(L), capLen(mul(S.v, T.lead), L.reach * T.leadMax));
      return add(h, capLen(sub(p, h), (L.L1 + L.L2) * T.placeFrac));
    };

    function contentBounds() {
      const r = content.getBoundingClientRect();
      // 内容区底部留有半屏空白，真正的"底"是最后一个子元素
      const tail = content.lastElementChild;
      const bottom = tail ? Math.min(r.bottom, tail.getBoundingClientRect().bottom + 40) : r.bottom;
      return { l: r.left + sx() + 30, r: r.right + sx() - 30, t: r.top + sy() + 40, b: bottom + sy() - 50 };
    }
    function safeBox() {
      const b = contentBounds();
      const m = Math.min(LEG_MAX * .7, W * .3);
      let l = Math.max(b.l, sx() + m), r = Math.min(b.r, sx() + W - m);
      if (r < l) l = r = (l + r) / 2;
      return { l, r, t: b.t, b: Math.max(b.b, b.t) };
    }
    const reading = () => mode === 'read' && follow && now > followHold;

    function pickTarget() {
      const s = safeBox();
      if (R() < T.stopChance) {
        const c = add(S.p, mul(S.v, .3));
        S.target = V(clamp(c.x + (R() * 2 - 1) * 4, s.l, s.r), Math.max(c.y, S.p.y) + R() * 4);
        S.tUntil = S.stopUntil = now + range(T.stopTime);
        S.brake = true;
        return;
      }
      S.brake = false;
      const cx = (s.l + s.r) / 2, half = (s.r - s.l) / 2;
      const g = (R() + R() + R() - 1.5) / 1.5;
      const x = clamp(mix(cx + g * half * .8, S.p.x, .45), s.l, s.r);
      let y;
      if (reading()) {
        y = Math.min(S.p.y + range(T.stepY), Math.max(s.b, S.p.y));
        if (s.b - S.p.y < 40) { // 已到底：在底部附近徘徊，等新页面
          y = s.b - R() * 60;
          S.brake = true;
        }
      } else { // 闲逛 / 用户接管镜头：留在当前视野里
        const gy = (R() + R() + R() - 1.5) / 1.5;
        y = clamp(mix(sy() + H * .5 + gy * H * .25, S.p.y, .25), Math.max(sy() + H * .25, s.t), Math.min(sy() + H * .75, s.b));
      }
      S.target = V(x, y);
      S.tUntil = now + 2 + R() * 3;
    }
    function lureTarget(px, py) {
      const s = safeBox();
      return V(clamp(px, s.l, s.r), clamp(py, sy() + H * .15, sy() + H * .85));
    }

    function steppingCount() { let n = 0; for (const L of legs) if (L.stepping) n++; return n; }
    function neighbourStepping(L) {
      if (L.palp) return false;
      for (const o of legs) {
        if (!o.stepping || o.palp || o === L) continue;
        if (o.side === L.side && Math.abs(o.idx - L.idx) === 1) return true;
        if (o.side !== L.side && o.idx === L.idx) return true;
      }
      return false;
    }
    function startStep(L, quick) {
      const h = hipPos(L), full = L.L1 + L.L2;
      let from = L.foot ? anchorPos(L.foot) : restPos(L);
      const d = sub(from, h), dl = len(d);
      if (dl > full) from = add(h, mul(d, full / dl));
      L.from = from;
      L.next = findAnchor(stepTarget(L), L.palp ? 8 : 18 * Math.sqrt(SCALE));
      L.t = 0;
      L.dur = (quick ? .07 + R() * .04 : (L.palp ? .08 : .1) + R() * .07) / Math.sqrt(speedMul);
      L.stepping = true;
      if (L.bar) { L.bar.until = Math.min(L.bar.until, now + .15); L.bar = null; }
    }
    function neighbours(el) {
      const out = [];
      for (const n of [el.previousElementSibling, el.nextElementSibling]) if (n && n.classList.contains('w')) out.push(n);
      return out;
    }
    function plant(L) {
      L.stepping = false;
      L.foot = L.next; L.next = null;
      flashes.push({ a: L.foot, t: now, sparks: R() < .5 });
      if (R() < .2) { L.tint = pick([C.green, C.mint, C.magenta]); L.tintUntil = now + 1 + R() * 2; }
      const el = L.foot.mut, word = L.foot.el;
      if (!el) return;
      const fp = anchorPos(L.foot);
      const roll = R();
      if (roll < .1 && !L.palp) {
        L.bar = bar(el, L.foot, () => S.p, pick(BAR_COLORS));
      } else if (roll < .19) {
        ghostQ.push(el); mutate(el);
      } else if (roll < .26) {
        const d = sub(fp, S.p);
        mutate(el, { rot: Math.atan2(d.y, d.x) });
      } else mutate(el);
      if (word && R() < .4) for (const n of neighbours(word)) if (R() < .6) mutate(n, { lifeMul: .7 });
    }

    // ---------- 蛛丝 ----------
    const threads = [];
    let nextThread = 0, nextAmbient = 0;
    function shootThread() {
      if (threads.length >= T.threadMax) return;
      const a = findAnchor(add(S.p, V((R() * 2 - 1) * T.threadRange, (R() * 2 - 1) * T.threadRange * .8)), 30, 4);
      if (!a.el) return;
      const color = pick(THREAD_COLORS), life = .5 + R() * .9;
      mutate(a.mut, { recipe: { cls: ['x-box'], c: color, life: life + .6 } });
      const t = { a, color, born: now, until: now + life, from: R() < .5 ? 'spin' : 'body', bar: null, w: 1, sag: (R() * 2 - 1) * 24 };
      threads.push(t);
      if (R() < .2) t.bar = bar(a.mut, a, () => S.spin, pick(BAR_COLORS.slice(0, 2)));
    }
    const flashes = [];

    // ---------- 收割 ----------
    function checkHarvest() {
      while (blockIdx < blocks.length) {
        const el = blocks[blockIdx];
        if (!el.isConnected || el.classList.contains('got')) { blockIdx++; continue; }
        const r = el.getBoundingClientRect();
        const line = r.top + sy() + Math.min(r.height * .5, 48);
        if (S.p.y + 12 < line) break;
        blockIdx++;
        harvestQ.push(el);
        // 收割丝：从吐丝口射向内容块
        const tx = clamp(S.p.x - sx(), r.left + 10, r.right - 10), ty = clamp(S.p.y - sy(), r.top + 6, r.bottom - 6);
        const a = { el: null, mut: null, u: .5, v: .5, x: tx + sx(), y: ty + sy() };
        if (threads.length < T.threadMax + 4) threads.push({ a, color: C.mint, born: now, until: now + .55, from: 'spin', w: 1.8, sag: 0, harvest: true });
        S.feed = 1;
      }
    }

    // ---------- 初始化 ----------
    function placeAt(x, y) {
      S.p = V(x, y);
      S.v = V();
      S.heading = Math.PI / 2;
      S.abd = add(S.p, V(0, -18 * SCALE)); S.spin = add(S.p, V(0, -31 * SCALE));
      for (const L of legs) { L.stepping = false; L.next = null; L.bar = null; L.foot = findAnchor(restPos(L), 18); }
      // 膝盖弯向：选在身体轴线外侧的那一边，之后固定不变（逐帧选择会让膝盖翻转）
      const f0 = fwd();
      for (const L of legs) {
        const h = hipPos(L), f = restPos(L);
        let best = 1, bd = -1e9;
        for (const s of [1, -1]) {
          L.bend = s;
          const k = sub(ik(h, f, L), S.p);
          const lateral = (f0.x * k.y - f0.y * k.x) * L.side; // 正值 = 在这条腿那一侧的外面
          if (lateral > bd) { bd = lateral; best = s; }
        }
        L.bend = best;
      }
      pickTarget();
    }
    function init() {
      resize();
      LEG_MAX = Math.max(...legs.map(L => L.L1 + L.L2));
      colX = content.getBoundingClientRect().left + sx();
      const s = safeBox();
      camY = viewY = lastY = scrollY;
      placeAt((s.l + s.r) / 2, clamp(sy() + H * .55, s.t + 60, Math.max(s.t + 60, s.b)));
      started = true;
      requestAnimationFrame(frame);
    }

    // ---------- update（只读） ----------
    function update(dt) {
      const mouseActive = now - mouse.t < 1.6;
      if (mouseActive) S.target = lureTarget(mouse.x + sx(), mouse.y + sy());
      else if (now > S.tUntil || (now > S.stopUntil && dist(S.p, S.target) < (S.brake ? 26 : T.arrive))) pickTarget();

      S.phase += dt;
      const pulse = Math.pow(Math.max(0, Math.sin(S.phase * 3.1) * .6 + Math.sin(S.phase * 1.27) * .5 + .35), .7);
      const burst = T.burstFloor + (1.15 - T.burstFloor) * Math.min(1, pulse);
      const to = sub(S.target, S.p), d = len(to);
      const maxSpd = (mouseActive ? T.lure : T.cruise * speedMul) * Math.sqrt(SCALE) * burst;
      const brake = mouseActive || S.brake;
      const want = d > 2 ? mul(to, (brake ? Math.min(maxSpd, d * 2.2) : maxSpd) / d) : V();
      S.v = lerp(S.v, want, damp(5, dt));
      S.p = add(S.p, mul(S.v, dt));
      const sp = len(S.v);
      if (sp > 6) S.heading = angLerp(S.heading, Math.atan2(S.v.y, S.v.x), damp(4 + sp * .02, dt));
      S.heading += (R() - .5) * .02;

      const abdT = add(S.p, mul(fwd(), -18 * SCALE));
      S.abd = lerp(S.abd, abdT, damp(12, dt));
      const sd = sub(S.spin, S.abd), sl = len(sd) || 1;
      S.spin = lerp(S.spin, add(S.abd, mul(sd, 14 * SCALE / sl)), damp(14, dt));
      S.feed = Math.max(0, S.feed - dt * 1.8);

      // 腿
      const maxStepping = sp > 70 ? 6 : 4;
      for (const L of legs) {
        if (L.stepping) { L.t += dt / L.dur; if (L.t >= 1) plant(L); continue; }
        const fp = L.foot ? anchorPos(L.foot) : restPos(L);
        const off = dist(fp, restPos(L));
        const over = dist(fp, hipPos(L)) > (L.L1 + L.L2) * T.overFrac;
        const urgent = off > L.reach * T.urgentFrac;
        const thresh = L.reach * (L.palp ? .25 : T.stepFrac);
        if (over || urgent) startStep(L, true);
        else if (off > thresh && steppingCount() < maxStepping && !neighbourStepping(L)) startStep(L, false);
        else if (sp < 4 && R() < dt * .3) startStep(L, false);
      }

      // 蛛丝
      if (now > nextThread) { shootThread(); nextThread = now + range(T.threadEvery); }
      for (const t of threads) {
        if (t.harvest) continue;
        const o = t.from === 'spin' ? S.spin : S.p;
        const end = anchorPos(t.a);
        if (t.until > now + .15 && (!t.a.el || dist(o, end) > T.threadRange * 1.25)) t.until = now + .15;
        if (t.bar) t.bar.until = Math.min(t.bar.until, t.until);
      }

      // 身体周围的感染
      if (now > nextAmbient) {
        for (let i = 0; i < T.ambientPerTick; i++) {
          const a = findAnchor(add(S.p, V((R() * 2 - 1) * LEG_MAX * .85, (R() * 2 - 1) * LEG_MAX * .65)), 10, 1);
          if (a.el) { mutate(a.mut, { lifeMul: .7 }); if (R() < .03) ghostQ.push(a.mut); }
        }
        nextAmbient = now + range(T.ambientEvery);
      }
      // 小腿扫过的文字
      if (R() < dt * T.shinRate) {
        const L = pick(legs);
        if (!L.palp) { const a = findAnchor(lerp(L.knee, L.tip, R() * .7), 4, 1); if (a.el) mutate(a.mut, { lifeMul: .5 }); }
      }

      if (mode === 'read') checkHarvest();

      // 乱码解码
      for (const [el, sc] of scrambles) {
        if (now < sc.next) continue;
        sc.next = now + .045;
        const k = clamp((now - sc.t0) / sc.dur, 0, 1);
        Q.text.push([el, k >= 1 ? sc.orig : scrambleText(sc.orig, k)]);
        if (k >= 1) scrambles.delete(el);
      }

      // 过期（排队，commit 时执行）
      for (const [el, m] of active) if (now > m.until) { active.delete(el); Q.revert.push(el); }
      for (let i = threads.length - 1; i >= 0; i--) if (now > threads[i].until) threads.splice(i, 1);
      for (let i = ghosts.length - 1; i >= 0; i--) if (now > ghosts[i].until) { Q.remove.push(ghosts[i].g); ghosts.splice(i, 1); }
      for (let i = bars.length - 1; i >= 0; i--) if (now > bars[i].until) { Q.remove.push(bars[i].b); bars.splice(i, 1); }
      for (let i = flashes.length - 1; i >= 0; i--) if (now - flashes[i].t > .35) flashes.splice(i, 1);

      // 镜头
      const docH = document.documentElement.scrollHeight;
      if (reading() || (mouseActive && mode === 'read')) {
        let ty = S.p.y + Math.max(0, S.v.y) * .35 - H * .5;
        if (!mouseActive && ty < camY) ty = camY;
        camY += (ty - camY) * damp(3.2, dt);
        viewY = clamp(Math.round(camY), 0, Math.max(0, docH - H));
      } else camY = viewY = scrollY;
    }

    // ---------- draw（读 + 画布） ----------
    const DR = () => Math.pow(SCALE, .6);
    function line(a, b, color, w = LW) {
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    function dot(p, color, r = 2.4) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * DR(), 0, Math.PI * 2); ctx.fill();
    }
    function ik(h, f, L) {
      const d = dist(h, f), base = Math.atan2(f.y - h.y, f.x - h.x);
      if (d >= L.L1 + L.L2 - .01) return add(h, mul(V(Math.cos(base), Math.sin(base)), L.L1));
      const c = clamp((L.L1 * L.L1 + d * d - L.L2 * L.L2) / (2 * L.L1 * d), -1, 1);
      const b = base + L.bend * Math.acos(c);
      return add(h, V(Math.cos(b) * L.L1, Math.sin(b) * L.L1));
    }

    function draw() {
      for (const el of ghostQ) makeGhost(el);
      ghostQ.length = 0;
      for (const b of bars) {
        const a = anchorPos(b.from), d = sub(b.to(), a);
        b.geo = [a, len(d), Math.atan2(d.y, d.x)];
        if (b.geo[1] > LEG_MAX * 1.3) b.until = Math.min(b.until, now + .1);
      }

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const o = V(-sx(), -viewY);
      const P = p => add(p, o);
      const dr = DR();

      // 蛛丝：射出、停留、收回；带一点下垂
      ctx.lineCap = 'round';
      for (const t of threads) {
        const org = t.from === 'spin' ? S.spin : S.p;
        const end = anchorPos(t.a);
        const e = Math.min(clamp((now - t.born) / .12, 0, 1), clamp((t.until - now) / .15, 0, 1));
        const tip = lerp(org, end, e);
        const a = P(org), b = P(tip);
        const m = lerp(a, b, .5), n = V(-(b.y - a.y), b.x - a.x);
        const cp = add(add(m, mul(n, t.sag * .002 * e)), V(0, Math.min(18, len(sub(b, a)) * .06) * e));
        if (t.harvest) { ctx.shadowColor = C.mint; ctx.shadowBlur = 10; }
        ctx.strokeStyle = t.color; ctx.lineWidth = t.w;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y); ctx.stroke();
        ctx.shadowBlur = 0;
        dot(b, t.color, t.harvest ? 2.2 : 1.4);
      }

      // 腿（带一点辉光）
      ctx.shadowColor = 'rgba(111,243,255,.55)'; ctx.shadowBlur = 6;
      for (const L of legs) {
        const h = hipPos(L);
        let f;
        if (L.stepping) {
          const e = smooth(L.t);
          f = lerp(L.from, anchorPos(L.next), e);
          f = lerp(f, h, Math.sin(Math.PI * L.t) * .18); // 抬脚：略微收向身体
        } else f = L.foot ? anchorPos(L.foot) : restPos(L);
        const k = ik(h, f, L);
        L.knee = k; L.tip = f;
        const tint = L.tint && now < L.tintUntil ? L.tint : null;
        const w = L.palp ? LW * .75 : LW;
        line(P(h), P(k), tint || C.leg, w * 1.25);
        line(P(k), P(f), tint || (L.stepping || L.idx === 3 ? C.legHi : C.leg), w);
      }
      ctx.shadowBlur = 0;
      for (const L of legs) {
        dot(P(L.knee), C.joint, L.palp ? 1.6 : 2.3);
        dot(P(L.tip), (L.tint && now < L.tintUntil) ? L.tint : C.joint, L.palp ? 1.4 : (L.stepping ? 2.6 : 2.1));
      }

      // 落脚波纹 + 火花
      for (const fl of flashes) {
        const t = (now - fl.t) / .35, p = P(anchorPos(fl.a));
        ctx.strokeStyle = `rgba(255,61,127,${1 - t})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, (3 + t * 10) * dr, 0, Math.PI * 2); ctx.stroke();
        if (fl.sparks) {
          ctx.strokeStyle = `rgba(111,243,255,${(1 - t) * .9})`;
          for (let i = 0; i < 4; i++) {
            const ang = i * Math.PI / 2 + .6, r0 = (4 + t * 8) * dr, r1 = r0 + 4 * dr;
            ctx.beginPath(); ctx.moveTo(p.x + Math.cos(ang) * r0, p.y + Math.sin(ang) * r0);
            ctx.lineTo(p.x + Math.cos(ang) * r1, p.y + Math.sin(ang) * r1); ctx.stroke();
          }
        }
      }

      // 身体：腹部（带数据核心）+ 头胸部 + 眼睛 + 螯肢
      const c = P(S.p), ab = P(S.abd), sp = P(S.spin);
      const abAng = Math.atan2(c.y - ab.y, c.x - ab.x);
      line(c, ab, C.leg, LW * 1.2);
      for (const L of legs) if (!L.palp && L.idx % 2 === 0) line(ab, P(hipPos(L)), 'rgba(111,243,255,.35)', 1);

      ctx.save();
      ctx.translate(ab.x, ab.y); ctx.rotate(abAng); ctx.scale(SCALE, SCALE);
      ctx.shadowColor = S.feed > 0 ? C.mint : 'rgba(111,243,255,.6)';
      ctx.shadowBlur = 8 + S.feed * 18;
      ctx.fillStyle = C.shell; ctx.strokeStyle = C.rim; ctx.lineWidth = 1.2 / SCALE;
      ctx.beginPath(); ctx.ellipse(-4, 0, 13, 9.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      // 背上的人字纹
      ctx.strokeStyle = 'rgba(255,63,216,.85)'; ctx.lineWidth = 1 / SCALE;
      for (let i = 0; i < 3; i++) {
        const x = 2 - i * 5;
        ctx.beginPath(); ctx.moveTo(x - 3, -4 + i * .6); ctx.lineTo(x, 0); ctx.lineTo(x - 3, 4 - i * .6); ctx.stroke();
      }
      // 数据核心：每收割一块就亮一下
      const core = 2 + S.feed * 2.5 + Math.sin(now * 6) * .4;
      ctx.fillStyle = S.feed > .05 ? C.mint : 'rgba(93,255,180,.55)';
      ctx.beginPath(); ctx.arc(-6, 0, core, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(c.x, c.y); ctx.rotate(S.heading); ctx.scale(SCALE, SCALE);
      ctx.shadowColor = 'rgba(111,243,255,.6)'; ctx.shadowBlur = 8;
      ctx.fillStyle = C.shell; ctx.strokeStyle = C.rim; ctx.lineWidth = 1.2 / SCALE;
      ctx.beginPath(); ctx.ellipse(1, 0, 10, 7.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      // 螯肢
      ctx.strokeStyle = C.rim; ctx.lineWidth = 1.4 / SCALE;
      ctx.beginPath(); ctx.moveTo(10, -2.5); ctx.lineTo(14, -1.5); ctx.moveTo(10, 2.5); ctx.lineTo(14, 1.5); ctx.stroke();
      // 八只眼
      ctx.fillStyle = C.eye;
      for (const [ex, ey, er] of [[7.5, -2, 1.3], [7.5, 2, 1.3], [6, -4, .8], [6, 4, .8], [5, -1, .7], [5, 1, .7], [3.6, -3, .6], [3.6, 3, .6]]) {
        ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      dot(sp, C.joint, 2);
    }

    // ---------- commit（所有 DOM 写入，一帧一次） ----------
    function commit() {
      for (const el of Q.revert) if (!active.has(el)) revert(el);
      for (const [el, o] of Q.mut) applyMutation(el, o);
      for (const [el, s] of Q.text) if (el.isConnected) el.textContent = s;
      for (const n of Q.remove) n.remove();
      for (const n of Q.add) fx.appendChild(n);
      for (const b of bars) {
        if (!b.geo) continue;
        const [a, l, ang] = b.geo;
        b.b.style.left = a.x + 'px';
        b.b.style.top = (a.y - b.h / 2) + 'px';
        b.b.style.width = l + 'px';
        b.b.style.transform = `rotate(${ang}rad)`;
      }
      for (const el of harvestQ) {
        el.classList.add('got', 'scan');
        setTimeout(() => el.classList.remove('scan'), 900);
        onHarvest(el);
      }
      harvestQ.length = 0;
      Q.revert.length = Q.mut.length = Q.remove.length = Q.add.length = Q.text.length = 0;
      if (viewY !== scrollY) scrollTo(scrollX, viewY);
      lastY = scrollY;
      const s = safeBox();
      onFrame({ distToEnd: s.b - S.p.y, viewH: H, y: S.p.y });
    }

    // ---------- 主循环 ----------
    let last = performance.now();
    function frame(t) {
      requestAnimationFrame(frame);
      const dt = Math.min(.05, (t - last) / 1000);
      last = t;
      if (Math.abs(scrollY - lastY) > 1) followHold = now + 2.5;
      if (!paused) { now += dt; update(dt); } else viewY = scrollY;
      draw();
      commit();
    }

    // ---------- 输入 ----------
    addEventListener('resize', resize);
    content.addEventListener('mousemove', e => {
      if (Math.hypot(e.movementX, e.movementY) > 1.5) mouse.t = now;
      mouse.x = e.clientX; mouse.y = e.clientY;
    });
    content.addEventListener('mouseleave', () => { mouse.t = -99; });
    content.addEventListener('click', e => {
      if (e.target.closest('a, button, input')) return;
      S.target = lureTarget(e.clientX + sx(), e.clientY + sy());
      S.tUntil = now + 4; S.stopUntil = 0; S.brake = true; mouse.t = -99;
    });
    addEventListener('wheel', () => { followHold = now + 2.5; }, { passive: true });
    addEventListener('touchmove', () => { followHold = now + 2.5; }, { passive: true });

    // ---------- 对外接口 ----------
    const api = {
      start() { requestAnimationFrame(() => requestAnimationFrame(init)); },
      setMode(m) { mode = m; pickTarget(); },
      get mode() { return mode; },
      setSpeed(k) { speedMul = k; },
      togglePause() { paused = !paused; return paused; },
      toggleFollow() { follow = !follow; return follow; },
      addBlocks(els) { blocks.push(...els); },
      // 清空页面内容后调用：把蜘蛛放回顶部，重新抓地
      reset() {
        for (const el of [...active.keys()]) revert(el);
        for (const g of ghosts) g.g.remove();
        for (const b of bars) b.b.remove();
        ghosts.length = bars.length = threads.length = flashes.length = 0;
        scrambles.clear();
        blocks = []; blockIdx = 0;
        if (!started) return;
        scrollTo(0, 0);
        camY = viewY = lastY = 0;
        followHold = 0;
        const s = safeBox();
        placeAt((s.l + s.r) / 2, s.t + 120);
      },
      // 不经过蜘蛛直接收割（"跳过动画"）
      flushBlocks() {
        const out = blocks.slice(blockIdx).filter(el => el.isConnected && !el.classList.contains('got'));
        blockIdx = blocks.length;
        return out;
      },
      get debug() { return { S, legs, threads, now }; },
    };
    return api;
  }

  window.Spider = { create };
})();
