// 蜘蛛爬虫 · 前端逻辑
// 抓取由本地 server.py 完成（/api/crawl），这里负责：把抓到的内容排成页面让蜘蛛爬、
// 蜘蛛爬过一块就"收割"一块到结果面板、多页排队、导出。
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const content = $('content'), feed = $('feed');

  // ---------- 数据 ----------
  const TYPES = [
    ['page', '页面', '#5dffb4'], ['h', '标题', '#93dcff'], ['p', '段落', '#e3e7ee'], ['li', '列表', '#ffe24a'],
    ['table', '表格', '#ff8a3d'], ['img', '图片', '#ff6fae'], ['link', '链接', '#7f9dff'], ['chars', '字数', '#b05cff'],
  ];
  const TYPE_MAP = { h: 'h', p: 'p', li: 'li', quote: 'p', pre: 'p', table: 'table', img: 'img' };
  const LABEL = { h: '标题', p: '段落', quote: '引用', pre: '代码', li: '列表', table: '表格', img: '图片', link: '链接', page: '页面' };
  let pages = [];                 // [{url, title, description, items: []}]
  let counts = {};
  const blockData = new WeakMap(); // 块元素 -> {page, items}

  // ---------- 状态 ----------
  const st = {
    running: false, fast: false, maxPages: 3, filter: '', host: '',
    queue: [], visited: new Set(), fetched: 0, fetching: false, buffer: null,
    lastFetch: 0, ctrl: null, done: false,
  };

  // ---------- 蜘蛛 ----------
  const spider = Spider.create({ content, fx: $('fx'), canvas: $('legs'), onHarvest, onFrame });

  // ---------- 分词：每个词一个 <span class="w">，蜘蛛的脚才抓得住 ----------
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
  function words(parent, text) {
    const parts = seg ? Array.from(seg.segment(text), s => s.segment) : text.split(/(\s+)/);
    for (const w of parts) {
      if (!w) continue;
      if (/^\s+$/.test(w)) { parent.appendChild(document.createTextNode(' ')); continue; }
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = w;
      parent.appendChild(s);
    }
  }
  // 文字里出现的链接文字包成 <a>
  function richText(parent, text, links) {
    const MAX = 1500;
    if (text.length > MAX) text = text.slice(0, MAX) + '…';
    let pos = 0;
    for (const l of links || []) {
      if (!l.text) continue;
      const i = text.indexOf(l.text, pos);
      if (i < 0) continue;
      if (i > pos) words(parent, text.slice(pos, i));
      const a = document.createElement('a');
      a.className = 'lnk'; a.href = l.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      words(a, l.text);
      parent.appendChild(a);
      pos = i + l.text.length;
    }
    if (pos < text.length) words(parent, text.slice(pos));
  }

  // ---------- 把一页数据排成可爬的页面 ----------
  const MAX_BLOCKS = 500;
  function renderPage(data, index) {
    const page = { url: data.url, title: data.title, description: data.description, items: [] };
    pages.push(page);
    const sec = document.createElement('section');
    sec.className = 'page';
    const meta = document.createElement('div');
    meta.className = 'pg-meta';
    meta.innerHTML = `<b>#${index + 1}</b> `;
    meta.appendChild(document.createTextNode(data.url));
    sec.appendChild(meta);

    const els = [];
    const h1 = document.createElement('h1');
    h1.className = 'blk';
    words(h1, data.title || '（无标题）');
    blockData.set(h1, { page, items: [{ type: 'page', text: data.title || '', url: data.url, description: data.description || '' }] });
    sec.appendChild(h1); els.push(h1);
    if (data.description) {
      const d = document.createElement('p');
      d.className = 'desc';
      words(d, data.description);
      sec.appendChild(d);
    }

    const blocks = data.blocks || [];
    blocks.slice(0, MAX_BLOCKS).forEach(b => {
      let el;
      const items = [];
      if (b.kind === 'h') {
        el = document.createElement('h' + Math.min(4, Math.max(2, b.level || 2)));
        richText(el, b.text, b.links);
        items.push({ type: 'h', text: b.text, level: b.level });
      } else if (b.kind === 'img') {
        el = document.createElement('figure');
        const img = document.createElement('img');
        img.src = b.src; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.alt = b.text || '';
        img.onerror = () => { img.remove(); };
        el.appendChild(img);
        const cap = document.createElement('figcaption');
        words(cap, b.text ? '图片：' + b.text : '图片');
        el.appendChild(cap);
        items.push({ type: 'img', text: b.text || '', src: b.src });
      } else if (b.kind === 'table') {
        el = document.createElement('table');
        b.rows.slice(0, 40).forEach(row => {
          const tr = document.createElement('tr');
          row.forEach(cell => { const td = document.createElement('td'); words(td, cell); tr.appendChild(td); });
          el.appendChild(tr);
        });
        items.push({ type: 'table', text: b.rows.map(r => r.join(' | ')).join('\n'), rows: b.rows });
      } else {
        el = document.createElement(b.kind === 'pre' ? 'pre' : 'p');
        el.className = b.kind === 'p' ? '' : b.kind;
        richText(el, b.text, b.links);
        items.push({ type: b.kind, text: b.text });
      }
      for (const l of b.links || []) items.push({ type: 'link', text: l.text, href: l.href });
      el.classList.add('blk');
      blockData.set(el, { page, items });
      sec.appendChild(el);
      els.push(el);
    });
    if (blocks.length > MAX_BLOCKS) { // 太长的页面：多出来的部分直接收录，不排版
      const rest = blocks.slice(MAX_BLOCKS);
      const more = document.createElement('p');
      more.className = 'more';
      words(more, `……其余 ${rest.length} 块内容已直接收录到结果中`);
      sec.appendChild(more);
      for (const b of rest) {
        collect(page, [{ type: b.kind, text: b.text || (b.rows || []).map(r => r.join(' | ')).join('\n'), rows: b.rows, src: b.src, level: b.level }], false);
        for (const l of b.links || []) collect(page, [{ type: 'link', text: l.text, href: l.href }], false);
      }
    }
    if (!blocks.length) {
      const e = document.createElement('p');
      e.className = 'empty blk';
      words(e, '这个页面没有可提取的文字（可能是靠 JavaScript 渲染的网站）。');
      blockData.set(e, { page, items: [] });
      sec.appendChild(e); els.push(e);
    }
    content.appendChild(sec);
    spider.addBlocks(els);
    return els;
  }

  // ---------- 收割 ----------
  function collect(page, items, show) {
    for (const it of items) {
      page.items.push(it);
      const k = it.type === 'link' ? 'link' : it.type === 'page' ? 'page' : TYPE_MAP[it.type] || 'p';
      counts[k] = (counts[k] || 0) + 1;
      if (it.type !== 'link' && it.type !== 'img') counts.chars = (counts.chars || 0) + (it.text || '').length;
      if (show && it.type !== 'link') addFeed(it, pages.indexOf(page));
    }
    const linkN = items.filter(i => i.type === 'link').length;
    if (show && linkN) addFeed({ type: 'link', text: `${linkN} 个链接：` + items.filter(i => i.type === 'link').map(i => i.text || i.href).slice(0, 4).join('、') }, pages.indexOf(page));
    renderStats(items);
    for (const b of ['exJson', 'exCsv', 'copy']) $(b).disabled = false;
  }
  function onHarvest(el) {
    const d = blockData.get(el);
    if (!d) return;
    collect(d.page, d.items, true);
    const main = d.items.find(i => i.type !== 'link');
    if (main && !st.fast) packet(el, main);
  }

  let packets = 0;
  function packet(el, it) {
    if (packets > 6) return;
    const r = el.getBoundingClientRect(), dst = feed.getBoundingClientRect();
    const p = document.createElement('div');
    p.className = 'packet';
    p.textContent = (LABEL[it.type] || '') + ' · ' + (it.text || it.src || '').slice(0, 40);
    const tag = TYPES.find(t => t[0] === (TYPE_MAP[it.type] || it.type));
    if (tag) p.style.background = tag[2];
    document.body.appendChild(p);
    packets++;
    const x0 = Math.max(8, Math.min(innerWidth - 240, r.left + 10)), y0 = Math.max(70, Math.min(innerHeight - 30, r.top + 4));
    const x1 = dst.left + 6, y1 = dst.top + 4;
    const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 80;
    const anim = p.animate([
      { transform: `translate(${x0}px,${y0}px) scale(.6)`, opacity: 0 },
      { transform: `translate(${x0}px,${y0 - 14}px) scale(1)`, opacity: 1, offset: .15 },
      { transform: `translate(${mx}px,${my}px) scale(1)`, opacity: 1, offset: .55 },
      { transform: `translate(${x1}px,${y1}px) scale(.75)`, opacity: .2 },
    ], { duration: 900, easing: 'cubic-bezier(.4,0,.2,1)' });
    anim.onfinish = () => { p.remove(); packets--; };
  }

  // ---------- 面板 ----------
  function renderStats(bump = []) {
    const bumped = new Set(bump.map(i => i.type === 'link' ? 'link' : i.type === 'page' ? 'page' : TYPE_MAP[i.type]));
    if (bump.length) bumped.add('chars');
    $('stats').innerHTML = TYPES.map(([k, name]) =>
      `<div class="stat${bumped.has(k) ? ' bump' : ''}"><b>${fmt(counts[k] || 0)}</b><span>${name}</span></div>`).join('');
    clearTimeout(renderStats.t);
    renderStats.t = setTimeout(() => document.querySelectorAll('.stat.bump').forEach(e => e.classList.remove('bump')), 400);
  }
  const fmt = n => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  function addFeed(it, pageIdx) {
    const li = document.createElement('li');
    const key = it.type === 'link' ? 'link' : it.type === 'page' ? 'page' : TYPE_MAP[it.type] || 'p';
    const color = (TYPES.find(t => t[0] === key) || [0, 0, '#ccc'])[2];
    const tag = document.createElement('span');
    tag.className = 'tag'; tag.style.background = color; tag.textContent = LABEL[it.type] || it.type;
    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.appendChild(tag);
    txt.appendChild(document.createTextNode((it.text || it.src || '').slice(0, 200)));
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = `第 ${pageIdx + 1} 页`;
    li.append(txt, src);
    feed.prepend(li);
    while (feed.children.length > 200) feed.lastChild.remove();
    $('feedNote').textContent = feed.children.length >= 200 ? '仅显示最近 200 条，导出可得全部' : '';
  }
  function status(text, kind = '') {
    $('status').textContent = text;
    $('status').title = text;
    $('dot').className = kind;
  }
  function progress() {
    const total = Math.max(1, Math.min(st.maxPages, st.fetched + st.queue.length));
    $('prog').style.width = (100 * pages.length / total) + '%';
  }
  let toastT;
  function toast(msg, ok) {
    const t = $('toast');
    t.textContent = msg; t.className = 'show' + (ok ? ' ok' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 3500);
  }

  // ---------- 抓取流程 ----------
  const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|7z|gz|mp[34]|avi|mov|exe|dmg|apk|docx?|xlsx?|pptx?)(\?|$)/i;
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

  async function fetchPage(url) {
    st.fetching = true;
    st.visited.add(url);
    st.ctrl = new AbortController();
    status(`正在抓取 ${url}`, 'on');
    const wait = 900 - (Date.now() - st.lastFetch); // 礼貌间隔，不给对方网站压力
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    st.lastFetch = Date.now();
    try {
      const res = await fetch('/api/crawl?url=' + encodeURIComponent(url), { signal: st.ctrl.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      st.visited.add(data.url);
      st.fetched++;
      for (const l of data.links || []) {
        const u = l.href;
        if (st.visited.has(u) || st.queue.includes(u) || SKIP_EXT.test(u)) continue;
        if (hostOf(u) !== st.host) continue;
        if (st.filter && !u.includes(st.filter)) continue;
        st.queue.push(u);
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    } finally {
      st.fetching = false;
    }
  }

  function pump() {
    if (!st.running || st.fetching || st.buffer || st.fetched >= st.maxPages || !st.queue.length) return;
    const url = st.queue.shift();
    fetchPage(url).then(data => {
      if (!data || !st.running) return;
      st.buffer = data;
      status(`第 ${st.fetched} 页已就绪，蜘蛛正在读…`, 'on');
      if (st.fast) showBuffer();
    }).catch(e => {
      toast(`跳过 ${url}：${e.message}`);
      pump();
    }).finally(progress);
  }
  function showBuffer() {
    const data = st.buffer;
    st.buffer = null;
    renderPage(data, pages.length);
    if (st.fast) flushAll();
    progress();
    pump();
  }
  function flushAll() {
    for (const el of spider.flushBlocks()) {
      el.classList.add('got');
      const d = blockData.get(el);
      if (d) collect(d.page, d.items, false);
    }
  }

  let lastPrune = 0;
  function onFrame(info) {
    if (!st.running) return;
    // 蜘蛛快读到底了：把预取好的下一页接上
    if (st.buffer && info.distToEnd < info.viewH * 1.3) showBuffer();
    else if (!st.buffer && !st.fetching && info.distToEnd < 60) {
      if (st.fetched >= st.maxPages || !st.queue.length) finish();
      else pump();
    }
    // 读完很久的页面换成等高的占位块，保持 DOM 轻量
    const t = performance.now();
    if (t - lastPrune > 1000) {
      lastPrune = t;
      const secs = content.querySelectorAll('section.page');
      for (const s of secs) {
        const r = s.getBoundingClientRect();
        if (r.bottom > -2 * innerHeight || s.querySelector('.blk:not(.got)')) break;
        const ph = document.createElement('div');
        ph.className = 'page-ph';
        ph.style.height = (r.height + parseFloat(getComputedStyle(s).marginTop || 0)) + 'px';
        s.replaceWith(ph);
      }
    }
  }

  function finish() {
    if (!st.running) return;
    st.running = false;
    st.done = true;
    setButtons(false);
    $('prog').style.width = '100%';
    const n = pages.reduce((s, p) => s + p.items.length, 0);
    status(`完成：${pages.length} 个页面，${n} 条数据。可以导出了`, '');
    toast(`收割完成：${pages.length} 页 · ${n} 条数据`, true);
    spider.setMode('idle');
  }

  function setButtons(running) {
    $('go').disabled = running;
    $('stop').disabled = !running;
    $('skip').disabled = !running;
  }

  async function start(url) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { toast('网址格式不对'); return; }
    if (st.ctrl) st.ctrl.abort();
    Object.assign(st, {
      running: true, fast: false, maxPages: +$('pages').value, filter: $('filter').value.trim(), host: hostOf(url),
      queue: [], visited: new Set(), fetched: 0, fetching: false, buffer: null, done: false,
    });
    pages = []; counts = {};
    feed.innerHTML = ''; $('feedNote').textContent = '';
    renderStats();
    for (const b of ['exJson', 'exCsv', 'copy']) $(b).disabled = true;
    setButtons(true);
    $('prog').style.width = '0';
    content.innerHTML = '';
    spider.reset();
    try {
      const data = await fetchPage(url);
      if (!data || !st.running) return;
      renderPage(data, 0);
      spider.reset();
      spider.addBlocks([...content.querySelectorAll('.blk')]);
      spider.setMode('read');
      status('蜘蛛正在爬第 1 页…', 'on');
      progress();
      pump();
    } catch (e) {
      st.running = false;
      setButtons(false);
      status('抓取失败：' + e.message, 'err');
      toast('抓取失败：' + (e.message === 'Failed to fetch' ? '连不上本地服务，请先运行 python server.py' : e.message));
      showIntro();
    }
  }

  // ---------- 导出 ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const fileBase = () => 'spider-' + (hostOf(pages[0]?.url || '') || 'data') + '-' + stamp();
  function exportJson() {
    const out = { crawledAt: new Date().toISOString(), pages };
    download(fileBase() + '.json', JSON.stringify(out, null, 2), 'application/json');
  }
  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCsv() {
    const rows = [['页面序号', '页面网址', '页面标题', '类型', '内容', '链接/图片地址', '标题层级']];
    pages.forEach((p, i) => {
      for (const it of p.items) {
        if (it.type === 'table' && it.rows) {
          it.rows.forEach(r => rows.push([i + 1, p.url, p.title, '表格行', r.join(' | '), '', '']));
        } else {
          rows.push([i + 1, p.url, p.title, LABEL[it.type] || it.type, it.text || '', it.href || it.src || it.url || '', it.level || '']);
        }
      }
    });
    // 带 BOM，Excel 打开中文不乱码
    download(fileBase() + '.csv', '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  async function copyText() {
    const text = pages.map(p => [`# ${p.title}`, p.url, ...p.items.filter(i => i.type !== 'link' && i.type !== 'page').map(i => i.text)].join('\n')).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板', true); }
    catch { toast('复制失败，请使用导出'); }
  }

  // ---------- 欢迎页（蜘蛛在这里先闲逛） ----------
  function showIntro() {
    content.innerHTML = '';
    const sec = document.createElement('section');
    sec.className = 'page intro';
    const add = (tag, text, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; words(e, text); sec.appendChild(e); return e; };
    add('div', 'SPIDER SCRAPER · 本地运行 · 不上传任何数据', 'pg-meta');
    add('h1', '蜘蛛爬虫：一边抓数据，一边看它爬');
    add('p', '在上面输入一个网址，点「放出蜘蛛」。本地服务会抓取这个网页，把标题、段落、列表、表格、图片和链接整理出来，排成一页可以爬的文字。蜘蛛从顶部开始往下读，它爬过的每一段内容都会被扫描、收割，变成一个数据包飞进右侧的结果面板。');
    add('h2', '它会做什么');
    add('p', '脚踩到的词会短暂变异：描边、锁定框、高亮、放大、旋转、RGB 分色、发光，或者先变成乱码再一个个解码回原文。它会把文字拉成蛛丝色条，向远处的词射出下垂的蛛丝，留下漂移的残影。每吞下一段数据，腹部的数据核心就会亮一下。');
    add('h2', '多页抓取');
    add('p', '「页数」大于 1 时，蜘蛛读完第一页会沿着页面里的同站链接继续爬下一页。「链接含」可以限定只跟随网址里包含某段文字的链接，比如 /article/ 或 /news/。每次请求之间会间隔约一秒，并且遵守网站的 robots.txt。');
    add('h2', '导出');
    add('p', '随时可以导出 JSON 或 CSV。CSV 带 BOM，直接用 Excel 打开中文不会乱码。等不及动画时，点「跳过动画」会立刻把剩下的数据全部收完。');
    add('h2', '操作');
    add('p', '在文字区移动鼠标，蜘蛛会追着光标；点击某处，它会爬过去。按空格暂停，按 F 切换镜头跟随。滚动页面时镜头会让给你两秒半。');
    add('p', '注意：只抓取公开、允许抓取的网页。靠 JavaScript 动态渲染的网站（很多单页应用）抓到的内容可能很少；需要登录的页面抓不到。');
    content.appendChild(sec);
  }

  // ---------- 事件 ----------
  function syncBarHeight() {
    document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px');
  }
  addEventListener('resize', syncBarHeight);
  syncBarHeight();

  $('form').addEventListener('submit', e => { e.preventDefault(); start($('url').value.trim()); });
  $('stop').addEventListener('click', () => {
    st.running = false;
    if (st.ctrl) st.ctrl.abort();
    setButtons(false);
    status(`已停止：${pages.length} 个页面`, '');
    spider.setMode('idle');
  });
  $('skip').addEventListener('click', () => {
    st.fast = true;
    flushAll();
    if (st.buffer) showBuffer();
    else pump();
    status('跳过动画：直接收割剩余数据…', 'on');
    const check = setInterval(() => {
      if (!st.running) { clearInterval(check); return; }
      if (!st.fetching && !st.buffer && (st.fetched >= st.maxPages || !st.queue.length)) { clearInterval(check); flushAll(); finish(); }
    }, 300);
  });
  $('speed').addEventListener('change', e => spider.setSpeed(+e.target.value));
  $('exJson').addEventListener('click', exportJson);
  $('exCsv').addEventListener('click', exportCsv);
  $('copy').addEventListener('click', copyText);
  addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); const p = spider.togglePause(); if (p) status('已暂停（空格继续）'); }
    if (e.code === 'KeyF') toast(spider.toggleFollow() ? '镜头跟随：开' : '镜头跟随：关', true);
  });

  if (/[?&]debug\b/.test(location.search)) window.__spider = spider;
  const q = new URLSearchParams(location.search).get('url');
  showIntro();
  renderStats();
  spider.start();
  if (q) { $('url').value = q; setTimeout(() => start(q), 600); }
})();
