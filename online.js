/* online.js — 在线版数据加载器 v3（内置库 v2）
 * 数据优先级（每只标的按序尝试，命中即停）：
 *   L0 本地缓存(localStorage, 紧凑串)         —— 重复游玩/换池/续档秒开
 *   L1.5 网页内置离线库(股票+ETF K线烘焙文件)  —— 同源打包，无需联网；离线版止于 baked_at，需联网补最后 1-2 天
 *   L1 jsdelivr CDN(每股一个分片)             —— 全局 CDN 单请求全量（兜底备用）
 *   L2 东财 push2his（单请求全量，2026-09-03 实测 CORS:*）
 *   L3 腾讯 gtimg（分窗 ≤640 根/窗）
 *   L4 新浪 CN JSONP（仅末尾约 1000 根，最后兜底）
 * 依赖: window.GAME_KLINE / window.GAME_ETF / window.GAME_INDEX（提供股票/ETF 烘焙库与全局交易日轴）
 */
(function (g) {
  'use strict';
  var IX_END = null;        // 全局轴终点 yyyymmdd（init 传入）
  var IX_END_ISO = '';
  var L1 = { base: 'https://cdn.jsdelivr.net/gh/a3924/ashare-kline-db@main', ver: null, on: false, checked: false };
  var CACHE_PFX = 'simsA.kl2.';   // 缓存 key 前缀（改格式/口径时换号；kl1→kl2 因旧缓存混入不复权断层数据）
  var CACHE_MAX = 40;             // 最多缓存 40 只（≈1.3MB 紧凑串，留 localStorage 余量）
  var stats = { src: { cache: 0, off: 0, cdn: 0, em: 0, tx: 0, sina: 0 }, bytes: 0 };

  // ---------- 工具 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoOf(dt) { var s = String(dt); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
  function dtOf(iso) { return parseInt(iso.replace(/-/g, ''), 10); }
  function dayAfter(dt) {
    var t = new Date(Math.floor(dt / 10000), Math.floor(dt / 100) % 100 - 1, dt % 100);
    t.setDate(t.getDate() + 1);
    return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pfx(code) { return (code[0] === '5' || code[0] === '6') ? 'sh' : 'sz'; }
  function fullOf(code) { return pfx(code) + code; }
  function emSecid(code) { return (code[0] === '5' || code[0] === '6') ? '1.' + code : '0.' + code; }

  // 带超时+重试的 fetch（retry 次指数退避），返回解析后的 JSON
  async function fetchJSON(url, retry, timeoutMs, referer) {
    retry = retry == null ? 1 : retry;
    timeoutMs = timeoutMs || 8000;
    var lastErr = null;
    for (var t = 0; t <= retry; t++) {
      var ctl = null;
      try {
        ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var to = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, timeoutMs) : null;
        var opt = { method: 'GET', cache: 'no-store' };
        if (ctl) opt.signal = ctl.signal;
        if (referer) opt.headers = { Referer: referer };
        var resp = await fetch(url, opt);
        if (to) clearTimeout(to);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
      } catch (e) {
        lastErr = e;
        try { if (ctl) clearTimeout(to); } catch (e2) {}
        await delay(500 * (t + 1) + Math.random() * 300);
      }
    }
    throw lastErr || new Error('fetch fail');
  }

  // 统一行格式 [yyyymmdd, open, close, high, low, vol]（与东财原始列序一致），压缩为紧凑串 "dt,o,c,h,l,v|dt,.."
  // ⚠ app.js attachK 按 o/c/h/l/v 回填（close=第3列）；请勿按 o/h/l/c 误读，否则 close 会变成 low、K线几乎全绿
  function encRows(rows) {
    var parts = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      parts.push(r[0] + ',' + (+r[1]).toFixed(2) + ',' + (+r[2]).toFixed(2) + ',' +
        (+r[3]).toFixed(2) + ',' + (+r[4]).toFixed(2) + ',' + Math.round(+r[5]));
    }
    return parts.join('|');
  }
  function decRows(s) {
    if (!s) return [];
    var out = [], ps = s.split('|');
    for (var i = 0; i < ps.length; i++) {
      var f = ps[i].split(',');
      if (f.length < 6) continue;
      out.push([+f[0], +f[1], +f[2], +f[3], +f[4], +f[5]]);
    }
    return out;
  }

  // ---------- 本地缓存（L0） ----------
  function loadCache(code) {
    try {
      var raw = localStorage.getItem(CACHE_PFX + code);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return { end: o.end, rows: decRows(o.k) };
    } catch (e) { return null; }
  }
  function saveCache(code, rows) {
    if (!rows || !rows.length) return;
    try {
      var end = rows[rows.length - 1][0];
      var key = CACHE_PFX + code;
      // LRU：先移除旧记录
      var order = [];
      try { order = JSON.parse(localStorage.getItem(CACHE_PFX + '_o') || '[]'); } catch (e) {}
      order = order.filter(function (c) { return c !== code; });
      order.push(code);
      while (order.length > CACHE_MAX) {
        var old = order.shift();
        try { localStorage.removeItem(CACHE_PFX + old); } catch (e) {}
      }
      try { localStorage.setItem(CACHE_PFX + '_o', JSON.stringify(order)); } catch (e) {}
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), end: end, k: encRows(rows) }));
    } catch (e) { /* quota/隐私模式：忽略 */ }
  }

  // ---------- 网页内置离线库（L1.5：GAME_KLINE 130 只股 + GAME_ETF 20 只 ETF，无网络秒命中） ----------
  // 列存储 {d:[],o:[],c:[],h:[],l:[],v:[]} → 转统一行序 [yyyymmdd,o,c,h,l,v]
  function loadOfflineRows(off) {
    var rows = [];
    var n = off.d.length;
    for (var i = 0; i < n; i++) rows.push([off.d[i], off.o[i], off.c[i], off.h[i], off.l[i], off.v[i]]);
    return rows;
  }
  function findOffline(code) {
    var src = null, off = null;
    if (g.GAME_KLINE && g.GAME_KLINE.stocks && g.GAME_KLINE.stocks[code]) { src = 'KLINE'; off = g.GAME_KLINE.stocks[code]; }
    else if (g.GAME_ETF && g.GAME_ETF.etfs && g.GAME_ETF.etfs[code]) { src = 'ETF'; off = g.GAME_ETF.etfs[code]; }
    return off ? { src: src, off: off, end: off.d[off.d.length - 1], n: off.d.length } : null;
  }

  // ---------- 静态库探测（L1：jsdelivr 兜底备用，国内访问经常失效） ----------
  async function checkL1() {
    if (L1.checked) return L1.on;
    L1.checked = true;
    try {
      var j = await fetchJSON(L1.base + '/manifest.json', 0, 2600);
      if (j && j.ver && j.end >= IX_END - 5 && j.n >= 5000) {   // manifest 完整(≥5000只)且接近轴终点才启用 L1
        L1.on = true; L1.ver = j.ver;
      }
    } catch (e) { L1.on = false; }
    return L1.on;
  }
  async function fetchCdn(code) {
    var full = fullOf(code);
    var j = await fetchJSON(L1.base + '/db/' + L1.ver + '/' + full + '.json', 0, 4000);
    if (!j || !j.k) throw new Error('bad cdn shard');
    return decRows(j.k);
  }

  // ---------- 东财（L2，单请求全量；双主机轮换抗封禁） ----------
  var EM_HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com'];
  async function fetchEastmoney(code, begISO) {
    var secid = emSecid(code);
    var lastErr = null;
    for (var hi = 0; hi < EM_HOSTS.length; hi++) {
      try {
        var url = 'https://' + EM_HOSTS[hi] + '/api/qt/stock/kline/get?secid=' + secid +
          '&klt=101&fqt=1&beg=' + begISO + '&end=' + IX_END_ISO + '&lmt=1000000' +
          '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56';
        var j = await fetchJSON(url, 1, 9000);
        var node = j && j.data && j.data.klines;
        if (!node || !node.length) throw new Error('em empty');
        var rows = [];
        for (var i = 0; i < node.length; i++) {
          var f = node[i].split(',');
          if (f.length < 6) continue;
          rows.push([dtOf(f[0]), +f[1], +f[2], +f[3], +f[4], +f[5]]);
        }
        return rows;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('em fail');
  }

  // ---------- 腾讯（L3，分窗） ----------
  function genWindows(fromISO) {
    var win = [];
    var from = dtOf(fromISO);
    var cur = from, guard = 0;
    while (cur <= IX_END && guard < 6) {
      guard++;
      // 每段 ≤ ~730 自然日（≈500 根交易日，留 640 上限余量）
      var toDT = Math.min(IX_END, (function (d) {
        var t = new Date(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100);
        t.setDate(t.getDate() + 720);
        return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
      })(cur));
      win.push([isoOf(cur), isoOf(toDT)]);
      cur = dayAfter(toDT);
    }
    return win;
  }
  async function fetchWin(full, start, end) {
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
      full + ',day,' + start + ',' + end + ',640,qfq';
    var j = await fetchJSON(url, 1, 9000, 'https://gu.qq.com/');
    var node = j && j.data && j.data[full];
    if (!node) throw new Error('tx bad node');
    var arr = node.qfqday || node.day || [];
    if (!arr.length) throw new Error('tx empty');
    var rows = [];
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      rows.push([dtOf(b[0]), +b[1], +b[2], +b[3], +b[4], +b[5]]);
    }
    return rows;
  }
  async function fetchTencent(code, fromISO) {
    var full = fullOf(code);
    var merged = {};
    var ws = genWindows(fromISO);
    var any = false;
    for (var k = 0; k < ws.length; k++) {
      var rows = await fetchWin(full, ws[k][0], ws[k][1]);
      for (var i = 0; i < rows.length; i++) {
        var dt = rows[i][0];
        if (dt > IX_END) continue;
        if (!merged[dt]) { merged[dt] = rows[i]; any = true; }
      }
    }
    if (!any) throw new Error('tx no rows');
    return Object.keys(merged).map(Number).sort(function (a, b) { return a - b; })
      .map(function (d) { return merged[d]; });
  }

  // ---------- 新浪（L4，JSONP 末尾约1000根） ----------
  function fetchSina(code) {
    return new Promise(function (resolve, reject) {
      var full = fullOf(code);
      var cb = '__ks_' + Math.floor(Math.random() * 1e9);
      var to = setTimeout(function () { cleanup(); reject(new Error('sina timeout')); }, 7000);
      function cleanup() {
        clearTimeout(to);
        try { delete g[cb]; } catch (e) {}
        var s = g.document && g.document.getElementById('sinajs');
        if (s) s.parentNode.removeChild(s);
      }
      g[cb] = function (arr) {
        cleanup();
        try {
          if (!arr || !arr.length) return reject(new Error('sina empty'));
          var rows = [];
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            var dt = dtOf(it.day);
            if (dt > IX_END) continue;
            rows.push([dt, +it.open, +it.close, +it.high, +it.low, +it.volume]);
          }
          if (!rows.length) return reject(new Error('sina no rows'));
          resolve(rows);
        } catch (e) { reject(e); }
      };
      var sc = g.document.createElement('script');
      sc.id = 'sinajs';
      sc.src = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/' + cb +
        '/CN_MarketDataService.getKLineData?symbol=' + full + '&scale=240&ma=no&datalen=1100';
      sc.onerror = function () { cleanup(); reject(new Error('sina net')); };
      g.document.head.appendChild(sc);
    });
  }

  // ---------- 合并（丢弃超出轴、按日去重、升序） ----------
  function mergeRows(acc, add) {
    if (!add) return acc;
    for (var i = 0; i < add.length; i++) {
      var dt = add[i][0];
      if (dt > IX_END) continue;
      if (!acc[dt]) acc[dt] = add[i];
    }
    return acc;
  }

  // ---------- 复权断层守卫（除权/拆分不得显示成真实大跌） ----------
  // A股挂牌基金（ETF/LOF：深 15/16 段、沪 50/51/56/58 段）场内单日涨跌停仅 ±10%；
  // 股票限 ±10/20/30%。故单日收盘跌幅超阈值只可能是"不复权"残留（新浪裸价 / 旧版本地缓存），
  // 而前复权序列会把 份额拆分/送转 熨平成连续曲线，绝不该出现这种断层。
  function isFund(code) { return /^(1[5-9]|5[0168])\d{4}$/.test(code); }
  function artifactAt(rows, thr) {
    // 跳过开头 5 根：避开新股上市初期无涨跌幅限制的合法巨震（主板首日可 -36%）
    for (var i = 5; i < rows.length; i++) {
      var c0 = rows[i - 1][2], c1 = rows[i][2];
      if (c0 > 0 && c1 / c0 <= thr) return { d: rows[i][0], c0: c0, c1: c1, r: c1 / c0 };
    }
    return null;
  }

  // 拉一只完整K线（含缓存/级联/复权守卫）；成功返回升序 rows
  async function fetchKLine(code) {
    var thr = isFund(code) ? 0.66 : 0.62;   // 基金拆分类约腰斩(0.5)；股票大比例送转约 0.5-0.6
    var cac = loadCache(code);
    // 缓存必须 完整(覆盖到轴终点) 且 无复权断层，才能直接命中；否则作废改走联网前复权源
    if (cac && cac.end >= IX_END && cac.rows.length && !artifactAt(cac.rows, thr)) {
      stats.src.cache++;
      return cac.rows;
    }
    if (cac) {
      try { localStorage.removeItem(CACHE_PFX + code); } catch (e) {}   // 旧缓存可能混入早期裸价断层数据
      cac = null;
    }

    var acc = {};

    // L1.5 网页内置离线库（GAME_KLINE 130股 + GAME_ETF 20只）—— 命中即秒返且零网络；end<IX_END 继续走联网补尾
    var offHit = findOffline(code), offBad = false;
    if (offHit) {
      var offRows = loadOfflineRows(offHit.off);
      var offArt = artifactAt(offRows, thr);
      if (offArt) {
        // 内置库该标的含复权断层（烘焙污染，如 601138/002230 @2024-01-10）→ 放弃离线，
        // 改走联网前复权源整段覆盖；仅当联网同样断层才剔除该标的。
        offBad = true; offHit = null;
      } else if (offHit.end >= IX_END) {
        stats.src.off++;
        if (offRows.length) saveCache(code, offRows);
        return offRows;
      } else {
        stats.src.off++;
        for (var i1 = 0; i1 < offRows.length; i1++) acc[offRows[i1][0]] = offRows[i1];
      }
    }
    if (offBad) { try { localStorage.removeItem(CACHE_PFX + code); } catch (e) {} }
    // 本地未解决（既无 L0 缓存也无 L1.5 内置库命中）才探测 L1 jsdelivr；这样 A 池/C 池 130 子集内完全不碰网络
    if (!L1.checked) await checkL1();

    var fromISO = cac && cac.rows.length ? isoOf(dayAfter(cac.rows[cac.rows.length - 1][0])) :
                  offHit ? isoOf(dayAfter(offHit.end)) : '2021-09-01';
    var got = false;

    // L1 CDN（兜底备用；国内常 404/超时，2.6s 静默失败）
    if (!got && L1.on && !cac && !offHit) {
      try { mergeRows(acc, await fetchCdn(code)); got = true; stats.src.cdn++; } catch (e) {}
    }
    // L2 东财（fqt=1 前复权）
    if (!got) {
      try { mergeRows(acc, await fetchEastmoney(code, fromISO)); got = true; stats.src.em++; } catch (e) {}
    }
    // L3 腾讯（fqkline qfq 前复权）
    if (!got) {
      try { mergeRows(acc, await fetchTencent(code, fromISO)); got = true; stats.src.tx++; } catch (e) {}
    }
    // L4 新浪（JSONP，裸价不复权 —— 仅当前复权源全部不可达时兜底，随后由复权守卫拦截断层）
    if (!got) {
      try { mergeRows(acc, await fetchSina(code)); got = true; stats.src.sina++; } catch (e) {}
    }
    var rows = Object.keys(acc).map(Number).sort(function (a, b) { return a - b; })
      .map(function (d) { return acc[d]; });
    if (!got && !cac && !offHit) throw new Error('fetch fail ' + code);
    // 复权守卫：宁可把该标的剔出本局（上层会 toast 提示），也绝不让拆分/送转断层冒充真实暴跌
    var art = artifactAt(rows, thr);
    if (art) {
      try { localStorage.removeItem(CACHE_PFX + code); } catch (e) {}   // 清掉坏缓存，避免下局反复踩雷
      throw new Error('fq-artifact@' + art.d + ' ' + code);
    }
    // 兜底：无任何网络源但已有缓存/离线库（可能不完整，交给上层校验是否覆盖游戏区间）
    if (rows.length) saveCache(code, rows);
    return rows;
  }

  // 并发拉取若干标的（concurrency 默认 6），每完成一只回调 onOne(done,total,code,err)
  async function fetchMany(codes, concurrency, onOne) {
    concurrency = concurrency || 6;
    var out = {};
    var q = codes.slice();
    var done = 0, total = q.length;
    async function worker() {
      while (q.length) {
        var code = q.shift();
        try {
          out[code] = await fetchKLine(code);
          onOne && onOne(++done, total, code, null);
        } catch (e) {
          onOne && onOne(++done, total, code, e);
        }
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(concurrency, codes.length); i++) workers.push(worker());
    await Promise.all(workers);
    try {
      var s = stats.src;
      console.info('[fetchMany] done:', codes.length, '只 | 命中 cache=' + s.cache, '内置库=' + s.off, 'CDN=' + s.cdn, '东财=' + s.em, '腾讯=' + s.tx, '新浪=' + s.sina);
    } catch (e) {}
    return out;
  }

  // ---------------- 筹码峰：CYQ 近似合成（沿用 v1，仅相对量能，与绝对量单位无关） ----------------
  function synthChips(st, binsN) {
    binsN = binsN || 60;
    var d = st.d, o = st.o, h = st.h, l = st.l, c = st.c, v = st.v;
    var n = d.length;
    if (n < 20) return null;
    var pmin = Infinity, pmax = -Infinity;
    for (var i = 0; i < n; i++) {
      if (l[i] < pmin) pmin = l[i];
      if (h[i] > pmax) pmax = h[i];
    }
    if (!(pmax > pmin)) { pmax = pmin * 1.04 + 0.01; pmin = pmin * 0.96 - 0.01; }
    var bins = [], bw = (pmax - pmin) / binsN;
    for (var b2 = 0; b2 < binsN; b2++) bins.push(pmin + (b2 + 0.5) * bw);
    var sumV = 0;
    for (var q0 = 0; q0 < n; q0++) sumV += v[q0];
    var avgV = sumV / n || 1;
    var active = new Array(binsN).fill(0);
    var frames = {};
    var idxOf = function (p) { return Math.min(binsN - 1, Math.max(0, Math.floor((p - pmin) / bw))); };
    for (var t = 0; t < n; t++) {
      var turn = Math.max(0.02, Math.min(0.5, v[t] / avgV * 0.35));
      var decay = 1 - turn;
      for (var jj = 0; jj < binsN; jj++) active[jj] *= decay;
      var lo = l[t], hi = h[t], md = c[t];
      if (hi <= lo) hi = lo + 0.01;
      var i0 = idxOf(lo), i1 = idxOf(hi);
      var wsum = 0, wg = new Array(i1 - i0 + 1);
      for (var kk = i0; kk <= i1; kk++) {
        var p = bins[kk];
        var w;
        if (p <= md) w = (md > lo) ? (p - lo) / (md - lo) : 1;
        else w = (hi > md) ? (hi - p) / (hi - md) : 1;
        if (w < 0) w = 0;
        if (i1 === i0) w = 1;
        wg[kk - i0] = w;
        wsum += w;
      }
      if (wsum <= 0) { wg.fill(1); wsum = wg.length; }
      for (var u = i0; u <= i1; u++) active[u] += turn * wg[u - i0] / wsum;
      if (t % 5 === 0) frames[String(d[t])] = active.slice();
    }
    if (!frames[String(d[n - 1])]) frames[String(d[n - 1])] = active.slice();
    return { bins: bins, frames: frames };
  }

  g.Online = {
    init: function (idxEnd) {
      IX_END = idxEnd;
      IX_END_ISO = isoOf(idxEnd);
    },
    pfx: pfx,
    fetchKLine: fetchKLine,
    fetchMany: fetchMany,
    synthChips: synthChips,
    stats: stats,
    _cache: { clear: function () {
      try {
        var order = JSON.parse(localStorage.getItem(CACHE_PFX + '_o') || '[]');
        for (var i = 0; i < order.length; i++) localStorage.removeItem(CACHE_PFX + order[i]);
        localStorage.removeItem(CACHE_PFX + '_o');
      } catch (e) {}
    } }
  };
})(window);
