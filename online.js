/* online.js — 在线版数据加载器
 * 从腾讯行情接口(web.ifzq.gtimg.cn)实时拉取个股/ETF 前复权日K，
 * 并在本地按 CYQ 近似算法合成筹码分布帧。
 * 依赖: window.GAME_INDEX（提供全局交易日轴与区间终点）
 */
(function (g) {
  'use strict';
  var IX_END = null;   // 由 init() 传入（对齐全局交易日轴最后日期）

  // 分窗拉取：gtimg 单次最多返回约 640 根，按 ~2 年一段拆分（各段 <600 根）
  function windows() {
    var y = String(IX_END).slice(0, 4), m = String(IX_END).slice(4, 6), dd = String(IX_END).slice(6, 8);
    var endISO = y + '-' + m + '-' + dd;
    return [
      ['2021-09-01', '2023-08-31'],
      ['2023-09-01', '2025-08-29'],
      ['2025-09-01', endISO]
    ];
  }
  function pfx(code) { return (code[0] === '5' || code[0] === '6') ? 'sh' : 'sz'; }

  // 拉单窗；失败重试 retry 次（指数退避）
  async function fetchWin(full, start, end, retry) {
    retry = retry == null ? 2 : retry;
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
      full + ',day,' + start + ',' + end + ',640,qfq';
    var lastErr = null;
    for (var t = 0; t <= retry; t++) {
      try {
        var resp = await fetch(url, { method: 'GET', cache: 'no-store' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var j = await resp.json();
        var node = j && j.data && j.data[full];
        if (!node || typeof node !== 'object') throw new Error('bad node');
        var arr = node.qfqday || node.day || [];
        return arr;
      } catch (e) {
        lastErr = e;
        await new Promise(function (r) { setTimeout(r, 600 * (t + 1)); });
      }
    }
    throw lastErr || new Error('fetch fail ' + full);
  }

  // 拉一只完整K线：返回 [ [yyyymmdd, open, close, high, low, vol], ... ]（升序、按日去重）
  async function fetchKLine(code) {
    var full = pfx(code) + code;
    var merged = {};
    var w = windows();
    for (var k = 0; k < w.length; k++) {
      var rows = await fetchWin(full, w[k][0], w[k][1]);
      for (var i = 0; i < rows.length; i++) {
        var b = rows[i];
        var dt = parseInt(b[0].replace(/-/g, ''), 10);
        if (dt > IX_END) continue;             // 丢弃超出全局交易日轴的部分
        if (!merged[dt]) merged[dt] = [dt, +b[1], +b[2], +b[3], +b[4], +b[5]];
      }
    }
    var dates = Object.keys(merged).map(Number).sort(function (a, b) { return a - b; });
    return dates.map(function (d) { return merged[d]; });
  }

  // 并发拉取若干标的（concurrency 默认 4），每完成一只回调 onOne(done,total,code,err)
  async function fetchMany(codes, concurrency, onOne) {
    concurrency = concurrency || 4;
    var out = {};         // code -> rows
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
    return out;
  }

  // ---------------- 筹码峰：CYQ 近似合成 ----------------
  // bins：全历史 [最低,最高] 取 60 档；逐日：老筹码按估换手衰减，当日成交量
  // 以"低-高"三角分布（峰值贴近收盘价）沉淀到价格档；每 5 个交易日存一帧。
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

    // 参考均量（用整体均量近似，避免前导窗口波动）
    var sumV = 0;
    for (var q0 = 0; q0 < n; q0++) sumV += v[q0];
    var avgV = sumV / n || 1;

    var active = new Array(binsN).fill(0);
    var frames = {};
    var idxOf = function (p) { return Math.min(binsN - 1, Math.max(0, Math.floor((p - pmin) / bw))); };
    for (var t = 0; t < n; t++) {
      // 估换手：量能相对均量的折中（2%~50%）
      var turn = Math.max(0.02, Math.min(0.5, v[t] / avgV * 0.35));
      var decay = 1 - turn;
      for (var jj = 0; jj < binsN; jj++) active[jj] *= decay;
      // 当日新增筹码：三角分布，顶点在收盘价；区间 [low, high]
      var lo = l[t], hi = h[t], md = c[t];
      if (hi <= lo) hi = lo + 0.01;
      var i0 = idxOf(lo), i1 = idxOf(hi);
      // 权重累计（三角），wsum 归一
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
    // 保证最后一根也有帧（若 n%5 非0）
    if (!frames[String(d[n - 1])]) frames[String(d[n - 1])] = active.slice();
    return { bins: bins, frames: frames };
  }

  g.Online = {
    init: function (idxEnd) { IX_END = idxEnd; },
    pfx: pfx,
    fetchKLine: fetchKLine,
    fetchMany: fetchMany,
    synthChips: synthChips
  };
})(window);
