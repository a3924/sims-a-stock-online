/* chart.js — K线/指标/筹码峰绘制引擎（Canvas 2D，暗色主题）
 * 依赖: window.GAME_KLINE / window.GAME_CHIPS
 */
(function (global) {
  'use strict';

  // ---------- 指标计算 ----------
  function sma(arr, n) {
    var out = new Array(arr.length).fill(null), sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  // 前导 null 之后的简单移动平均：arr 从索引 from 起连续有效，计算 m 期均线
  function smaAfter(arr, from, m) {
    var out = new Array(arr.length).fill(null), sum = 0;
    for (var i = from; i < arr.length; i++) {
      sum += arr[i];
      if (i - from >= m) sum -= arr[i - m];
      if (i - from >= m - 1) out[i] = sum / m;
    }
    return out;
  }
  function ema(arr, n) {
    var out = new Array(arr.length).fill(null), k = 2 / (n + 1), prev = null;
    for (var i = 0; i < arr.length; i++) {
      if (i < n - 1) continue;
      if (prev === null) { prev = arr[i]; } else { prev = arr[i] * k + prev * (1 - k); }
      out[i] = prev;
    }
    return out;
  }
  function macd(close, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    var ef = ema(close, fast), es = ema(close, slow);
    var dif = close.map(function (_, i) { return (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]; });
    var valid = dif.filter(function (x) { return x != null; });
    var deaRaw = ema(valid, sig);
    var dea = new Array(close.length).fill(null), j = 0;
    for (var i = 0; i < close.length; i++) {
      if (dif[i] == null) { dea[i] = null; continue; }
      dea[i] = deaRaw[j++];
    }
    var bar = close.map(function (_, i) { return (dif[i] == null || dea[i] == null) ? null : (dif[i] - dea[i]) * 2; });
    return { dif: dif, dea: dea, bar: bar };
  }
  function kdj(high, low, close, n, m1, m2) {
    n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
    var k = new Array(close.length).fill(null),
        d = new Array(close.length).fill(null),
        j = new Array(close.length).fill(null);
    var pk = 50, pd = 50;
    for (var i = 0; i < close.length; i++) {
      if (i < n - 1) continue;
      var hh = -Infinity, ll = Infinity;
      for (var q = i - n + 1; q <= i; q++) { if (high[q] > hh) hh = high[q]; if (low[q] < ll) ll = low[q]; }
      var rsv = (hh === ll) ? 50 : (close[i] - ll) / (hh - ll) * 100;
      pk = (m1 - 1) / m1 * pk + 1 / m1 * rsv;
      pd = (m2 - 1) / m2 * pd + 1 / m2 * pk;
      k[i] = pk; d[i] = pd; j[i] = 3 * pk - 2 * pd;
    }
    return { k: k, d: d, j: j };
  }
  function boll(close, n, k) {
    n = n || 20; k = k || 2;
    var mid = sma(close, n), up = new Array(close.length).fill(null), dn = new Array(close.length).fill(null);
    for (var i = 0; i < close.length; i++) {
      if (mid[i] == null) continue;
      var s = 0;
      for (var q = i - n + 1; q <= i; q++) s += Math.pow(close[q] - mid[i], 2);
      var sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd; dn[i] = mid[i] - k * sd;
    }
    return { mid: mid, up: up, dn: dn };
  }
  // ---- 同花顺常见副图指标计算 ----
  function meanOf(a, f, t) {
    var s = 0;
    for (var i = f; i <= t; i++) s += a[i];
    return s / (t - f + 1);
  }
  // RSI(N) Wilder 平滑
  function rsi(close, n) {
    var out = new Array(close.length).fill(null), ag = 0, al = 0;
    for (var i = 1; i < close.length; i++) {
      var ch = close[i] - close[i - 1];
      var g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      if (i < n) { ag += g; al += l; continue; }
      if (i === n) { ag /= n; al /= n; }
      else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; }
      if (al <= 0) al = 1e-9;
      out[i] = 100 - 100 / (1 + ag / al);
    }
    return out;
  }
  // CCI(N)：顺势指标
  function cci(h, l, c, n) {
    var out = new Array(c.length).fill(null);
    for (var i = n - 1; i < c.length; i++) {
      var tp = (h[i] + l[i] + c[i]) / 3, s = 0, s2 = 0;
      for (var q = i - n + 1; q <= i; q++) s += (h[q] + l[q] + c[q]) / 3;
      var ma = s / n;
      for (var q2 = i - n + 1; q2 <= i; q2++) s2 += Math.abs((h[q2] + l[q2] + c[q2]) / 3 - ma);
      var md = s2 / n;
      out[i] = md > 0 ? (tp - ma) / (0.015 * md) : 0;
    }
    return out;
  }
  // 威廉指标 WR(N)：越高越超卖
  function wr(h, l, c, n) {
    var out = new Array(c.length).fill(null);
    for (var i = n - 1; i < c.length; i++) {
      var hh = -Infinity, ll = Infinity;
      for (var q = i - n + 1; q <= i; q++) { if (h[q] > hh) hh = h[q]; if (l[q] < ll) ll = l[q]; }
      out[i] = hh === ll ? 50 : (hh - c[i]) / (hh - ll) * 100;
    }
    return out;
  }
  // 乖离率 BIAS(N)
  function bias(c, n) {
    var m = sma(c, n), out = new Array(c.length).fill(null);
    for (var i = 0; i < c.length; i++) if (m[i] != null && m[i] !== 0) out[i] = (c[i] - m[i]) / m[i] * 100;
    return out;
  }
  // 能量潮 OBV(+MA)
  function obv(c, v, n) {
    var o = new Array(c.length).fill(0);
    for (var i = 1; i < c.length; i++) {
      if (c[i] > c[i - 1]) o[i] = o[i - 1] + v[i];
      else if (c[i] < c[i - 1]) o[i] = o[i - 1] - v[i];
      else o[i] = o[i - 1];
    }
    return { obv: o, ma: sma(o, n || 30) };
  }
  // 趋向指标 DMI(N)
  function dmi(h, l, c, n) {
    n = n || 14;
    var pdm = new Array(c.length).fill(0), mdm = new Array(c.length).fill(0), tr = new Array(c.length).fill(0);
    for (var i = 1; i < c.length; i++) {
      var up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      if (up > dn && up > 0) pdm[i] = up;
      if (dn > up && dn > 0) mdm[i] = dn;
      tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    }
    var pdi = new Array(c.length).fill(null), mdi = new Array(c.length).fill(null), dx = new Array(c.length).fill(null);
    for (var i = n - 1; i < c.length; i++) {
      var sp = 0, sm = 0, st = 0;
      for (var q = i - n + 1; q <= i; q++) { sp += pdm[q]; sm += mdm[q]; st += tr[q]; }
      if (st <= 0) continue;
      pdi[i] = 100 * sp / st; mdi[i] = 100 * sm / st;
      dx[i] = (pdi[i] + mdi[i]) > 0 ? 100 * Math.abs(pdi[i] - mdi[i]) / (pdi[i] + mdi[i]) : 0;
    }
    var adx = new Array(c.length).fill(null);
    for (var i = 2 * n - 2; i < c.length; i++) adx[i] = meanOf(dx, i - n + 1, i);
    var adxr = new Array(c.length).fill(null);
    for (var i = 2 * n - 2; i < c.length; i++) if (i >= n && adx[i - n] != null) adxr[i] = (adx[i] + adx[i - n]) / 2;
    return { pdi: pdi, mdi: mdi, adx: adx, adxr: adxr };
  }
  // 平均真实波幅 ATR(N)
  function atr(h, l, c, n) {
    n = n || 14;
    var tr = new Array(c.length).fill(0), out = new Array(c.length).fill(null);
    for (var i = 1; i < c.length; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    for (var i = n; i < c.length; i++) out[i] = meanOf(tr, i - n + 1, i);
    return out;
  }
  // ROC(N,M)：变动率
  function roc(c, n, m) {
    n = n || 12; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) if (c[i - n] !== 0) r[i] = (c[i] - c[i - n]) / c[i - n] * 100;
    return { roc: r, ma: smaAfter(r, n, m) };
  }
  // MTM(N,M)：动量线
  function mtm(c, n, m) {
    n = n || 12; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) r[i] = c[i] - c[i - n];
    return { mtm: r, ma: smaAfter(r, n, m) };
  }
  // VR(N,M)：成交量变异率
  function vr(c, v, n, m) {
    n = n || 26; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) {
      var a = 0, b = 0, cc = 0;
      for (var q = i - n + 1; q <= i; q++) {
        if (c[q] > c[q - 1]) a += v[q];
        else if (c[q] < c[q - 1]) cc += v[q];
        else b += v[q];
      }
      var den = cc + b / 2;
      r[i] = den > 0 ? (a + b / 2) / den * 100 : 100;
    }
    return { vr: r, ma: smaAfter(r, n, m) };
  }
  // PSY(N,M)：心理线
  function psy(c, n, m) {
    n = n || 12; m = m || 6;
    var r = new Array(c.length).fill(null);
    for (var i = n; i < c.length; i++) {
      var up = 0;
      for (var q = i - n + 1; q <= i; q++) if (c[q] > c[q - 1]) up++;
      r[i] = up / n * 100;
    }
    return { psy: r, ma: smaAfter(r, n, m) };
  }

  // ---------- 主题 ----------
  // r34 TradingView 改版：双主题画布配色。夜间=默认；白天用浅色面板 + 用户指定红涨绿跌。
  // 涨跌语义：红涨绿跌（A股习惯）。深/浅色底统一用可读红 #E5484D，跌绿 #22AB94。
  var THEMES = {
    dark: {
      bg: '#131313', panel: '#131313', grid: '#262626', line: '#2A2A2A',
      text: '#8A8A8A', textHi: '#E0E0E0', dimLow: '#6E6E6E', cross: '#5A5F66', ref: '#4B5563',
      up: '#E5484D', dn: '#089981', upFill: '#E5484D', dnFill: '#089981',
      ma5: '#D8AE4E', ma10: '#6E8FCC', ma20: '#A987C9', ma60: '#C88AA8',
      boll: '#8B93A0',
      dif: '#D8AE4E', dea: '#6E8FCC', kc: '#D8AE4E', dc: '#6E8FCC', jc: '#C88AA8',
      rsi6: '#D8AE4E', rsi12: '#6E8FCC', rsi24: '#A987C9',
      cci: '#D8AE4E', wr1: '#D8AE4E', wr2: '#C88AA8',
      bias6: '#D8AE4E', bias12: '#6E8FCC', bias24: '#A987C9',
      obv: '#D8AE4E', obvma: '#6E8FCC',
      pdi: '#D8AE4E', mdi: '#6E8FCC', adx: '#A987C9', adxr: '#C88AA8',
      atr: '#D8AE4E', roc: '#D8AE4E', rocma: '#6E8FCC',
      mtm: '#D8AE4E', mtmma: '#6E8FCC', vr: '#D8AE4E', vrma: '#A987C9',
      psy: '#D8AE4E', psyma: '#6E8FCC',
      crowd: '#4FA8B8',
      volUp: '#E5484D', volDn: '#089981',
      pxTag: '#E0E0E0', pxTagBg: '#1E1E1E', pxTagBd: '#3A3A3A',
      mkBuy: '#E5484D', mkSell: '#0E9C6E',
      limUp: '#FFC233', limDn: '#B985FF',   // r35 涨停黄/跌停紫描边（夜间亮版）
      padBg: 'rgba(15,15,15,.86)', panelBg: 'rgba(30,30,30,.96)'
    },
    light: {
      bg: '#FFFFFF', panel: '#FFFFFF', grid: '#EAEAEA', line: '#E0E0E0',
      text: '#707070', textHi: '#202020', dimLow: '#9AA0A6', cross: '#9AA0A6', ref: '#C9CDD3',
      up: '#E5484D', dn: '#22AB94', upFill: '#E5484D', dnFill: '#22AB94',
      ma5: '#B8860B', ma10: '#3D5FA8', ma20: '#6F54A8', ma60: '#A64D79',
      boll: '#7A8699',
      dif: '#B8860B', dea: '#3D5FA8', kc: '#B8860B', dc: '#3D5FA8', jc: '#A64D79',
      rsi6: '#B8860B', rsi12: '#3D5FA8', rsi24: '#6F54A8',
      cci: '#B8860B', wr1: '#B8860B', wr2: '#A64D79',
      bias6: '#B8860B', bias12: '#3D5FA8', bias24: '#6F54A8',
      obv: '#B8860B', obvma: '#3D5FA8',
      pdi: '#B8860B', mdi: '#3D5FA8', adx: '#6F54A8', adxr: '#A64D79',
      atr: '#B8860B', roc: '#B8860B', rocma: '#3D5FA8',
      mtm: '#B8860B', mtmma: '#3D5FA8', vr: '#B8860B', vrma: '#6F54A8',
      psy: '#B8860B', psyma: '#3D5FA8',
      crowd: '#2E8E8E',
      volUp: '#E5484D', volDn: '#22AB94',
      pxTag: '#202020', pxTagBg: '#F5F5F5', pxTagBd: '#D9D9D9',
      mkBuy: '#E5484D', mkSell: '#089981',
      limUp: '#E39A00', limDn: '#8E44AD',   // r35 涨停黄/跌停紫描边（白天加深版）
      padBg: 'rgba(255,255,255,.9)', panelBg: 'rgba(255,255,255,.97)'
    }
  };
  var T = {};
  function setTheme(name) {
    var s = THEMES[name] || THEMES.dark;
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) T[k] = s[k];
  }
  setTheme('dark');   // 默认夜间；app.js 启动时按记忆值再次 setTheme

  function fmt(n, dec) {
    if (n == null || isNaN(n)) return '--';
    return Number(n).toFixed(dec == null ? 2 : dec);
  }
  function fmtVol(v) {
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v));
  }

  // ---------- r35 涨跌停/上市标注工具 ----------
  function hexCol(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) n = 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function colA(hex, a) {
    var c = hexCol(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  // 涨跌停判定：当日收盘精确等于 round(前收 × (1±限幅)) 视为封板/封跌停。
  // 前复权序列在除权日附近可能有 <0.1% 的微差，故两侧都按 2 位小数归整后比较（ratio 由调用方按板块给出）。
  function limitDir(d, i, ratio) {
    if (!ratio || i <= 0) return null;
    var pc = d.c[i - 1], c = d.c[i];
    if (!(pc > 0) || c == null || !(c > 0)) return null;
    var rc = Math.round(c * 100) / 100;
    var ru = Math.round(pc * (1 + ratio) * 100) / 100;
    if (rc === ru) return 'up';
    var rd = Math.round(pc * (1 - ratio) * 100) / 100;
    if (rd > 0 && rc === rd) return 'dn';
    return null;
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- K线图 ----------
  function KChart(canvas, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = Object.assign({ subs: ['vol', 'macd', 'kdj'], showBoll: true, showMa: true }, opts || {});
    this.data = null;
    this.endIdx = 0;
    this.maxIdx = 0;       // 可见上界（防未来函数）：只渲染 <= 当前游戏日的数据
    this.resetBars = this.opts.resetBars || 120;   // 双击/复位时的默认条数（手机版 50，桌面 100）
    this.viewBars = this.resetBars;
    this.cross = null;      // {x, y}
    this.hoverIdx = -1;
    this.padL = 8; this.padR = 62; this.padT = 18; this.padB = 20;
    this._bind();
  }

  KChart.prototype._fireView = function () {
    if (this.opts.onView) this.opts.onView(this.viewBars, this.data ? this.data.d[this.endIdx] : null);
  };
  KChart.prototype._bind = function () {
    // 游戏内图表始终以「当前游戏日」为最右端（最右永远=今日），不做拖动平移，仅保留滚轮缩放与双击复位
    var self = this;
    this.cv.addEventListener('mousemove', function (e) {
      var r = self.cv.getBoundingClientRect();
      self.cross = { x: e.clientX - r.left, y: e.clientY - r.top };
      self.draw();
    });
    this.cv.addEventListener('mouseleave', function () { self.cross = null; self.draw(); });
    // 触屏：单击钉住十字光标信息框 2.6s（手指放开后仍有小框可看日期/涨跌幅/开高低收），再次点击可刷新位置
    var tapClear = null;
    this.cv.addEventListener('click', function (e) {
      if (!('ontouchstart' in window)) return;   // 纯鼠标设备走 hover，不钉住
      var r = self.cv.getBoundingClientRect();
      self.cross = { x: e.clientX - r.left, y: e.clientY - r.top };
      self.draw();
      if (tapClear) clearTimeout(tapClear);
      tapClear = setTimeout(function () { self.cross = null; self.draw(); }, 2600);
    });
    this.cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.viewBars = Math.max(10, Math.min(500, Math.round(self.viewBars * (e.deltaY > 0 ? 1.12 : 0.89))));
      self._fireView(); self.draw();
    }, { passive: false });
    this.cv.addEventListener('dblclick', function () { self.viewBars = self.resetBars; self._fireView(); self.draw(); });
    // 触屏：双指捏合缩放等效滚轮；单指拖动不拦截（页面滚动）
    var tPinch = null;
    this.cv.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        tPinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    this.cv.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && tPinch) {
        var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (Math.abs(d - tPinch) > 14) {
          e.preventDefault();
          self.viewBars = Math.max(10, Math.min(500, Math.round(self.viewBars * (d > tPinch ? 0.89 : 1.12))));
          self._fireView(); self.draw();
          tPinch = d;
        }
      }
    }, { passive: false });
    this.cv.addEventListener('touchend', function () { tPinch = null; }, { passive: true });
  };

  KChart.prototype._plotW = function () { return (this.cssW != null ? this.cssW : this.cv.width / (window.devicePixelRatio || 1)) - this.padL - this.padR; };
  KChart.prototype._maxIdx = function () { return this.data ? this.data.c.length - 1 : 0; };

  KChart.prototype.setData = function (stock, endIdx) {
    this.data = stock;
    this.endIdx = endIdx != null ? endIdx : stock.c.length - 1;
    this.maxIdx = this.endIdx;   // 当前游戏日即为可见上界，禁止滑向未来
    this.draw();
  };
  KChart.prototype.setEndIdx = function (i) { this.endIdx = i; this.draw(); };

  // r35 涨停/跌停描边渐变：描边贴蜡烛边缘，涨/跌停各自最强端（上端/下端）渐隐到 2/5 处消失
  // yHi/yLo = 蜡烛最高/最低（影线端点）像素 y；yo/yc = 开收像素 y
  KChart.prototype._drawLimit = function (cx, cw, yHi, yLo, yo, yc, dir) {
    var ctx = this.ctx, col = (dir === 'up') ? T.limUp : T.limDn;
    var top = Math.min(yo, yc), bot = Math.max(yo, yc);
    var bodyH = Math.max(1, bot - top);
    var lw = Math.min(2, Math.max(1.1, cw * 0.22));       // 线宽随蜡烛粗细，窄K也清晰
    var bx = cx - cw / 2 + lw / 2, by = top + lw / 2;
    var bw = Math.max(1, cw - lw), bh = Math.max(1, bodyH - lw);
    var span = yLo - yHi;                                  // 影线总高（像素）
    if (span < 1) {                                        // 一字板等极扁蜡烛：整根淡描边
      ctx.strokeStyle = colA(col, 0.72); ctx.lineWidth = lw;
      ctx.strokeRect(bx, by, bw, bh);
      return;
    }
    var g;
    if (dir === 'up') {
      // 涨停：上 2/5 从无到有 —— 蜡烛顶端最强，向下 2/5 处完全淡出（贴蜡烛上面）
      var gB = yHi + span * 0.4;
      g = ctx.createLinearGradient(0, yHi, 0, Math.max(yHi + 1, gB));
      g.addColorStop(0, colA(col, 0.95));
      g.addColorStop(1, colA(col, 0));
    } else {
      // 跌停：下 2/5 从无到有 —— 蜡烛底端最强，向上 2/5 处完全淡出（贴蜡烛下面）
      var gA = yLo - span * 0.4;
      g = ctx.createLinearGradient(0, Math.min(yLo - 1, gA), 0, yLo);
      g.addColorStop(0, colA(col, 0));
      g.addColorStop(1, colA(col, 0.95));
    }
    ctx.strokeStyle = g; ctx.lineWidth = lw;
    ctx.strokeRect(bx, by, bw, bh);
    // 强端（涨停上沿 / 跌停下沿）补一道等高纯色描边，呼应"贴蜡烛上面/下面"
    var capLw = Math.max(2.2, cw * 0.22);
    ctx.strokeStyle = col; ctx.lineWidth = capLw;
    ctx.beginPath();
    if (dir === 'up') {
      ctx.moveTo(bx, by + capLw/2 - 0.5); ctx.lineTo(bx + bw, by + capLw/2 - 0.5);
    } else {
      ctx.moveTo(bx, by + bh - capLw/2 + 0.5); ctx.lineTo(bx + bw, by + bh - capLw/2 + 0.5);
    }
    ctx.stroke();
  };

  // r35 「上市」小标签：绘在序列首根K线（近期上市股）上方
  KChart.prototype._drawIpoTag = function (x0, pw, mainTop, mainBot, px, py, i) {
    var ctx = this.ctx, d = this.data;
    if (!d || !d.h || i == null || d.h[i] == null) return;
    var lab = '上市', fSize = 9;
    ctx.font = 'bold ' + fSize + 'px "Roboto Mono","PingFang SC","Microsoft YaHei",monospace';
    var tw = ctx.measureText(lab).width;
    var tagW = tw + 8, tagH = 14;
    var fx = px(i);
    var tx = Math.max(x0 + 1, Math.min(fx - tagW / 2, x0 + pw - tagW - 1));
    var ty = py(d.h[i]) - tagH - 3;
    ty = Math.max(mainTop + 2, Math.min(ty, mainBot - tagH - 2));
    ctx.fillStyle = '#E8A33D';                       // 琥珀底，昼夜通用
    rr(ctx, tx, ty, tagW, tagH, 7);
    ctx.fill();
    ctx.fillStyle = '#161616';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(lab, tx + tagW / 2, ty + tagH / 2 + 0.5);
    ctx.textBaseline = 'alphabetic';
  };

  KChart.prototype.resize = function (w, h) {
    var dpr = window.devicePixelRatio || 1;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w; this.cssH = h;
    // 右侧价格标签预留随画布宽度自适应，避免手机/多图窄卡右侧大片空白
    if (w <= 340) { this.padL = 6; this.padR = 34; this.padB = 16; }
    else if (w <= 520) { this.padL = 8; this.padR = 46; this.padB = 18; }
    else { this.padL = 8; this.padR = 62; this.padB = 20; }
    this.compact = w <= 520;   // 窄画布：每个副图窗口固定高度，不随副图数量互相挤压
    this.draw();
  };

  KChart.prototype.draw = function () {
    var ctx = this.ctx, d = this.data, W = this.cssW || this.cv.width, H = this.cssH || this.cv.height;
    if (!d) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);

    var nSub = this.opts.subs.length;
    var totalH = H - this.padT - this.padB;
    // 主图与副图高度分配：
    // - 窄画布（手机/小卡）：每个副图窗口固定 ≈52px，主图高度独立不随副图数量被压缩
    //   （画布总高已由调用方按“半屏主图 + n×副图”给出）
    // - 宽画布（桌面）：按比例收缩（副图越多主图让出越多，但主图始终 ≥50%）
    var mainH, subH;
    if (this.compact) {
      subH = 52;
      var subTotal = nSub ? (nSub * (subH + 4) - 4) : 0;
      mainH = Math.max(120, totalH - subTotal);
    } else {
      var mainR = nSub === 0 ? 1 : nSub <= 2 ? 0.66 : nSub <= 4 ? 0.58 : 0.5;
      mainH = Math.round(totalH * mainR);
      subH = nSub ? Math.max(24, Math.round((totalH - mainH - 4 * (nSub - 1)) / nSub)) : 0;
    }
    var pw = this._plotW();

    var start = Math.max(0, this.endIdx - this.viewBars + 1);
    var end = Math.min(this.maxIdx, this.endIdx);
    var cnt = end - start + 1;
    if (cnt <= 1) return;

    // 价格范围
    var hi = -Infinity, lo = Infinity;
    for (var i = start; i <= end; i++) {
      if (d.h[i] > hi) hi = d.h[i];
      if (d.l[i] < lo) lo = d.l[i];
    }
    var maP = subParams('ma');                 // 主图均线周期（可长按「均线」改，持久化）
    if (!maP.length) maP = [5, 10, 20, 60];
    if (maP.length < 4) maP = maP.concat([5, 10, 20, 60]).slice(0, 4);
    var maPs = maP.slice(0, 4);
    var maC = [T.ma5, T.ma10, T.ma20, T.ma60];
    var maArr = maPs.map(function (n) { return sma(d.c, n); });
    var bollP = subParams('boll');            // 布林带参数（可长按「布林带」改，持久化）
    var blN = (bollP[0] && bollP[0] >= 2) ? bollP[0] : 20;
    var blK = (bollP[1] && bollP[1] >= 1) ? bollP[1] : 2;
    var bl = this.opts.showBoll ? boll(d.c, blN, blK) : null;
    if (this.opts.showMa) maArr.forEach(function (m) {
      for (var i = start; i <= end; i++) if (m[i] != null) { if (m[i] > hi) hi = m[i]; if (m[i] < lo) lo = m[i]; }
    });
    if (bl) for (var i = start; i <= end; i++) {
      if (bl.up[i] != null) { if (bl.up[i] > hi) hi = bl.up[i]; if (bl.dn[i] < lo) lo = bl.dn[i]; }
    }
    var padY = (hi - lo) * 0.06; hi += padY; lo -= padY;

    var mainTop = this.padT, mainBot = this.padT + mainH;
    // 记录当前价格轴（供筹码峰对齐使用）
    this._lo = lo; this._hi = hi; this._priceTop = mainTop; this._priceBot = mainBot;
    var x0 = this.padL, bw = pw / cnt, cw = Math.max(1, bw * 0.68);
    var py = function (p) { return mainBot - (p - lo) / (hi - lo) * mainH; };
    var px = function (i) { return x0 + (i - start) * bw + bw / 2; };

    // 网格 + 价格轴
    ctx.font = '11px "Roboto Mono",ui-monospace,Consolas,monospace';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.fillStyle = T.text; ctx.textAlign = 'left';
    for (var g = 0; g <= 4; g++) {
      var yy = mainTop + mainH * g / 4, pv = hi - (hi - lo) * g / 4;
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + pw, yy); ctx.stroke();
      ctx.fillText(fmt(pv), x0 + pw + 5, yy);
    }

    // 蜡烛
    for (var i = start; i <= end; i++) {
      var up = d.c[i] >= d.o[i], col = up ? T.up : T.dn;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      var cx = px(i);
      ctx.beginPath(); ctx.moveTo(cx, py(d.h[i])); ctx.lineTo(cx, py(d.l[i])); ctx.stroke();
      var yo = py(d.o[i]), yc = py(d.c[i]);
      var top = Math.min(yo, yc), hgt = Math.max(Math.abs(yc - yo), 1);
      ctx.fillRect(cx - cw / 2, top, cw, hgt);
      // r35 涨停（黄·贴蜡烛上面渐变）/ 跌停（紫·贴蜡烛下面渐变）描边
      var ld = limitDir(d, i, this.opts.limit);
      if (ld) this._drawLimit(cx, cw, py(d.h[i]), py(d.l[i]), yo, yc, ld);
    }

    // 玩家买卖点标注：B（买入，红）画在当日最低价下方；S（卖出，蓝）画在最高价上方（r18）
    var mk = this.opts.markers;
    if (mk && ((mk.B && mk.B.length) || (mk.S && mk.S.length))) {
      var iB = mk.B || [], iS = mk.S || [];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (var mi = start; mi <= end; mi++) {
        var hasB = iB.indexOf(mi) >= 0, hasS = iS.indexOf(mi) >= 0;
        if (!hasB && !hasS) continue;
        var mcx = px(mi);
        if (hasB) {
          var yB = Math.min(py(d.l[mi]) + 10, mainBot - 8);
          ctx.beginPath(); ctx.arc(mcx, yB, 7, 0, Math.PI * 2);
          ctx.fillStyle = T.mkBuy; ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 9px "Roboto Mono",ui-monospace,Consolas,monospace';
          ctx.fillText('B', mcx, yB);
        }
        if (hasS) {
          var yS = Math.max(py(d.h[mi]) - 10, mainTop + 8);
          ctx.beginPath(); ctx.arc(mcx, yS, 7, 0, Math.PI * 2);
          ctx.fillStyle = T.mkSell; ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 9px "Roboto Mono",ui-monospace,Consolas,monospace';
          ctx.fillText('S', mcx, yS);
        }
      }
    }

    // MA / BOLL
    var line = function (arr, color, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.setLineDash(dash || []);
      ctx.beginPath(); var started = false;
      for (var i = start; i <= end; i++) {
        if (arr[i] == null) continue;
        if (!started) { ctx.moveTo(px(i), py(arr[i])); started = true; }
        else ctx.lineTo(px(i), py(arr[i]));
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    if (this.opts.showMa) maArr.forEach(function (arr, q) { line(arr, maC[q]); });
    if (bl) { line(bl.up, T.boll, [3, 3]); line(bl.mid, T.boll, [3, 3]); line(bl.dn, T.boll, [3, 3]); }

    // 主图左下方：均线数值栏（M5/M10/M20/M60 两行），数值随十字光标位置变化；无光标=当前日
    if (this.opts.showMa && this.opts.maPad !== false) {
      var hIdx = this.endIdx;
      if (this.cross && this.cross.x >= x0 && this.cross.x <= x0 + pw) {
        hIdx = Math.round(start + (this.cross.x - x0 - bw / 2) / bw);
        hIdx = Math.max(start, Math.min(end, hIdx));
      }
      var cells = [];
      for (var qm = 0; qm < 4; qm++) {
        var maV = (maArr[qm] && maArr[qm][hIdx] != null) ? maArr[qm][hIdx] : null;
        ctx.font = 'bold 10px "Roboto Mono",ui-monospace,Consolas,monospace';
        var wL = ctx.measureText('M' + maPs[qm]).width;
        ctx.font = '10px "Roboto Mono",ui-monospace,Consolas,monospace';
        var wV = (maV == null) ? ctx.measureText('--').width : ctx.measureText(fmt(maV)).width;
        cells.push({ nm: 'M' + maPs[qm], v: maV, col: maC[qm], wL: wL, wV: wV, w: wL + 3 + wV });
      }
      var rowW = Math.max(cells[0].w + 8 + cells[1].w, cells[2].w + 8 + cells[3].w);
      var mBx = x0 + 4, mBy = mainBot - 32;   // 主图底部左上内缩，贴左下角
      ctx.fillStyle = T.padBg;
      ctx.fillRect(mBx - 3, mBy, rowW + 6, 29);
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.strokeRect(mBx - 3, mBy, rowW + 6, 29);
      var drawMCell = function (c, xx, yy) {
        ctx.font = 'bold 10px "Roboto Mono",ui-monospace,Consolas,monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = c.col; ctx.fillText(c.nm, xx, yy);
        ctx.font = '10px "Roboto Mono",ui-monospace,Consolas,monospace';
        ctx.fillStyle = (c.v == null) ? T.dimLow : T.textHi;
        ctx.fillText((c.v == null) ? '--' : fmt(c.v), xx + c.wL + 3, yy);
      };
      // 2+2 两行两列：第 1 行 M1/M2，第 2 行 M3/M4；第二格紧跟本行第一格右侧（修复 r22 竖排溢出）
      drawMCell(cells[0], mBx, mBy + 3);
      drawMCell(cells[1], mBx + cells[0].w + 8, mBy + 3);
      drawMCell(cells[2], mBx, mBy + 15);
      drawMCell(cells[3], mBx + cells[2].w + 8, mBy + 15);
    }

    // 日期轴（每隔若干根；右端=当前游戏日必标注，且右对齐贴右边界避免溢出被裁）
    ctx.fillStyle = T.text; ctx.textBaseline = 'top';
    var step = Math.max(1, Math.floor(cnt / 6));
    var first = start + ((end - start) % step);   // 让 end(当前日) 一定落在标注序列
    // 最左端那根 bar(start) 始终贴左边界标注，避免“第一根 K 线无角标/角标悬空在离边缘约 step 处”的错觉
    if (first !== start) { ctx.textAlign = 'left'; ctx.fillText(this._dateLabel(start), x0, H - this.padB + 3); }
    for (var i = first; i <= end; i += step) {
      if (i === end) { ctx.textAlign = 'right'; ctx.fillText(this._dateLabel(i), x0 + pw, H - this.padB + 3); }
      else { ctx.textAlign = 'center'; ctx.fillText(this._dateLabel(i), px(i), H - this.padB + 3); }
    }

    // 副图
    // r27：十字光标悬停所在 K 线索引（同花顺式——鼠标移到哪根 K 线，副图标题指标值就跟随显示哪根；无悬停 =-1 → 副图取最新/当前游戏日）
    var hovI = -1;
    if (this.cross && this.cross.x >= x0 && this.cross.x <= x0 + pw) {
      hovI = Math.round(start + (this.cross.x - x0 - bw / 2) / bw);
      hovI = Math.max(start, Math.min(end, hovI));
    }
    for (var s = 0; s < nSub; s++) {
      var st = mainBot + (s === 0 ? 6 : 0) + s * subH;
      this._drawSub(this.opts.subs[s], d, start, end, x0, pw, st, Math.max(20, subH - 8), bw, px, hovI);
    }

    // 顶部信息：涨跌幅百分比放第一位、紧跟股票名（约留 6 个空格），再列 开/高/低/收
    var last = end, prev = Math.max(0, last - 1);
    var chg = prev >= 0 && d.c[prev] ? (d.c[last] - d.c[prev]) / d.c[prev] * 100 : 0;
    var name = this.opts.title || (d.name || '') + ' ' + (d.code || '');
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = 'bold 12px "Roboto Mono",ui-monospace,Consolas,monospace';
    ctx.fillStyle = T.textHi;
    ctx.fillText(name, x0, 2);
    var nw = ctx.measureText(name).width;
    ctx.font = '11px "Roboto Mono",ui-monospace,Consolas,monospace';
    var spc = ctx.measureText('0').width;   // 等宽字体：用数字宽度近似 1 个空格
    var col = chg >= 0 ? T.up : T.dn;
    ctx.fillStyle = col;
    ctx.fillText((chg >= 0 ? '+' : '') + fmt(chg, 2) + '%  开' + fmt(d.o[last]) +
                 ' 高' + fmt(d.h[last]) + ' 低' + fmt(d.l[last]) + ' 收' + fmt(d.c[last]),
                 x0 + nw + 6 * spc, 3);

    // r35 近期上市股：序列首根（上市日）若在可见窗口内，画「上市」标签（老股/指数不标；置于叠加层之上防被均线盖住）
    if (this.opts.ipo && this.opts.firstIdx != null &&
        this.opts.firstIdx >= start && this.opts.firstIdx <= end && this.opts.firstIdx < d.c.length) {
      this._drawIpoTag(x0, pw, mainTop, mainBot, px, py, this.opts.firstIdx);
    }

    // 十字光标
    if (this.cross && this.cross.x >= x0 && this.cross.x <= x0 + pw) {
      var idx = Math.round(start + (this.cross.x - x0 - bw / 2) / bw);
      idx = Math.max(start, Math.min(end, idx));
      var cx2 = px(idx);
      ctx.strokeStyle = T.cross; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx2, mainTop); ctx.lineTo(cx2, H - this.padB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, this.cross.y); ctx.lineTo(x0 + pw, this.cross.y); ctx.stroke();
      ctx.setLineDash([]);
      // 悬浮信息框
      var info = [this._dateLabelFull(idx)];
      info.push('开' + fmt(d.o[idx]) + ' 收' + fmt(d.c[idx]));
      info.push('高' + fmt(d.h[idx]) + ' 低' + fmt(d.l[idx]));
      info.push('量' + fmtVol(d.v[idx]));
      if (d.t && d.t[idx] != null) info.push('换' + fmt(d.t[idx], 2) + '%');
      ctx.font = '11px "Roboto Mono",ui-monospace,Consolas,monospace';
      var bw2 = 136, bh2 = info.length * 14 + 8;
      // 光标在绘图区右半边 → 信息框翻到光标左侧；否则放右侧；硬性夹紧在绘图区内不溢出
      var bx = (cx2 - x0 > pw / 2) ? (cx2 - bw2 - 10) : (cx2 + 10);
      bx = Math.max(x0, Math.min(bx, x0 + pw - bw2));
      var by = Math.max(mainTop + 4, Math.min(this.cross.y - bh2 / 2, mainBot - bh2 - 4));
      ctx.fillStyle = T.panelBg; ctx.fillRect(bx, by, bw2, bh2);
      ctx.strokeStyle = T.line; ctx.strokeRect(bx, by, bw2, bh2);
      ctx.fillStyle = T.textHi; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      info.forEach(function (t, k) { ctx.fillText(t, bx + 6, by + 4 + k * 14); });
      // 日期后跟当日涨跌幅百分比（红涨绿跌；无前收对比显示 --）
      var dayPct = 0, hasPrev = idx > 0 && d.c[idx - 1] > 0;
      if (hasPrev) dayPct = (d.c[idx] - d.c[idx - 1]) / d.c[idx - 1] * 100;
      ctx.fillStyle = hasPrev ? (dayPct >= 0 ? T.up : T.dn) : T.dimLow;
      ctx.fillText(hasPrev ? ((dayPct >= 0 ? '+' : '') + fmt(dayPct, 2) + '%') : '--',
        bx + 6 + ctx.measureText(info[0]).width + 6, by + 4);
      // 成交量后跟涨跌幅（相对昨日量）：浅红涨 / 蓝青跌，与价格涨跌幅红/绿区分（r22）
      var hasPrevV = idx > 0 && d.v[idx - 1] > 0;
      var vPct = hasPrevV ? (d.v[idx] - d.v[idx - 1]) / d.v[idx - 1] * 100 : null;
      ctx.font = '11px "Roboto Mono",ui-monospace,Consolas,monospace';
      ctx.fillStyle = hasPrevV ? (vPct >= 0 ? T.volUp : T.volDn) : T.dimLow;
      ctx.fillText(hasPrevV ? ((vPct >= 0 ? '+' : '') + fmt(vPct, 2) + '%') : '--',
        bx + 6 + ctx.measureText(info[3]).width + 6, by + 4 + 3 * 14);
      this.hoverIdx = idx;
    } else this.hoverIdx = -1;

    // 主图价格轴「当前价」黄色标签（r22）：y 与该价真实位置对齐
    // 悬停某根 K 线 → 标该根收盘价；未悬停 → 标最新（当前游戏日）收盘价
    if (this.opts.pxTag !== false && d.c.length) {
      var aIdx = end;
      if (this.cross && this.cross.x >= x0 && this.cross.x <= x0 + pw) {
        var tI = Math.round(start + (this.cross.x - x0 - bw / 2) / bw);
        aIdx = Math.max(start, Math.min(end, tI));
      }
      if (d.c[aIdx] != null) {
        var tagP = d.c[aIdx];
        var tagY = Math.max(mainTop + 8, Math.min(mainBot - 8, py(tagP)));
        ctx.font = 'bold 11px "Roboto Mono",ui-monospace,Consolas,monospace';
        var tagTxt = fmt(tagP);
        var tW = ctx.measureText(tagTxt).width + 10;
        var tx = x0 + pw + 3;
        var tRight = x0 + pw + this.padR - 2;
        if (tx + tW > tRight) tx = Math.max(x0 + pw + 2, tRight - tW);   // 窄边防右侧溢出
        ctx.fillStyle = T.pxTagBg; ctx.fillRect(tx, tagY - 8, tW, 16);
        ctx.strokeStyle = T.pxTagBd; ctx.lineWidth = 1; ctx.strokeRect(tx, tagY - 8, tW, 16);
        ctx.fillStyle = T.pxTag; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(tagTxt, tx + 5, tagY + 0.5);
        // 绘图区右缘一小段黄线标出该价高度
        ctx.strokeStyle = T.pxTagBd;
        ctx.beginPath(); ctx.moveTo(x0 + pw - 7, tagY); ctx.lineTo(x0 + pw, tagY); ctx.stroke();
      }
    }
  };

  // 日期标签：opts.baseIdx = 开局日（该序列）下标 —— 开局日 = T0，其后 T+1/T+2… 随游戏推进递增，开局前为 T-1/T-2…
  KChart.prototype._dateLabel = function (i) {
    var s = String(this.data.d[i]);
    if (this.opts.baseIdx == null) return s.slice(4, 6) + '/' + s.slice(6, 8);
    var rel = i - this.opts.baseIdx;
    if (rel === 0) return 'T0';
    return rel < 0 ? ('T' + rel) : ('T+' + rel);
  };
  KChart.prototype._dateLabelFull = function (i) {
    var s = String(this.data.d[i]);
    if (this.opts.baseIdx == null) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    var rel = i - this.opts.baseIdx;
    if (rel === 0) return 'T0';
    return rel < 0 ? ('T' + rel) : ('T+' + rel);
  };

  // ---------- 副图指标参数定义与覆盖（r20：长按/右键可调参数，持久化到本机） ----------
  // params[]：{ n:参数名, def:默认值, min, max, tip:该参数说明提示 }
  var SUB_PDEF = {
    vol: {
      label: 'VOL', chn: '成交量',
      desc: '成交量柱状图：柱越高成交越活跃；柱色=当日涨跌（A股红涨绿跌）。价涨量增才健康，价涨量缩要警惕回落。',
      params: []
    },
    macd: {
      label: 'MACD', chn: '平滑异同移动平均',
      desc: '趋势型指标：DIF 上穿 DEA 金叉偏多、下穿死叉偏空；红绿柱=多头/空头动能。适合跟随中期趋势。',
      params: [
        { n: '快线周期 EMA', def: 12, min: 2, max: 120, tip: 'DIF = 快线EMA − 慢线EMA。越小对价格越敏感、信号越多。同花顺默认 12。' },
        { n: '慢线周期 EMA', def: 26, min: 5, max: 300, tip: '慢线越长趋势越稳、信号越滞后。同花顺默认 26。' },
        { n: 'DEA 平滑周期', def: 9, min: 2, max: 120, tip: 'DEA = DIF 的 N 日平滑，金叉/死叉的依据。同花顺默认 9。' }
      ]
    },
    kdj: {
      label: 'KDJ', chn: '随机指标',
      desc: '摆动型：K/D 低于 20 超卖、高于 80 超买；J 超过 100 或低于 0 为极端区。金叉死叉灵敏，适合短线。',
      params: [
        { n: 'RSV 周期', def: 9, min: 2, max: 100, tip: 'RSV 衡量 N 日内收盘价所处高低位置。同花顺默认 9。' },
        { n: 'K 平滑周期', def: 3, min: 1, max: 60, tip: 'K = RSV 的 M1 日平滑，越小越灵敏。同花顺默认 3。' },
        { n: 'D 平滑周期', def: 3, min: 1, max: 60, tip: 'D = K 的 M2 日平滑；J = 3K − 2D。同花顺默认 3。' }
      ]
    },
    rsi: {
      label: 'RSI', chn: '相对强弱指标',
      desc: '摆动型：数值高于 70 超买、低于 30 超卖。三条线分别对应短/中/长周期强弱，三线共振更可靠。',
      params: [
        { n: '短周期', def: 6, min: 2, max: 60, tip: 'RSI 短线（黄），超买超卖最灵敏。同花顺默认 6。' },
        { n: '中周期', def: 12, min: 2, max: 120, tip: 'RSI 中线（蓝）。同花顺默认 12。' },
        { n: '长周期', def: 24, min: 2, max: 240, tip: 'RSI 长线（紫），趋势更稳。同花顺默认 24。' }
      ]
    },
    cci: {
      label: 'CCI', chn: '顺势指标',
      desc: '波动型：突破 +100 进入强势区（超买但可持股），跌破 −100 进入弱势区（超卖）。±100 为多空分界。',
      params: [
        { n: '统计周期', def: 14, min: 2, max: 240, tip: '周期越短越灵敏、噪音越多。同花顺默认 14。' }
      ]
    },
    wr: {
      label: 'WR', chn: '威廉指标',
      desc: '摆动型：数值越高越超卖（接近 100），越低越超买（接近 0）。两条不同周期线互相印证，20/80 为参考线。',
      params: [
        { n: '周期 1', def: 10, min: 2, max: 120, tip: 'WR 黄线。同花顺默认 10。' },
        { n: '周期 2', def: 6, min: 2, max: 120, tip: 'WR 紫线，更短线。同花顺默认 6。' }
      ]
    },
    bias: {
      label: 'BIAS', chn: '乖离率',
      desc: '衡量收盘价偏离均线的百分比：偏离过大易向均线回归。正乖离过大警惕回调，负乖离过大可能反弹。',
      params: [
        { n: '短均线周期', def: 6, min: 2, max: 120, tip: 'BIAS1（黄）= (收盘−MA6)/MA6。同花顺默认 6。' },
        { n: '中均线周期', def: 12, min: 2, max: 240, tip: 'BIAS2（蓝）。同花顺默认 12。' },
        { n: '长均线周期', def: 24, min: 2, max: 480, tip: 'BIAS3（紫）。同花顺默认 24。' }
      ]
    },
    obv: {
      label: 'OBV', chn: '能量潮',
      desc: '量能累积线：价涨加当日量、价跌减当日量。OBV 走势与股价背离常预示变盘；黄线为 N 日均线。',
      params: [
        { n: '均线周期', def: 30, min: 2, max: 120, tip: 'OBV 的 N 日均线（黄），用于过滤噪音。同花顺默认 30。' }
      ]
    },
    dmi: {
      label: 'DMI', chn: '趋向指标',
      desc: '趋势强度：PDI > MDI 多头占优、反之空头；ADX 高于 25 趋势强、低于 20 属震荡。ADXR 为 ADX 的 N 日均值。',
      params: [
        { n: '统计周期', def: 14, min: 2, max: 240, tip: '计算 PDI/MDI/ADX 的周期。同花顺默认 14。' }
      ]
    },
    atr: {
      label: 'ATR', chn: '平均真实波幅',
      desc: '衡量波动幅度（不判方向）。ATR 高=波动大。实战中常用它设止损：止损距离 ≈ 2×ATR 较合理。',
      params: [
        { n: '统计周期', def: 14, min: 2, max: 240, tip: '周期越短越贴近近期波动。同花顺默认 14。' }
      ]
    },
    roc: {
      label: 'ROC', chn: '变动率',
      desc: 'N 日涨跌幅百分比，穿越 0 轴是多空切换信号；M 日平滑线辅助过滤噪音。',
      params: [
        { n: '变动周期', def: 12, min: 2, max: 240, tip: 'ROC = 今收相对 N 日前收盘的涨跌%。同花顺默认 12。' },
        { n: '平滑周期', def: 6, min: 2, max: 120, tip: 'ROC 的 M 日均线。同花顺默认 6。' }
      ]
    },
    mtm: {
      label: 'MTM', chn: '动量线',
      desc: 'N 日动量 = 今收 − N 日前收盘（元）。大于 0 多方占优，小于 0 空方占优；M 日均线交叉辅助判断。',
      params: [
        { n: '动量周期', def: 12, min: 2, max: 240, tip: '同花顺默认 12。' },
        { n: '平滑周期', def: 6, min: 2, max: 120, tip: 'MTM 的 M 日均线。同花顺默认 6。' }
      ]
    },
    vr: {
      label: 'VR', chn: '成交量变异率',
      desc: '量能型：上涨日量 / 下跌日量的比率 ×100。VR 高于 250 注意过热，低于 70 地量区常酝酿底部。',
      params: [
        { n: '统计周期', def: 26, min: 5, max: 240, tip: '同花顺默认 26。' },
        { n: '平滑周期', def: 6, min: 2, max: 120, tip: 'VR 的 M 日均线。同花顺默认 6。' }
      ]
    },
    psy: {
      label: 'PSY', chn: '心理线',
      desc: 'N 日内上涨天数占比 ×100：高于 75 过热、低于 25 低迷，50 为多空均衡；M 日平滑辅助。',
      params: [
        { n: '统计周期', def: 12, min: 5, max: 120, tip: '同花顺默认 12。' },
        { n: '平滑周期', def: 6, min: 2, max: 120, tip: 'PSY 的 M 日均线。同花顺默认 6。' }
      ]
    },
    ma: {
      label: 'MA', chn: '均线（主图叠加）',
      desc: '主图上叠加的四条简单移动平均：MA5 最快、MA60 最慢（默认 M5/M10/M20/M60）。短均线在长均线上方=多头排列偏强；死叉别急着抄底。改动后主图线条与左下角数值栏同步。',
      params: [
        { n: 'MA1 周期', def: 5, min: 2, max: 480, tip: '最快均线（M5）。同花顺主图默认 5。' },
        { n: 'MA2 周期', def: 10, min: 2, max: 480, tip: '短线均线（M10）。同花顺主图默认 10。' },
        { n: 'MA3 周期', def: 20, min: 2, max: 480, tip: '中线均线（M20），行情生命线。默认 20。' },
        { n: 'MA4 周期', def: 60, min: 2, max: 480, tip: '长线均线（M60），趋势牛熊分界。默认 60。' }
      ]
    },
    boll: {
      label: 'BOLL', chn: '布林带（主图叠加）',
      desc: '主图上叠加的布林通道：中轨=MA(N)，上下轨=中轨 ± 带宽倍数×标准差。价格贴上轨=强但拥挤，跌破下轨=弱但可能超跌；开口放大=波动加剧。',
      params: [
        { n: '统计周期', def: 20, min: 2, max: 240, tip: '中轨 = N 日移动平均，标准差也取 N 日。默认 20。' },
        { n: '带宽倍数', def: 2, min: 1, max: 5, tip: '上下轨距离 = 倍数 × 标准差。越大带越宽、触轨越难。默认 2。' }
      ]
    },
    'ma-pane': {
      label: 'MA', chn: '均线（独立分图窗口）',
      desc: '把均线放进独立副图窗口，方便放大观察均线斜率与多空排列。参数默认与主图一致，可单独调整，也可点下方「与主图一致」一键把主图参数同步过来。',
      params: [
        { n: 'MA1 周期', def: 5, min: 2, max: 480, tip: '最快均线。默认 5。' },
        { n: 'MA2 周期', def: 10, min: 2, max: 480, tip: '短线均线。默认 10。' },
        { n: 'MA3 周期', def: 20, min: 2, max: 480, tip: '中线均线。默认 20。' },
        { n: 'MA4 周期', def: 60, min: 2, max: 480, tip: '长线均线。默认 60。' }
      ]
    },
    crowd: {
      label: '拥挤度', chn: '乖离拥挤度',
      desc: '衡量收盘价偏离 N 日均线有多"拥挤"：数值 = 乖离距离 ÷ (带宽倍数×标准差)。|值|≥1 已挤到带宽之外，≥1.5 情绪过热、随时均值回归，≥2 极度拥挤；长期贴 0 轴=冷清。±1 虚线为拥挤警戒线。',
      params: [
        { n: '均线周期', def: 20, min: 5, max: 240, tip: '均线与标准差统计周期。默认 20。' },
        { n: '带宽倍数', def: 2, min: 1, max: 5, tip: '拥挤度分母 = 倍数×标准差。越大阈值越松。默认 2。' }
      ]
    }
  };
  var SUBP_LS = 'sims.subp.v1';
  var subOver = null;
  function loadSubOver() {
    if (subOver) return subOver;
    subOver = {};
    try { var raw = localStorage.getItem(SUBP_LS); if (raw) subOver = JSON.parse(raw) || {}; } catch (e) { subOver = {}; }
    return subOver;
  }
  // 生效参数（含用户覆盖，越界自动夹回 [min,max]）
  function subParams(kind) {
    var def = SUB_PDEF[kind];
    if (!def) return [];
    var ov = loadSubOver()[kind];
    return def.params.map(function (p, i) {
      var v = (ov && ov[i] != null) ? parseInt(ov[i], 10) : p.def;
      if (!isFinite(v)) v = p.def;
      return Math.max(p.min, Math.min(p.max, v));
    });
  }
  // 写入覆盖并持久化（越界自动夹回）
  function setSubParams(kind, arr) {
    var def = SUB_PDEF[kind];
    if (!def) return;
    var over = loadSubOver();
    over[kind] = def.params.map(function (p, i) {
      var v = parseInt(arr && arr[i], 10);
      if (!isFinite(v)) v = p.def;
      return Math.max(p.min, Math.min(p.max, v));
    });
    try { localStorage.setItem(SUBP_LS, JSON.stringify(over)); } catch (e) {}
  }
  // 一键重置全部指标参数（含主图均线/布林带/副图/拥挤度），回到各指标默认值
  function resetSubParamsAll() {
    subOver = {};
    try { localStorage.removeItem(SUBP_LS); } catch (e) {}
  }
  // 动态副图小标题：MACD(12,26,9) → 用户改参后自动跟随，如 MACD(10,22,7)
  function subLabel(kind) {
    var def = SUB_PDEF[kind];
    if (!def) return kind.toUpperCase();
    var p = subParams(kind);
    return p.length ? (def.label + '(' + p.join(',') + ')') : def.label;
  }
  // 副图小标题（同花顺式：指标名 + 当前值），放在副图窗口内顶部
  function subTitle(kind) { return subLabel(kind); }

  KChart.prototype._drawSub = function (kind, d, start, end, x0, pw, top, h, bw, px, hovI) {
    var ctx = this.ctx;
    // r27：标题数值跟随十字光标 —— 悬停某根 K 线取该根指标值；无悬停(或悬停在绘图区外)=-1 → 取最新（当前游戏日）
    var vi = (hovI >= 0) ? hovI : end;
    // 顶部边框线
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0 + pw, top); ctx.stroke();
    ctx.font = '10px "Roboto Mono",ui-monospace,Consolas,monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';

    // 窗口标题行：指标名 + 指标当前值（默认 dim）
    var title = subTitle(kind);
    var titleX = x0 + 4, titleY = top + 1;

    // 统一的绘图基线
    var pTop = top + 14, pH = Math.max(12, h - 16);   // 标题区约占 14px

    var yLine = function (arr, color, yOf, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.1;
      ctx.setLineDash(dash || []);
      ctx.beginPath(); var st = false;
      for (var i = start; i <= end; i++) {
        if (arr[i] == null) continue;
        if (!st) { ctx.moveTo(px(i), yOf(arr[i])); st = true; }
        else ctx.lineTo(px(i), yOf(arr[i]));
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    var hRef = function (vv, color, dash) {
      ctx.strokeStyle = color || T.line; ctx.lineWidth = 1;
      ctx.setLineDash(dash || [3, 3]);
      ctx.beginPath(); ctx.moveTo(x0, vv); ctx.lineTo(x0 + pw, vv); ctx.stroke();
      ctx.setLineDash([]);
    };

    if (kind === 'vol') {
      var vmax = 0;
      for (var i = start; i <= end; i++) if (d.v[i] > vmax) vmax = d.v[i];
      if (vmax <= 0) vmax = 1;
      var vBot = top + h - 2;
      var vH = Math.max(10, vBot - pTop);
      for (var i = start; i <= end; i++) {
        var up = d.c[i] >= d.o[i];
        ctx.fillStyle = up ? T.up : T.dn;
        var hh = Math.max(1, d.v[i] / vmax * vH);
        ctx.fillRect(px(i) - bw * 0.34, vBot - hh, bw * 0.68, hh);
      }
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmtVol(d.v[vi]), titleX, titleY);
    } else if (kind === 'macd') {
      var m = macd(d.c, 12, 26, 9);
      var mx = 0;
      for (var i = start; i <= end; i++) {
        [m.dif[i], m.dea[i], m.bar[i]].forEach(function (v) { if (v != null && Math.abs(v) > mx) mx = Math.abs(v); });
      }
      if (mx <= 0) mx = 1;
      var mY = function (v) { return pTop + pH / 2 - v / mx * (pH / 2); };
      var zero = mY(0);
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(x0, zero); ctx.lineTo(x0 + pw, zero); ctx.stroke();
      for (var i = start; i <= end; i++) {
        if (m.bar[i] == null) continue;
        ctx.fillStyle = m.bar[i] >= 0 ? T.up : T.dn;
        var y = mY(m.bar[i]);
        ctx.fillRect(px(i) - bw * 0.3, Math.min(y, zero), bw * 0.6, Math.max(1, Math.abs(y - zero)));
      }
      yLine(m.dif, T.dif, mY); yLine(m.dea, T.dea, mY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  DIF:' + fmt(m.dif[vi], 3) + '  DEA:' + fmt(m.dea[vi], 3), titleX, titleY);
    } else if (kind === 'kdj') {
      var k = kdj(d.h, d.l, d.c, 9, 3, 3);
      var kY = function (v) { return pTop + pH - (Math.max(-20, Math.min(120, v)) + 20) / 140 * pH; };
      hRef(pTop + pH * 0.2); hRef(pTop + pH * 0.8);
      yLine(k.k, T.kc, kY); yLine(k.d, T.dc, kY); yLine(k.j, T.jc, kY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  K:' + fmt(k.k[vi], 1) + '  D:' + fmt(k.d[vi], 1) + '  J:' + fmt(k.j[vi], 1), titleX, titleY);
    } else if (kind === 'rsi') {
      var p = subParams('rsi');
      var r6 = rsi(d.c, p[0]), r12 = rsi(d.c, p[1]), r24 = rsi(d.c, p[2]);
      var rY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      hRef(pTop + pH * 0.2, T.line); hRef(pTop + pH * 0.8, T.line);   // 20/80 参考
      yLine(r6, T.rsi6, rY); yLine(r12, T.rsi12, rY); yLine(r24, T.rsi24, rY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(r6[vi], 1) + '/' + fmt(r12[vi], 1) + '/' + fmt(r24[vi], 1), titleX, titleY);
    } else if (kind === 'cci') {
      var cc = cci(d.h, d.l, d.c, 14);
      var cm = 0;
      for (var i = start; i <= end; i++) if (cc[i] != null && Math.abs(cc[i]) > cm) cm = Math.abs(cc[i]);
      cm = Math.max(cm, 100);
      var cY = function (v) { return pTop + pH / 2 - v / cm * (pH / 2); };
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(x0, cY(0)); ctx.lineTo(x0 + pw, cY(0)); ctx.stroke();
      hRef(cY(100)); hRef(cY(-100));
      yLine(cc, T.cci, cY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(cc[vi], 1), titleX, titleY);
    } else if (kind === 'wr') {
      var w1 = wr(d.h, d.l, d.c, 10), w2 = wr(d.h, d.l, d.c, 6);
      var wY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      hRef(pTop + pH * 0.2); hRef(pTop + pH * 0.8);   // 20(超买)/80(超卖) 参考
      yLine(w1, T.wr1, wY); yLine(w2, T.wr2, wY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(w1[vi], 1) + '/' + fmt(w2[vi], 1), titleX, titleY);
    } else if (kind === 'bias') {
      var b6 = bias(d.c, 6), b12 = bias(d.c, 12), b24 = bias(d.c, 24);
      var bm = 0;
      for (var i = start; i <= end; i++) {
        [b6[i], b12[i], b24[i]].forEach(function (v) { if (v != null && Math.abs(v) > bm) bm = Math.abs(v); });
      }
      bm = Math.max(bm, 2);
      var bY = function (v) { return pTop + pH / 2 - v / bm * (pH / 2); };
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(x0, bY(0)); ctx.lineTo(x0 + pw, bY(0)); ctx.stroke();
      yLine(b6, T.bias6, bY); yLine(b12, T.bias12, bY); yLine(b24, T.bias24, bY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(b6[vi], 2) + '/' + fmt(b12[vi], 2) + '/' + fmt(b24[vi], 2), titleX, titleY);
    } else if (kind === 'obv') {
      var o = obv(d.c, d.v, 30);
      var oLo = 0, oHi = 0;
      for (var i = start; i <= end; i++) {
        if (o.obv[i] > oHi) oHi = o.obv[i];
        if (o.obv[i] < oLo) oLo = o.obv[i];
        if (o.ma[i] != null) { if (o.ma[i] > oHi) oHi = o.ma[i]; if (o.ma[i] < oLo) oLo = o.ma[i]; }
      }
      if (oHi === oLo) { oHi = oLo + 1; }
      var oY = function (v) { return pTop + (oHi - v) / (oHi - oLo) * pH; };
      yLine(o.obv, T.obv, oY); yLine(o.ma, T.obvma, oY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmtBig(o.obv[vi]), titleX, titleY);
    } else if (kind === 'dmi') {
      var dm = dmi(d.h, d.l, d.c, 14);
      var dY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      yLine(dm.pdi, T.pdi, dY); yLine(dm.mdi, T.mdi, dY);
      yLine(dm.adx, T.adx, dY); yLine(dm.adxr, T.adxr, dY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  PDI:' + fmt(dm.pdi[vi], 1) + '  MDI:' + fmt(dm.mdi[vi], 1) +
        '  ADX:' + fmt(dm.adx[vi], 1), titleX, titleY);
    } else if (kind === 'atr') {
      var at = atr(d.h, d.l, d.c, 14);
      var am = 0;
      for (var i = start; i <= end; i++) if (at[i] != null && at[i] > am) am = at[i];
      if (am <= 0) am = 1;
      var aY = function (v) { return pTop + pH - v / am * pH; };
      yLine(at, T.atr, aY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(at[vi], 2), titleX, titleY);
    } else if (kind === 'roc') {
      var rc = roc(d.c, 12, 6);
      var rm = 0;
      for (var i = start; i <= end; i++) {
        if (rc.roc[i] != null && Math.abs(rc.roc[i]) > rm) rm = Math.abs(rc.roc[i]);
      }
      rm = Math.max(rm, 1);
      var rcY = function (v) { return pTop + pH / 2 - v / rm * (pH / 2); };
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(x0, rcY(0)); ctx.lineTo(x0 + pw, rcY(0)); ctx.stroke();
      yLine(rc.roc, T.roc, rcY); yLine(rc.ma, T.rocma, rcY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(rc.roc[vi], 2), titleX, titleY);
    } else if (kind === 'mtm') {
      var mm = mtm(d.c, 12, 6);
      var mmm = 0;
      for (var i = start; i <= end; i++) {
        if (mm.mtm[i] != null && Math.abs(mm.mtm[i]) > mmm) mmm = Math.abs(mm.mtm[i]);
      }
      mmm = Math.max(mmm, 0.01);
      var mmY = function (v) { return pTop + pH / 2 - v / mmm * (pH / 2); };
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(x0, mmY(0)); ctx.lineTo(x0 + pw, mmY(0)); ctx.stroke();
      yLine(mm.mtm, T.mtm, mmY); yLine(mm.ma, T.mtmma, mmY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(mm.mtm[vi], 2), titleX, titleY);
    } else if (kind === 'vr') {
      var vv = vr(d.c, d.v, 26, 6);
      var vrm = 0;
      for (var i = start; i <= end; i++) if (vv.vr[i] != null && vv.vr[i] > vrm) vrm = vv.vr[i];
      vrm = Math.max(vrm, 100);
      var vrY = function (v) { return pTop + pH - Math.max(0, v) / vrm * pH; };
      yLine(vv.vr, T.vr, vrY); yLine(vv.ma, T.vrma, vrY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(vv.vr[vi], 0), titleX, titleY);
    } else if (kind === 'psy') {
      var p = subParams('psy');
      var ps = psy(d.c, p[0], p[1]);
      var pY = function (v) { return pTop + pH - Math.max(0, Math.min(100, v)) / 100 * pH; };
      hRef(pTop + pH * 0.5, T.line); hRef(pTop + pH * 0.25); hRef(pTop + pH * 0.75);
      yLine(ps.psy, T.psy, pY); yLine(ps.ma, T.psyma, pY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(ps.psy[vi], 0), titleX, titleY);
    } else if (kind === 'ma-pane') {
      // 均线独立分图窗口（参数独立于主图，可「与主图一致」同步）
      var mpP = subParams('ma-pane');
      if (!mpP.length) mpP = [5, 10, 20, 60];
      if (mpP.length < 4) mpP = mpP.concat([5, 10, 20, 60]).slice(0, 4);
      var mpPs = mpP.slice(0, 4);
      var mpC = [T.ma5, T.ma10, T.ma20, T.ma60];
      var mpA = mpPs.map(function (n) { return sma(d.c, n); });
      var mMin = Infinity, mMax = -Infinity;
      for (var qm2 = 0; qm2 < 4; qm2++) {
        var maL = mpA[qm2];
        for (var i2 = start; i2 <= end; i2++) {
          if (maL[i2] == null) continue;
          if (maL[i2] < mMin) mMin = maL[i2];
          if (maL[i2] > mMax) mMax = maL[i2];
        }
      }
      if (!(mMax > mMin)) { mMin = 0; mMax = 1; }
      var mPad2 = (mMax - mMin) * 0.05; mMin -= mPad2; mMax += mPad2;
      var mPY = function (v) { return pTop + (mMax - v) / (mMax - mMin) * pH; };
      for (var qm3 = 0; qm3 < 4; qm3++) yLine(mpA[qm3], mpC[qm3], mPY);
      ctx.fillStyle = T.text;
      ctx.fillText(title, titleX, titleY);
    } else if (kind === 'crowd') {
      // 拥挤度（乖离拥挤度）：(收盘 − MA(N)) / (K×σ)，±1 为拥挤警戒线
      var cp = subParams('crowd');
      var cn = (cp[0] && cp[0] >= 5) ? cp[0] : 20;
      var ck = (cp[1] && cp[1] >= 1) ? cp[1] : 2;
      var cMid = sma(d.c, cn), cd = new Array(d.c.length).fill(null);
      for (var i3 = 0; i3 < d.c.length; i3++) {
        if (cMid[i3] == null) continue;
        var cs = 0;
        for (var q4 = i3 - cn + 1; q4 <= i3; q4++) cs += Math.pow(d.c[q4] - cMid[i3], 2);
        var csd = Math.sqrt(cs / cn);
        cd[i3] = csd > 0 ? (d.c[i3] - cMid[i3]) / (ck * csd) : 0;
      }
      var cMx = 1.2;
      for (var i4 = start; i4 <= end; i4++) if (cd[i4] != null && Math.abs(cd[i4]) > cMx) cMx = Math.abs(cd[i4]);
      cMx *= 1.12;
      var cY = function (v) { return pTop + pH / 2 - v / cMx * (pH / 2); };
      ctx.strokeStyle = T.line; ctx.beginPath(); ctx.moveTo(x0, cY(0)); ctx.lineTo(x0 + pw, cY(0)); ctx.stroke();
      hRef(cY(1), T.ref); hRef(cY(-1), T.ref);
      yLine(cd, T.crowd, cY);
      ctx.fillStyle = T.text;
      ctx.fillText(title + '  ' + fmt(cd[vi], 2), titleX, titleY);
    }
  };

  // 大整数紧凑格式化（OBV 等累计量）
  function fmtBig(n) {
    if (n == null || isNaN(n)) return '--';
    var neg = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 1e8) return neg + (a / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return neg + (a / 1e4).toFixed(1) + '万';
    return neg + Math.round(a);
  }

  // ---------- 筹码峰（横向，与主图价格轴对齐） ----------
  function ChipChart(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.data = null; this.date = null; this.cssW = 0; this.cssH = 0;
    this.hideDate = false;
  }
  ChipChart.prototype.resize = function (w, h) {
    var dpr = window.devicePixelRatio || 1;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w; this.cssH = h; this.draw();
  };
  ChipChart.prototype.setData = function (code, date, priceRect) {
    var all = (global.GAME_CHIPS || {}).stocks || {};
    this.data = all[code] || null;
    this.date = date;
    this.priceRect = priceRect || null;   // {lo,hi,top,bot} 与 K 线主图价格轴对齐
    this.draw();
  };
  ChipChart.prototype.draw = function () {
    var ctx = this.ctx, W = this.cssW, H = this.cssH;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = T.panel; ctx.fillRect(0, 0, W, H);
    ctx.font = '10px "Roboto Mono",ui-monospace,Consolas,monospace';
    if (!this.data) { ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('筹码峰', 4, 2); return; }
    var frames = this.data.frames, keys = Object.keys(frames);
    var lastKey = keys[0];
    for (var i = 0; i < keys.length; i++) { if (Number(keys[i]) <= Number(this.date)) lastKey = keys[i]; }
    ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('筹码峰' + (this.hideDate ? '' : ' ' + lastKey), 4, 2);

    var frame = frames[lastKey];
    var bins = this.data.bins;
    var maxPct = Math.max.apply(null, frame);
    if (maxPct <= 0) maxPct = 1;

    var pr = this.priceRect;
    if (!pr || !(pr.hi > pr.lo)) {
      // 退化模式：未提供价格轴对齐信息时均匀铺满
      var padT = 16, padB = 16, h = H - padT - padB;
      var barH = h / bins.length;
      for (var i = 0; i < bins.length; i++) {
        var w0 = frame[i] / maxPct * (W - 46);
        var y0 = padT + (bins.length - 1 - i) * barH;
        ctx.fillStyle = '#2962FF';
        ctx.globalAlpha = 0.55 + frame[i] / maxPct * 0.45;
        ctx.fillRect(4, y0, Math.max(0, w0), Math.max(1, barH - 1));
        ctx.globalAlpha = 1;
        if (i % 12 === 0) {
          ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(bins[i].toFixed(0), W - 40, y0 + barH / 2);
        }
      }
      return;
    }

    // 与 K 线主图价格轴对齐：相同价格映射到相同 y
    var lo = pr.lo, hi = pr.hi, top = pr.top, bot = pr.bot;
    var yOf = function (p) { return bot - (p - lo) / (hi - lo) * (bot - top); };
    var barMaxW = W - 56;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, W, bot - top); ctx.clip();
    for (var i = 0; i < bins.length; i++) {
      var p = bins[i];
      if (p < lo || p > hi) continue;
      var step = (i < bins.length - 1) ? (bins[i + 1] - bins[i]) : (bins[i] - bins[i - 1]);
      if (!(step > 0)) step = (hi - lo) / 30;
      var yT = yOf(p + step / 2), yB = yOf(p - step / 2);
      var w1 = frame[i] / maxPct * barMaxW;
      ctx.fillStyle = '#2962FF';
      ctx.globalAlpha = 0.55 + frame[i] / maxPct * 0.45;
      ctx.fillRect(4, yT, Math.max(0, w1), Math.max(1, yB - yT));
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // 价格刻度（右侧，与 K 线价格轴同尺度）
    ctx.fillStyle = T.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var yy = top + (bot - top) * g / 4;
      var pv = hi - (hi - lo) * g / 4;
      ctx.fillText(pv.toFixed(2), W - 4, yy);
    }
  };

  global.ChartEng = {
    KChart: KChart, ChipChart: ChipChart,
    sma: sma, ema: ema, macd: macd, kdj: kdj, boll: boll,
    rsi: rsi, cci: cci, wr: wr, bias: bias, obv: obv, dmi: dmi,
    atr: atr, roc: roc, mtm: mtm, vr: vr, psy: psy,
    fmtBig: fmtBig, subTitle: subTitle, theme: T, setTheme: setTheme,
    SUB_PDEF: SUB_PDEF, subParams: subParams, setSubParams: setSubParams, subLabel: subLabel,
    resetSubParamsAll: resetSubParamsAll
  };
})(window);
