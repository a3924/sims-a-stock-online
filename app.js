/* app.js — 《我的模拟人生 · A股版》在线版游戏逻辑
 * 依赖: window.GAME_INDEX / GAME_OAMV / GAME_NEWS / GAME_UNI / ChartEng / Online
 * 在线版：不内置个股K线/筹码大文件；全市场清单在 GAME_UNI，
 * 每局抽中的 N 只标的（简单 8 / 复杂 18，默认复杂）由 online.js 从腾讯行情接口实时拉取 5 年日K并合成筹码。
 */
(function (global) {
  'use strict';

  var UNI = global.GAME_UNI || { inds: [], stocks: [], etfs: [] };
  var UNI_INDS = UNI.inds || [];
  var IX = global.GAME_INDEX, NW = global.GAME_NEWS || { market: [], stocks: {} };
  var OV = global.GAME_OAMV ? global.GAME_OAMV.series : null;

  // K 线与筹码：先以全市场清单建骨架（名称/分类/行业，无行情），拉数后回填 d/o/h/l/c/v
  var KL = { stocks: {} };
  var CH = { meta: { bins: 60, frame_every: 5, algo: 'CYQ-synth-online' }, stocks: {} };
  global.GAME_CHIPS = CH;   // chart.js 的 ChipChart 从全局读筹码
  (function () {
    function add(c, n, k, i) {
      KL.stocks[c] = { name: n, cat: k, ind: (UNI_INDS[i] != null ? UNI_INDS[i] : '其他'), d: [] };
    }
    UNI.stocks.forEach(function (s) { add(s.c, s.n, s.k, s.i); });
    UNI.etfs.forEach(function (e) { add(e.c, e.n, 'etf', e.i); });
  })();
  var OL = global.Online;
  OL.init(IX.sh_index.d[IX.sh_index.d.length - 1]);   // 对齐全局交易日轴终点

  var DAYS = IX.sh_index.d;                 // 全局日期轴（交易日）
  var TOTAL_BARS = DAYS.length;
  var GAME_BARS = 242;                      // 一局约365自然日
  var INIT_CASH = 200000;                   // 统一20万本金
  var RF = 0.02;                            // 无风险年化2%

  // 对比面板可选系列 = 本地指数包全部 + 0AMV（在线版不再内置 ETF 行情文件）
  var IDX_OPTIONS = Object.keys(IX).map(function (k) {
    return { k: k, n: IX[k].name || k };
  }).concat(OV ? [{ k: 'oamv', n: '0AMV 活跃市值' }] : []);

  // 副图指标目录（同花顺常用副图：VOL/MACD/KDJ/RSI/CCI/WR/BIAS/OBV/DMI/ATR/ROC/MTM/VR/PSY/拥挤度）
  var SUB_ORDER = ['vol', 'macd', 'kdj', 'rsi', 'cci', 'wr', 'bias', 'obv', 'dmi', 'atr', 'roc', 'mtm', 'vr', 'psy', 'crowd'];
  // 指标设置按钮排列：主图叠加型（均线/布林带）放前两个，其后为副图指标（含均线分图窗口）
  var CHIP_ORDER = ['ma', 'boll', 'ma-pane'].concat(SUB_ORDER);
  var SUB_META = {
    ma: { l: '均线', m: '移动平均', t: 'MA 均线（主图叠加，默认 M5/M10/M20/M60）' },
    boll: { l: '布林带', m: '布林带', t: 'BOLL 布林带（主图叠加，默认 20,2）' },
    vol: { l: 'VOL', m: '成交量', t: 'VOL 成交量' },
    macd: { l: 'MACD', m: '平滑异同', t: 'MACD(12,26,9) 平滑异同' },
    kdj: { l: 'KDJ', m: '随机指标', t: 'KDJ(9,3,3) 随机指标' },
    rsi: { l: 'RSI', m: '相对强弱', t: 'RSI(6,12,24) 相对强弱' },
    cci: { l: 'CCI', m: '顺势指标', t: 'CCI(14) 顺势指标' },
    wr: { l: 'WR', m: '威廉指标', t: 'WR(10,6) 威廉指标' },
    bias: { l: 'BIAS', m: '乖离率', t: 'BIAS(6,12,24) 乖离率' },
    obv: { l: 'OBV', m: '能量潮', t: 'OBV(30) 能量潮' },
    dmi: { l: 'DMI', m: '趋向指标', t: 'DMI(14) 趋向指标' },
    atr: { l: 'ATR', m: '真实波幅', t: 'ATR(14) 真实波幅' },
    roc: { l: 'ROC', m: '变动率', t: 'ROC(12,6) 变动率' },
    mtm: { l: 'MTM', m: '动量线', t: 'MTM(12,6) 动量线' },
    vr: { l: 'VR', m: '量变率', t: 'VR(26,6) 成交量变异率' },
    psy: { l: 'PSY', m: '心理线', t: 'PSY(12,6) 心理线' },
    crowd: { l: '拥挤度', m: '乖离拥挤度', t: '拥挤度（乖离拥挤度，副图）' },
    'ma-pane': { l: '均线分图', m: '均线(独立分图)', t: 'MA 均线（独立分图窗口，参数默认同主图）' }
  };
  var MAX_SUB = 5;   // 同时最多显示副图窗口数（主图高度会按数量收缩）

  function seriesOf(k) {
    return k === 'oamv' ? OV : IX[k];
  }

  // 游戏中隐藏真实日期（只显示相对交易日 T+n，T0 = 开局日，其后 T+1/T+2… 随游戏推进递增），真实区间仅在结算页"显示真实日期"揭晓。
  var HIDE = true;
  var GAME_TITLE = '我的模拟人生 · A股版';   // 游戏名（多处复用）
  var GAME_VERSION = 'v20260904.r31';   // r31：种子分享细化（选股屏「本局种子」移至「开始你的交易人生」下方、不写种子串只给按钮+提示；游戏中💡与结算分享文案剔除评级、含当前收益/我的成绩与同期沪深300；夏普评级改 S>3/A>2/B>1/C>0；结算屏种子区移到复盘/再来一局下方；历史战绩每条加「🎯种子」一键复制本局种子；B/C 随机池/自定义大池个别标的一时拉不到不再整局卡死——55s 单只看门狗+残余剔除放行保住开局）；r30：挑战种子——每局都编码成一颗种子（股票池3–20只+起始日，文本开头 #我的人生模拟器·A股版、后接 base62 大小写+数字）；开始交易屏亮出「本局种子」可复制、游戏中💡灯泡面板加「分享本局种子」、结算页写出一整段分享文案；「用种子开局」= 同一批股票+同一起点，成绩可横向比拼，本机按种子存最佳成绩；换股票池或局内增删自选后本局作废、不再计入该种子最佳；r29：开局玩法弹窗/选股屏/结算确认文案整体改版（弹窗导语与A精选池/B全市场随机/C自定义池/D ETF+LOF卡描述重写、C卡「选择 3–20 只 → 全部开局」、开局数量区带默认✓、小提示重写；选股屏副标「全市场实时行情·模拟选股」+引导语「选择你的股票池，开始这一局模拟人生。」+主按钮「开始你的交易人生」；结算确认弹窗正文细化）；r28：打赏和建议弹窗文案更新（感谢你愿意玩到这里 / 数据整理 / 喝杯奶茶 / 认真看反馈 / 感谢使用与支持）；r27：副图标题指标值跟随鼠标十字光标联动（同花顺式——悬停哪根K线即显示该根数值，移开恢复最新）；r26：结算报告移除 0AMV 活跃市值行，本局区间与同期沪深300改为两行排版（基准涨跌上红/绿色）；r25：自选/自定义池彻底放开3只开局(C勾选/开局/剔除兜底全链路)+游戏内自选池「✎增删本池股票」+打赏二维码120%去外框；r24：结算后「打赏和建议」（感谢文案+邮箱 gzy000@foxmail.com+赞赏二维码）；r23：自定义池下限改为3只且不限上限 + 局内「编辑此池」增删（下一局生效）；r22：MA数值栏2+2修复+手机指标栏提示与标题同行可点折叠+量涨跌幅浅红/蓝青+价格轴黄色当前价标签；r21：指标设置改版（均线/布林带入列主图叠加+分图模式+拥挤度+信息框量涨跌幅+主图左下MA数值栏+重置全部参数）；r20：长按/右键副图指标改参数；r19：复权守卫+副图英文；r18：结算滚动+分类排序+D模式+💡+B/S标注+历史+复盘
  // 用户双击版本号自定义的开局起点（DAYS 索引）；null=随机。持久化在 localStorage。
  var CUR_START = (function () {
    var v = localStorage.getItem('sims.customStart');
    if (v === null || v === '') return null;
    v = parseInt(v, 10);
    return (!isNaN(v) && v >= 0) ? v : null;
  })();

  // 全局日期轴索引，用于相对交易日换算
  var DAY_IDX = {};
  DAYS.forEach(function (d, i) { DAY_IDX[d] = i; });

  // 序列内日期 -> 索引（美股ETF等序列与A股日历不完全一致，不能直接用全局下标）
  function seriesEndIdx(series, date) {
    var d = series.d;
    if (!series._map) {
      series._map = {};
      for (var q = 0; q < d.length; q++) series._map[d[q]] = q;
    }
    var j = series._map[date];
    if (j != null) return j;
    var lo = 0, hi = d.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (d[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best < 0 ? 0 : best;
  }

  // 相对交易日标签：T0 / T+n / T-n（以本局起始日为基准）
  function relDay(date) {
    var j = DAY_IDX[date];
    if (j == null) return '';
    var rel = j - S.startIdx;
    if (rel === 0) return 'T0';
    return rel < 0 ? ('T' + rel) : ('T+' + rel);
  }
  // 游戏中统一的日期显示：隐藏模式显示相对交易日
  function dayLabel(date) { return HIDE ? relDay(date) : fmtDate(date); }

  var S = null;   // 游戏状态

  // ---------- 工具 ----------
  function money(v) {
    var a = Math.abs(v);
    var s = a >= 10000 ? (a / 10000).toFixed(2) + '万' : a.toFixed(0);
    return (v < 0 ? '-' : '') + '¥' + s;
  }
  function pct(v) { if (v == null || !isFinite(v)) return '--'; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function cls(v) { return v > 0 ? 'up' : (v < 0 ? 'dn' : ''); }
  function fmtDate(d) { var s = String(d); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
  function el(id) { return document.getElementById(id); }
  // 手机版判定：窄屏（<881px）→ 竖屏单列、K线默认 35 根（太密看不清）；桌面默认 100 根
  function isNarrow() { return (window.innerWidth || document.documentElement.clientWidth) <= 880; }
  function defaultBars() { return isNarrow() ? 35 : 100; }

  // ---------- 临时存档（cookie 为主 + localStorage 兜底） ----------
  // 说明：cookie 写紧凑版（受 ~4KB 单条限制，流水过多时自动截断）；localStorage 写完整版。
  // 读取时优先 localStorage（完整可恢复），其次 cookie（截断兜底）。二者均带构建版本号 g，
  // 版本不匹配则视为无效存档（避免旧档加载到新代码引发错乱）。
  var SAVE_KEY = 'mlife_save';
  var SAVE_EXPIRE_DAYS = 30;

  function buildSaveObj() {
    return {
      v: 1, g: GAME_VERSION,
      startIdx: S.startIdx, curIdx: S.curIdx, day: S.day, cash: S.cash,
      md: S.marginDebt, mu: S.marginUsed, mu2: S.marginUnlocked,
      over: S.over, revealed: S.revealed, sel: S.sel, rp: S.repoolUsed ? 1 : 0, sd: S.seed || null,
      pool: S.pool.map(function (p) { return p.code; }),
      pos: S.positions.map(function (p) { return [p.code, p.shares, p.cost, p.buyIdx]; }),
      tr: S.trades.map(function (t) {
        return [t.code, t.shares, t.cost, t.sell, t.buyIdx, t.sellIdx, t.pl, t.days, t.fee, t.forced ? 1 : 0];
      }),
      eq: S.equity.map(function (e) { return e.v; }),
      stats: S.stats || null
    };
  }
  function saveProgress() {
    if (!S) return;
    try {
      var full = buildSaveObj();
      // 1) localStorage：完整版（容量大，file:///http 下均可作为主恢复源）
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(full)); } catch (e) {}
      // 2) cookie：紧凑版，超 ~3.8KB 则丢弃流水（保证 cookie 不爆，仍满足"写入 cookie"需求）
      var cj = JSON.stringify(full);
      var truncated = false;
      if (cj.length > 3800) { full.tr = []; full.trunc = true; cj = JSON.stringify(full); truncated = true; }
      var exp = new Date(Date.now() + SAVE_EXPIRE_DAYS * 86400000).toUTCString();
      document.cookie = SAVE_KEY + '=' + encodeURIComponent(cj) + '; expires=' + exp + '; path=/; SameSite=Lax';
      if (truncated) console.warn('[存档] 交易流水过多，cookie 已省略流水（localStorage 仍保留完整进度）');
    } catch (e) { /* 存储不可用（如某些浏览器 file:// 限制）时静默 */ }
  }
  function readRaw() {
    var raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) {}
    if (!raw) {
      try {
        var m = document.cookie.match(new RegExp('(?:^|; )' + SAVE_KEY + '=([^;]*)'));
        if (m) raw = decodeURIComponent(m[1]);
      } catch (e) {}
    }
    return raw;
  }
  function readSave() {
    var raw = readRaw();
    if (!raw) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || o.g !== GAME_VERSION) return null;            // 版本不匹配 -> 无效
    if (typeof o.startIdx !== 'number' || typeof o.curIdx !== 'number') return null;
    return o;
  }
  function hasSave() { return !!readSave(); }
  // 可继续的存档：版本匹配、未收官、有股票池
  function canResume() {
    var o = readSave();
    return !!(o && !o.over && o.pool && o.pool.length);
  }
  function clearSave() {
    try { document.cookie = SAVE_KEY + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax'; } catch (e) {}
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  // ---------- 本机多局历史（r18：结算即归档，下次打开可查，最多保留 40 局） ----------
  var HIST_LS = 'sims.hist.v1';
  function loadHist() {
    try { return JSON.parse(localStorage.getItem(HIST_LS) || '[]'); } catch (e) { return []; }
  }
  function saveHist(a) {
    try { localStorage.setItem(HIST_LS, JSON.stringify(a)); } catch (e) { /* 容量超限时静默（最老一局丢弃再试） */ }
  }
  function histModeLabel(src) {
    if (!src) return '全市场B';
    return ({ builtin: '内置精选A', uni: '全市场B', mine: '自定义C', etf: 'ETF+LOF D', seed: '种子挑战' })[src.kind] || '全市场B';
  }
  // 结算成功后归档本局（只读快照：战绩 + 交易流水，供历史列表复盘查阅）
  function archiveGame() {
    if (!S || !S.over || !S.stats) return;
    try {
      var st = S.stats, src = curSrc || { kind: 'uni', id: '' };
      var rec = {
        id: Date.now().toString(36), ts: Date.now(),
        ver: GAME_VERSION, mode: histModeLabel(src), simple: isEasy(),
        src: { kind: src.kind, id: src.id },
        pool: S.pool.slice(0, 40).map(function (p) { return { c: p.code, n: p.name, t: p.cat }; }),
        s0: DAYS[S.startIdx], s1: DAYS[S.curIdx], days: S.day, nPool: S.pool.length,
        sIdx: S.startIdx, sd: S.seed || null,      // r31：记录起始日下标 + 本局挑战种子（历史一键复制本局种子用）
        eq: st.finalEq, ret: st.totalRet, annual: st.annual, sh: st.sharpe, mdd: st.mdd,
        alpha: st.alpha, beta: st.beta, wr: st.winRate, wins: st.wins, losses: st.losses,
        nTr: S.trades.length, bench: st.benchRet, rank: st.rank, posVal: st.posVal,
        maxWin: st.maxWin, maxLoss: st.maxLoss, avgHold: st.avgHold, maxHold: st.maxHold,
        trs: S.trades.slice(0, 300).map(function (t) {
          return { n: t.name, b: t.buyIdx, x: t.sellIdx, pl: t.pl, d: t.days, f: t.forced ? 1 : 0 };
        }),
        trunc: S.trades.length > 300
      };
      var a = loadHist();
      a.unshift(rec);
      if (a.length > 40) a.length = 40;
      saveHist(a);
    } catch (e) { console.error('[历史] 归档失败', e); }
  }
  function loadProgress() {
    var o = readSave();
    if (!o) return false;
    var pool = o.pool.map(function (c) {
      var s = KL.stocks[c];
      return { code: c, name: s.name, ind: s.ind, cat: s.cat };
    });
    var map = {};
    pool.forEach(function (p) { map[p.code] = buildMap(KL.stocks[p.code]); });
    S = {
      startIdx: o.startIdx, curIdx: o.curIdx, day: o.day, cash: o.cash,
      marginDebt: o.md, marginUsed: o.mu, positions: [], trades: [], equity: [],
      map: map, pool: pool, sel: o.sel, marginUnlocked: o.mu2,
      over: o.over, revealed: o.revealed, stats: o.stats, repoolUsed: !!o.rp,
      seed: o.sd || null          // r30 挑战局标记随存档恢复
    };
    S.positions = (o.pos || []).map(function (a) {
      return { code: a[0], shares: a[1], cost: a[2], buyIdx: a[3] };
    });
    S.trades = (o.tr || []).map(function (a) {
      return {
        code: a[0], name: KL.stocks[a[0]] ? KL.stocks[a[0]].name : a[0],
        shares: a[1], cost: a[2], sell: a[3], buyIdx: a[4], sellIdx: a[5],
        pl: a[6], days: a[7], fee: a[8], forced: !!a[9]
      };
    });
    S.equity = (o.eq || []).map(function (v, i) { return { d: DAYS[o.startIdx + i], v: v }; });
    return true;
  }

  // ---------- 在线加载 UI（遮罩 + 进度 + 错误重试） ----------
  var retryFn = null;
  function busy(show, title, sub) {
    var m = el('loading-mask');
    if (!m) return;
    if (show) {
      m.classList.remove('hide');
      if (title) el('loading-title').textContent = title;
      var sb = el('loading-sub'); if (sb && sub) sb.innerHTML = sub;
      var tx = el('loading-txt'); if (tx) tx.textContent = '';
      var er = el('loading-err'); if (er) er.style.display = 'none';
      var f = el('loading-fill'); if (f) f.style.width = '0%';
    } else {
      m.classList.add('hide');
      retryFn = null;
    }
  }
  function busyErr(msg) {
    var er = el('loading-err');
    if (er) {
      er.innerHTML = msg + ' <button id="loading-retry" style="margin-left:6px">点此重试</button>';
      er.style.display = 'block';
      var b = el('loading-retry');
      if (b) b.onclick = function () { if (retryFn) retryFn(); };
    }
  }
  function randStart() {
    var maxStart = TOTAL_BARS - GAME_BARS - 1;
    // r30 种子局的起点优先级最高（只作用本局开局，beginNewSession 取用后立即清空）
    if (SEED_START != null) return Math.max(0, Math.min(TOTAL_BARS - 1, SEED_START));
    // 有自定义起点时优先使用；允许一直选到数据末端附近（不足一整局时游戏到最新一天自动提前结算）
    if (CUR_START != null) return Math.max(0, Math.min(TOTAL_BARS - 1, CUR_START));
    var i = Math.floor(Math.random() * (maxStart + 1));
    return i < 0 ? 0 : i;
  }

  function buildMap(stock) {
    var m = {};
    for (var i = 0; i < stock.d.length; i++) m[stock.d[i]] = i;
    return m;
  }

  // 涨跌停幅度
  function limitOf(code, cat) {
    if (cat === 'st') return 0.05;
    if (/^(30|68)/.test(code)) return 0.20;
    return 0.10;
  }

  // ---------- 开新局 / 在线加载 ----------
  function freshState(startIdx) {
    var s = {
      startIdx: startIdx, curIdx: startIdx, day: 1,
      cash: INIT_CASH, marginDebt: 0, marginUsed: 0,
      positions: [], trades: [], equity: [], map: {},
      pool: [], sel: null, marginUnlocked: false, over: false,
      revealed: false, stats: null, repoolUsed: false,
      seed: null            // r30 挑战种子串：非空 = 本局仍是挑战局（换池/增删股票后置空）
    };
    s.equity.push({ d: DAYS[startIdx], v: INIT_CASH });
    return s;
  }

  // ---------- 股票池体系（M3） ----------
  // 池来源：curSrc = {kind:'uni'|'builtin'|'mine', id}
  var PL = global.GAME_POOLS || { builtin: [] };
  var POOLS_LS = 'sims.pools.v1';
  var curSrc = { kind: 'uni', id: '' };
  var NP_MODAL_OPEN = false;
  var NP_EDIT_ID = null;   // r23 自定义池编辑：非空 = 在编辑现有池（替换 codes/name），空 = 新建

  // ---------- 挑战种子（r30） ----------
  // 把一局「股票池 + 起始交易日」编码成可分享的短串：同一颗种子 = 同一批股票 + 同一段行情，成绩可横向比拼。
  // 位布局（高位→低位）：版本4 | 起始日12 | 代码区 N×20 | 数量5 | 校验8（共 29+20N 位），整体转 base62。
  // 数量字段紧挨校验位：解码时无需知道总长即可从尾部读出 N，再按 N 补全前导零解析版本/起始日/代码。
  // 直接编码 6 位股票代码（而非股票库序号）：股票库日后更新也不会让旧种子失效或错位。
  var SEED_PREFIX = '#我的人生模拟器·A股版';
  var SEED_VER = 1;
  var SEED_MIN = 3, SEED_MAX = 20;
  var SEED_B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  var SEED_BEST_LS = 'sims.seedBest.v1';
  var SEED_START = null;   // 种子局起点：只在开局那一刻生效，用完即清（不影响玩家的自定义起点设置）
  var SEED_BEST_PREV = null;   // 结算前该种子既有最佳快照：用于区分「首次挑战 / 刷新纪录 / 未破纪录」

  function b62Enc(v) {
    if (v === 0n) return '0';
    var out = '';
    while (v > 0n) { out = SEED_B62.charAt(Number(v % 62n)) + out; v = v / 62n; }
    return out;
  }
  function b62Dec(s) {
    var v = 0n;
    for (var i = 0; i < s.length; i++) {
      var d = SEED_B62.indexOf(s.charAt(i));
      if (d < 0) return null;
      v = v * 62n + BigInt(d);
    }
    return v;
  }
  function binW(n, w) {                       // 数字 → 定宽二进制串
    var s = (n >>> 0).toString(2);
    if (s.length > w) s = s.slice(s.length - w);
    while (s.length < w) s = '0' + s;
    return s;
  }
  function seedCheck(bits) {                  // 8 位校验：按字节求和取模 256
    var sum = 0;
    for (var i = 0; i < bits.length; i += 8) sum += parseInt(bits.substr(i, 8), 2);
    return sum % 256;
  }
  function pad6(c) { c = String(c); while (c.length < 6) c = '0' + c; return c; }

  function encodeSeed(codes, startIdx) {
    try {
      var n = codes.length;
      if (n < SEED_MIN || n > SEED_MAX) return null;
      if (!(startIdx >= 0 && startIdx <= 4095)) return null;
      var bits = binW(SEED_VER, 4) + binW(startIdx, 12);
      for (var i = 0; i < n; i++) {
        var c = parseInt(codes[i], 10);
        if (!(c >= 0 && c <= 999999)) return null;
        bits += binW(c, 20);
      }
      bits += binW(n, 5);
      bits += binW(seedCheck(bits), 8);
      return b62Enc(BigInt('0b' + bits));
    } catch (e) { return null; }
  }
  // 解析种子文本（容忍前缀 / # / 空白 / 换行），返回 {codes,startIdx,payload} 或 {err}
  function decodeSeed(text) {
    var t = String(text || '').replace(/\s+/g, '');
    if (!t) return { err: '请先粘贴种子' };
    var m = t.match(/[0-9A-Za-z]{8,}$/);
    if (!m) return { err: '没找到种子编码，请确认复制完整' };
    var payload = m[0];
    var v = b62Dec(payload);
    if (v === null) return { err: '种子含非法字符' };
    var s = v.toString(2);
    if (s.length < 13) return { err: '种子不完整' };
    // 尾部 13 位 = 数量5 + 校验8：先从尾部读出 N，再补全前导零解析其余字段
    var chk = parseInt(s.slice(-8), 2);
    var n = parseInt(s.slice(-13, -8), 2);
    if (!(n >= SEED_MIN && n <= SEED_MAX)) return { err: '种子中标的数量是 ' + n + ' 只（应为 3–20），请确认复制完整' };
    var total = 29 + 20 * n;
    if (s.length > total) return { err: '种子长度异常，可能混入了其它内容' };
    while (s.length < total) s = '0' + s;
    if (seedCheck(s.slice(0, total - 8)) !== chk) return { err: '校验失败：种子可能被截断或改动过' };
    var ver = parseInt(s.slice(0, 4), 2);
    if (ver !== SEED_VER) return { err: '这是 v' + ver + ' 版种子，当前版本还不支持' };
    var startIdx = parseInt(s.slice(4, 16), 2);
    var codes = [];
    for (var i = 0; i < n; i++) codes.push(pad6(parseInt(s.substr(16 + 20 * i, 20), 2)));
    return { codes: codes, startIdx: startIdx, payload: payload };
  }
  function seedMissing(codes) {               // 种子里的代码在当前股票库里缺失的部分
    return codes.filter(function (c) { return !KL.stocks[c]; });
  }
  function seedShareText(payload) { return SEED_PREFIX + ' ' + payload; }

  // 本地最佳成绩（纯静态站无法联网排行，只记录自己在这个种子上的最好成绩）
  function readSeedBest() {
    try { return JSON.parse(localStorage.getItem(SEED_BEST_LS) || '{}') || {}; } catch (e) { return {}; }
  }
  function seedBestOf(payload) {
    var b = readSeedBest();
    return (b[payload] && typeof b[payload].ret === 'number') ? b[payload] : null;
  }
  function saveSeedBest(payload, ret) {
    try {
      var b = readSeedBest();
      var cur = b[payload];
      if (!cur || typeof cur.ret !== 'number' || ret > cur.ret) b[payload] = { ret: ret, ts: Date.now() };
      localStorage.setItem(SEED_BEST_LS, JSON.stringify(b));
      return b[payload];
    } catch (e) { return null; }
  }

  // 用种子开局：固定股票池 + 起始日（简单模式上限 8 只，种子超限自动切复杂模式）
  function startSeedGame(codes, startIdx) {
    if (codes.length > 8 && isEasy()) {
      gameMode = 'full';
      try { localStorage.setItem(MODE_LS, gameMode); } catch (e) {}
      syncModeUI();
    }
    SEED_START = startIdx;
    curSrc = { kind: 'seed', id: 'seed', codes: codes.slice() };
    closeSeedInModal();
    beginNewSession();
  }
  // 换池 / 增删股票 → 作废本局挑战资格（种子清空，成绩不再计入该种子的最佳记录）
  function dropChallenge(msg) {
    if (S && S.seed) {
      S.seed = null;
      saveProgress();
      if (msg) toast(msg);
    }
  }
  // 当前局的种子串（按实际入池标的重编码；无进行中的局则返回 null）
  function currentSeed() {
    if (!S || !S.pool || !S.pool.length) return null;
    return encodeSeed(S.pool.map(function (p) { return p.code; }), S.startIdx);
  }

  // ---------- 种子弹窗 ----------
  function openSeedInModal() {
    var m = el('modal-seed-in');
    if (!m) return;
    var ta = el('seed-input');
    if (ta) ta.value = '';
    renderSeedPreview('');
    m.style.display = 'flex';
    if (ta) setTimeout(function () { try { ta.focus(); } catch (e) {} }, 80);
  }
  function closeSeedInModal() { var m = el('modal-seed-in'); if (m) m.style.display = 'none'; }

  // 输入时实时预览：几只股票、从哪天开始、是否都能在当前股票库里找到
  function renderSeedPreview(text) {
    var box = el('seed-preview');
    if (!box) return;
    var t = String(text || '').replace(/\s+/g, '');
    if (!t) { box.innerHTML = '<span class="seed-dim">粘贴种子后，这里会显示这局有几只股票、从哪一天开始。</span>'; return; }
    var d = decodeSeed(t);
    if (d.err) { box.innerHTML = '<span class="seed-bad">✕ ' + d.err + '</span>'; return; }
    var miss = seedMissing(d.codes);
    var names = d.codes.map(function (c) { return KL.stocks[c] ? KL.stocks[c].name : c + '(缺)'; });
    var d0 = DAYS[d.startIdx] ? fmtDate(DAYS[d.startIdx]) : '第 ' + d.startIdx + ' 个交易日';
    box.innerHTML = '<span class="seed-ok">✓ ' + d.codes.length + ' 只 · 从 ' + d0 + ' 开始</span>' +
      '<div class="seed-names">' + names.join('、') + '</div>' +
      (miss.length ? '<span class="seed-bad">注意：有 ' + miss.length + ' 只不在当前股票库中，无法开局</span>' : '');
  }
  function applySeedInput() {
    var ta = el('seed-input');
    var d = decodeSeed(ta ? ta.value : '');
    if (d.err) { toast(d.err); return; }
    var miss = seedMissing(d.codes);
    if (miss.length) {
      toast('种子中有 ' + miss.length + ' 只不在当前股票库（' + miss.slice(0, 3).join('、') + '），无法开局');
      return;
    }
    startSeedGame(d.codes, d.startIdx);
  }

  function openSeedOutModal() {
    var payload = currentSeed();
    if (!payload) { toast('当前没有进行中的局'); return; }
    var m = el('modal-seed-out');
    if (!m) return;
    var ta = el('seed-out-text');
    var share = seedResultText();
    if (ta) ta.value = share || seedShareText(payload);   // r31：文本域直接是完整分享文案（含收益与沪深300）
    var info = el('seed-out-info');
    if (info) {
      var best = seedBestOf(payload);
      var cur = null;
      if (S.stats && typeof S.stats.totalRet === 'number') cur = S.stats.totalRet;
      else if (!S.over) cur = liveTotalRet();              // r31：进行中也实时显示收益
      var curOk = (cur != null && isFinite(cur));
      info.innerHTML = '<span class="seed-ok">' + S.pool.length + ' 只标的 · 从 ' + fmtDate(DAYS[S.startIdx]) + ' 开始</span>' +
        (curOk
          ? '<div class="seed-score">本局 <b class="' + cls(cur) + '">' + pct(cur) + '</b>' +
            (best ? ' ｜ 历史最佳 <b class="' + cls(best.ret) + '">' + pct(best.ret) + '</b>' : ' ｜ 首次挑战') + '</div>'
          : '');
    }
    m.style.display = 'flex';
  }
  function closeSeedOutModal() { var m = el('modal-seed-out'); if (m) m.style.display = 'none'; }

  function copyText(t, okMsg) {
    var done = function () { toast(okMsg || '已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t, done); });
    } else fallbackCopy(t, done);
  }
  function fallbackCopy(t, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { toast('复制失败，请手动长按选中复制'); }
  }
  // r31：进行中的实时总收益率（与顶栏同口径：总资产 - 本金）
  function liveTotalRet() {
    if (!S) return NaN;
    var eq = equityNow();
    return (eq - INIT_CASH) / INIT_CASH * 100;
  }
  // 分享文案：种子 + 成绩（结算后=我的成绩；游戏进行中=当前收益），均带同期沪深300，不含评级字母
  function seedResultText() {
    var payload = currentSeed();
    if (!payload) return '';
    var ret = null, bench = NaN;
    if (S.stats && typeof S.stats.totalRet === 'number') { ret = S.stats.totalRet; bench = S.stats.benchRet; }
    else if (!S.over) { ret = liveTotalRet(); bench = benchReturn(); }   // r31：进行中按实时口径
    var retTxt = (ret != null && isFinite(ret)) ? pct(ret) : '—';
    var benchTxt = isFinite(bench) ? pct(bench) : '—';
    var head = SEED_PREFIX + ' ' + payload;
    if (!S.over) {
      return head + '\n当前收益：' + retTxt + '（同期沪深300 ' + benchTxt + '）· 第 ' + S.day + ' 个交易日\n来挑战我！';
    }
    return head + '\n我的成绩：' + retTxt + '（同期沪深300 ' + benchTxt + '）\n来挑战我！';
  }

  function uniAllObjs() {
    var arr = [];
    Object.keys(KL.stocks).forEach(function (c) {
      var s = KL.stocks[c];
      arr.push({ code: c, name: s.name, ind: s.ind, cat: s.cat });
    });
    return arr;
  }
  // 全市场 ETF+LOF 候选（D 模式专用：仅场内基金，cat 均为 'etf'，ind='ETF'/'LOF'）
  function etfAllObjs() {
    var arr = [];
    Object.keys(KL.stocks).forEach(function (c) {
      var s = KL.stocks[c];
      if (s.cat === 'etf') arr.push({ code: c, name: s.name, ind: s.ind, cat: s.cat, m: s.m });
    });
    return arr;
  }
  // 展示用分类顺序（需求：白马蓝筹最前 → 妖股 → ST → 周期 → ETF 最后）
  var CAT_ORDER = { white: 0, blue: 1, monster: 2, st: 3, cycle: 4, etf: 5 };
  var CAT_LABEL = { white: '白马', blue: '蓝筹', monster: '妖股', st: 'ST', cycle: '周期', etf: 'ETF' };
  function sortedPool() {
    var a = S && S.pool ? S.pool.slice() : [];
    a.sort(function (x, y) {
      var dx = CAT_ORDER[x.cat] != null ? CAT_ORDER[x.cat] : 9;
      var dy = CAT_ORDER[y.cat] != null ? CAT_ORDER[y.cat] : 9;
      return dx - dy;
    });
    return a;
  }
  function listMinePools() {
    try { return JSON.parse(localStorage.getItem(POOLS_LS) || '[]'); } catch (e) { return []; }
  }
  function saveMinePools(arr) {
    try { localStorage.setItem(POOLS_LS, JSON.stringify(arr)); } catch (e) {}
  }
  function poolLabel(src) {
    if (!src) return '全市场随机';
    if (src.kind === 'seed') return '挑战种子';            // r30
    if (src.kind === 'etf') return '全部 ETF+LOF（D模式）';
    if (src.kind === 'builtin') { for (var i = 0; i < PL.builtin.length; i++) if (PL.builtin[i].id === src.id) return PL.builtin[i].name; }
    if (src.kind === 'mine') { var m = listMinePools(); for (var j = 0; j < m.length; j++) if (m[j].id === src.id) return m[j].name; }
    return '全市场随机';
  }
  // 当前池的候选对象列表（uni = 全市场 5400+ 只）
  function resolveCands(src) {
    src = src || curSrc;
    if (!src || src.kind === 'uni') return uniAllObjs();
    if (src.kind === 'etf') return etfAllObjs();
    if (src.kind === 'seed') {                       // r30 种子局：池即种子里写死的那些代码
      var so = [];
      (src.codes || []).forEach(function (c) {
        var s2 = KL.stocks[c];
        if (s2) so.push({ code: c, name: s2.name, ind: s2.ind, cat: s2.cat });
      });
      return so;
    }
    var codes = null;
    if (src.kind === 'builtin') {
      for (var i = 0; i < PL.builtin.length; i++) if (PL.builtin[i].id === src.id) { codes = PL.builtin[i].codes; break; }
    } else if (src.kind === 'mine') {
      var m = listMinePools();
      for (var j = 0; j < m.length; j++) if (m[j].id === src.id) { codes = m[j].codes; break; }
    }
    var out = [];
    (codes || []).forEach(function (c) {
      var s = KL.stocks[c];
      if (s) out.push({ code: c, name: s.name, ind: s.ind, cat: s.cat });
    });
    return out;
  }
  function candsSize(src) { return resolveCands(src).length; }

  // 从候选池抽 ≤目标只（简单8 / 复杂18）：按分类配额优先，配额抽不满则随机补齐。
  // 全市场随机(uni)保留"同行业≤2"分散约束；主题/自定义池为该主题刻意集中，不套用该约束。
  function samplePool(cands, excludeCodes) {
    excludeCodes = excludeCodes || [];
    var excl = {};
    excludeCodes.forEach(function (c) { excl[c] = 1; });
    var need = isEasy()
      ? [['monster', 1], ['white', 2], ['blue', 1], ['st', 1], ['cycle', 2], ['etf', 1]]
      : [['monster', 3], ['white', 3], ['blue', 3], ['st', 2], ['cycle', 4], ['etf', 3]];
    var byCat = {};
    cands.forEach(function (o) { (byCat[o.cat] = byCat[o.cat] || []).push(o); });
    var pool = [], used = {};
    var isUni = curSrc.kind === 'uni';
    function okInd(o) {
      if (!isUni || o.cat === 'etf') return true;
      var cnt = 0;
      pool.forEach(function (p) { if (p.ind === o.ind) cnt++; });
      return cnt < 2;
    }
    need.forEach(function (pair) {
      var cat = pair[0], n = pair[1];
      var arr = (byCat[cat] || []).filter(function (o) { return !used[o.code] && !excl[o.code]; });
      while (n > 0 && arr.length) {
        var i = Math.floor(Math.random() * arr.length);
        var e = arr.splice(i, 1)[0];
        if (okInd(e)) { pool.push(e); used[e.code] = 1; }
        n--;
      }
    });
    // 补齐到目标只数（允许突破分类配额，保证可玩标的足量）
    var T = poolTarget();
    var rest = cands.filter(function (o) { return !used[o.code] && !excl[o.code]; });
    while (pool.length < T && rest.length) {
      var j = Math.floor(Math.random() * rest.length);
      var r = rest.splice(j, 1)[0];
      if (okInd(r)) { pool.push(r); used[r.code] = 1; }
    }
    return pool;
  }
  // ---------- D 模式（全 ETF + LOF）专用抽池 ----------
  // ETF/LOF 的行业字段都是 'ETF'/'LOF'，无法按行业分散；改为按「名称主题」分类（宽基/消费/医药/半导体…），
  // 轮转抽取且每个主题 ≤2 只，保证一局覆盖多个不同板块的"大盘"，货币现金类（近似持币无波动）直接剔除。
  var ETF_THEMES = [
    { k: '', re: /货币|添益|日利|理财|现金|短融|贴现/, skip: true },
    { k: '跨境海外', re: /纳指|标普|道琼斯|恒生|港股|中概|H股|日经|德国|法国|美国50|沙特|东南亚|亚太|环球/ },
    { k: '黄金商品', re: /黄金|白银|豆粕|原油|有色|资源|商品/ },
    { k: '债券固收', re: /国债|债券|政金|信用债|转债|城投|利率|短债/ },
    { k: '宽基核心', re: /沪深300|中证A50|中证A500|A50|上证50|科创50|科创100|创业板|双创|中证500|中证800|中证1000|中证2000|深证100|深证50|MSCI|国证|A股|全指/ },
    { k: '半导体芯片', re: /半导体|芯片|集成电路/ },
    { k: '军工国防', re: /军工|国防|航天|空天/ },
    { k: '新能源车', re: /新能源车|智能汽车|汽车|锂电池|电池|储能/ },
    { k: '光伏风电', re: /光伏|风电|新能源/ },
    { k: '医药生物', re: /医药|医疗|创新药|生物|疫苗|中药|器械/ },
    { k: '消费食品', re: /消费|白酒|酒|食品|饮料|家电|旅游|农牧|养殖|农业/ },
    { k: '金融地产', re: /证券|券商|银行|保险|金融|地产|基建|建材/ },
    { k: '科技TMT', re: /人工智能|云计算|大数据|机器人|通信|5G|计算机|软件|电子|传媒|游戏|动漫|互联网/ },
    { k: '红利央企', re: /红利|央企|国企|价值|低波|质量/ }
  ];
  function etfTheme(name) {
    for (var i = 0; i < ETF_THEMES.length; i++) {
      if (!ETF_THEMES[i].re.test(name)) continue;
      if (ETF_THEMES[i].skip) return null;
      return ETF_THEMES[i].k;
    }
    return '其他';
  }
  function sampleEtfPool(cands, excludeCodes) {
    var excl = {};
    (excludeCodes || []).forEach(function (c) { excl[c] = 1; });
    var groups = {};
    cands.forEach(function (o) {
      if (excl[o.code]) return;
      var t = etfTheme(o.name);
      if (!t) return;
      (groups[t] = groups[t] || []).push(o);
    });
    var out = [], per = {}, keys = Object.keys(groups), T = poolTarget(), guard = 0;
    while (out.length < T && keys.length && guard++ < 300) {
      var order = keys.slice();
      for (var a = order.length - 1; a > 0; a--) {
        var b = Math.floor(Math.random() * (a + 1));
        var tmp = order[a]; order[a] = order[b]; order[b] = tmp;
      }
      var added = 0;
      order.forEach(function (k) {
        if (out.length >= T) return;
        var g = groups[k];
        if (!g || !g.length) return;
        if ((per[k] || 0) >= 2) return;
        var j = Math.floor(Math.random() * g.length);
        out.push(g.splice(j, 1)[0]);
        per[k] = (per[k] || 0) + 1;
        added++;
      });
      if (!added) break;
    }
    return out;
  }
  function replaceFrom(cands, cat, excludeCodes) {
    var c2 = (cands || []).filter(function (o) { return o.cat === cat && excludeCodes.indexOf(o.code) < 0; });
    if (c2.length) return c2[Math.floor(Math.random() * c2.length)];
    return randByCat(cat, excludeCodes);
  }
  // 全市场抽取（保留原函数名兼容旧调用路径）
  function pickPoolFromUni(excludeCodes) {
    return samplePool(uniAllObjs(), excludeCodes);
  }
  // 从全部(含池)候选中按类别随机（替换补抽用；cands 为空则全市场）
  function randByCat(cat, excludeCodes) {
    var arr = [];
    Object.keys(KL.stocks).forEach(function (c) {
      var s = KL.stocks[c];
      if (s.cat === cat && excludeCodes.indexOf(c) < 0) arr.push({ code: c, name: s.name, ind: s.ind, cat: s.cat });
    });
    if (!arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function loadedOf(code) {
    var s = KL.stocks[code];
    return s && s.d && s.d.length > 0;
  }
  // 拉取成功：把行情回填 KL.stocks，并本地合成筹码帧
  // 注意：统一行格式为 [日期, open, close, high, low, vol]（online.js 内所有源一致）——
  // 回填时 close 取第3列、high 取第4列、low 取第5列，切勿按 o/h/l/c 误读（曾致 close=low、K线几乎全绿）
  function attachK(p, rows) {
    var d = [], o = [], h = [], l = [], c = [], v = [];
    for (var i = 0; i < rows.length; i++) {
      d.push(rows[i][0]); o.push(rows[i][1]);
      c.push(rows[i][2]); h.push(rows[i][3]); l.push(rows[i][4]); v.push(rows[i][5]);
    }
    var st = KL.stocks[p.code];
    st.d = d; st.o = o; st.h = h; st.l = l; st.c = c; st.v = v;
    st._dmap = null;   // 清缓存
    var chips = OL.synthChips(st, 60);
    if (chips) CH.stocks[p.code] = chips;
  }

  // 确保一组标的数据就绪：未拉过的联网获取；新股池若拉取失败/未上市/停摆，则按 cat 补抽替换（allowReplace）
  async function ensureData(poolObjs, startIdx, allowReplace, onProg, cands) {
    var final = poolObjs.slice();
    for (var round = 0; round < 4; round++) {
      var pend = final.filter(function (p) { return !loadedOf(p.code); });
      if (!pend.length) return { pool: final, bad: [] };
      var res = await OL.fetchMany(pend.map(function (p) { return p.code; }), 6, onProg);
      var bad = [];
      pend.forEach(function (p) {
        var rows = res[p.code];
        if (!rows || rows.length < 20 || rows[0][0] > DAYS[startIdx] ||
            rows[rows.length - 1][0] < DAYS[startIdx]) { bad.push(p); return; }
        attachK(p, rows);
      });
      if (!bad.length) return { pool: final, bad: [] };
      if (!allowReplace || round >= 3) return { pool: final, bad: bad };
      var excl = final.map(function (p) { return p.code; });
      var rep = [];
      bad.forEach(function (b) {
        var c2 = replaceFrom(cands, b.cat, excl);
        if (c2) { rep.push(c2); excl.push(c2.code); }
      });
      if (!rep.length) return { pool: final, bad: bad };
      final = final.map(function (p) { return bad.indexOf(p) >= 0 ? rep.shift() : p; });
    }
    return { pool: final, bad: [] };
  }

  // C 模式（自定义勾选 ≤MAX_PICK、全量纳入）为「神圣池」：用户勾了什么就该玩什么，
  // 个别标的一旦无法获取行情（退市/停摆/无K线），直接剔除并提示，而不是全市场随机替换、更不整局阻断。
  // 返回 null 表示剔除后仍可开局（可继续用 r.pool 流程）；返回字符串则为阻断错误信息。
  function sacredBadHandle(r, pool) {
    var badN = r.bad.map(function (b) { return b.name; }).join('、');
    var kept = pool.filter(function (p) { return r.bad.indexOf(p) < 0; });
    var mn3 = (curSrc && (curSrc.kind === 'mine' || curSrc.kind === 'seed')) ? MIN_MINE : modeMin();   // r25 自定义池兜底下限 3 只；r30 种子局同（3–20 只种子自身保证）
    if (kept.length >= mn3) { r.pool = kept; r.bad = []; return null; }
    return '你勾选的标的无法获取行情：' + badN + '。剔除后仅剩 ' + kept.length + ' 只（需 ≥' + mn3 + '）无法开局，请返回重新勾选。';
  }
  // 开新局：清档 → 抽池（A/B 抽 poolTarget 只；C 自定义 ≤上限全量纳入）→ 在线拉数 → 进入选股屏
  async function beginNewSession() {
    clearSave();
    var label = poolLabel(curSrc), size = candsSize(curSrc);
    busy(true, '正在抽取标的', '池来源：<b>' + label + '</b>（候选 ' + size + ' 只）→ ' + pickTxt(curSrc, size) + ' 并获取 5 年日K：静态库CDN/东财/腾讯多源级联+本地缓存（重复游玩秒开）…');
    var startIdx = randStart();
    SEED_START = null;              // r30：种子起点只用于本局开局，用完即清（不影响玩家的自定义起点）
    var cands = resolveCands(curSrc);
    var mn = (curSrc && (curSrc.kind === 'mine' || curSrc.kind === 'seed')) ? MIN_MINE : modeMin();   // r25 自定义池 ≥3 即可开局；r30 种子局同（3–20 只种子自身保证）
    if (cands.length < mn) { retryFn = beginNewSession; return busyErr('当前池有效标的仅 ' + cands.length + ' 只，不足 ' + mn + ' 只无法开局。请换一个池或在「＋新建自定义池」中建更大的池。'); }
    var pool = openingPool(cands);
    if (pool.length < mn) { retryFn = beginNewSession; return busyErr('当前池可抽取标的不足 ' + mn + ' 只，无法开局。请换一个池或新建更大的池。'); }
    // 神圣池（C 模式全量纳入）不可替换，坏标的自留剔除；随机池（uni/builtin）交给 ensureData 按类别补抽替换
    // r30：种子局同样是「神圣池」——池就是种子写死的那些，个别标的拉不到数就剔除，不用随机股替换
    var sacred = (curSrc.kind === 'seed') || (curSrc.kind === 'mine' && pool.length === cands.length && cands.length <= pickCap());
    var r = await ensureData(pool, startIdx, !sacred, onProg, cands);
    if (r.bad && r.bad.length) {
      if (sacred) {
        var dropMsg = sacredBadHandle(r, pool);
        if (dropMsg) { retryFn = beginNewSession; return busyErr(dropMsg); }
      } else if (curSrc.kind === 'etf') {
        // D 全ETF：部分新上市基金历史不足 5 年被判坏——剔除后仍够开局就继续，不整局阻断
        var keptE = r.pool.filter(function (p) { return r.bad.indexOf(p) < 0; });
        if (keptE.length < modeMin()) {
          retryFn = beginNewSession;
          return busyErr('多数 ETF 无法获取足够历史行情，请重试或换玩法。');
        }
        toast('以下 ETF 无足够历史行情，已自动剔除：' + r.bad.map(function (b) { return b.name; }).join('、'));
        r.pool = keptE; r.bad = [];
      } else {
        // r32：随机池/大自定义池个别标的一时拉不到（外部源卡死/无足够历史）→ 剔除放行，保住开局；剩余不足底线才阻断
        var keptG = r.pool.filter(function (p) { return r.bad.indexOf(p) < 0; });
        if (keptG.length < mn) {
          retryFn = beginNewSession;
          return busyErr('多数标的无法获取行情，仅 ' + keptG.length + ' 只成功（需 ≥' + mn + '）。请检查网络后点此重试。');
        }
        toast('以下标的无法获取足够行情，已自动剔除：' + r.bad.map(function (b) { return b.name; }).join('、') + '。本局继续。');
        r.pool = keptG; r.bad = [];
      }
    }
    busy(false);
    S = freshState(startIdx);
    S.pool = r.pool;
    S.sel = r.pool[0].code;
    S.map = {};
    S.pool.forEach(function (p) { S.map[p.code] = buildMap(KL.stocks[p.code]); });
    // r30：本局 = 一颗可分享的种子（股票池代码 + 起始日）。换池/局内增删股票会作废挑战（见 dropChallenge）
    S.seed = encodeSeed(S.pool.map(function (p) { return p.code; }), startIdx) || null;
    if (curSrc.kind === 'seed' && !S.seed) { retryFn = beginNewSession; return busyErr('本局标的无法编码成挑战种子，请重新开局。'); }
    if (sacred && pool.length !== r.pool.length) {
      toast('以下标的无法获取行情，已自动剔除：' + pool.filter(function (p) { return r.pool.indexOf(p) < 0; }).map(function (p) { return p.name; }).join('、'));
    }
    renderSelect();
  }
  // 兜底：存档无法恢复时回到开局模式选择（v4：不再直接随机开局，避免绕开三选一）
  function backToModeSelect(msg) {
    clearSave();
    var rb0 = el('btn-resume'); if (rb0) rb0.style.display = 'none';
    busy(false);
    if (msg) toast(msg);
    openModeModal();
  }
  // 开局池生成：mine 自定义池 ≤pickCap（≤上限）只 → 全部纳入（用户勾选即所选即所玩，不丢弃所选）；
  // 其余（uni / builtin / 超过上限的自定义池）→ samplePool 按分类配额抽 poolTarget 只
  function openingPool(cands) {
    if (curSrc.kind === 'seed') return cands.slice();   // r30 种子局：原样全纳入，顺序即种子顺序（不洗牌）
    if (curSrc.kind === 'mine' && cands.length <= pickCap()) {
      var a = cands.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }
    if (curSrc.kind === 'etf') return sampleEtfPool(cands, []);
    return samplePool(cands, []);
  }
  // 抽取环节的进度文案
  function pickTxt(src, size) {
    if (src.kind === 'seed') return '种子 ' + size + ' 只全部纳入';   // r30
    if (src.kind === 'mine' && size <= pickCap()) return '所选 ' + size + ' 只全部纳入';
    if (size < poolTarget()) return '仅 ' + size + ' 只，全部纳入';
    return '抽取 ≤' + poolTarget() + ' 只';
  }

  // 续档：按存档股票池拉数（不替换）后恢复
  async function beginResume() {
    var o = readSave();
    if (!o) { clearSave(); var rb0 = el('btn-resume'); if (rb0) rb0.style.display = 'none'; toast('没有可用存档'); return; }
    var objs = o.pool.filter(function (c) { return KL.stocks[c]; });
    if (objs.length !== o.pool.length) { backToModeSelect('存档标的已失效，请重新选择玩法'); return; }
    busy(true, '正在读取存档', '正在获取存档内 ' + (o.pool ? o.pool.length : 'N') + ' 只标的历史行情（命中本地缓存将秒开）…');
    var r = await ensureData(objs.map(function (c) { var s = KL.stocks[c]; return { code: c, name: s.name, ind: s.ind, cat: s.cat }; }),
      o.startIdx, false, onProg);
    if (r.bad && r.bad.length) { backToModeSelect('存档部分标的无行情，请重新选择玩法'); return; }
    busy(false);
    if (loadProgress()) { startGame(); toast('已读取上次存档'); }
    else backToModeSelect('存档异常，请重新选择玩法');
  }
  function onProg(done, total, code) {
    var name = KL.stocks[code] ? KL.stocks[code].name : code;
    el('loading-txt').textContent = '正在获取 ' + name + '（' + code + '）' + done + '/' + total;
    var f = el('loading-fill');
    if (f) f.style.width = (done / total * 100) + '%';
  }

  // ---------- 选股界面 ----------
  var panelSel = ['nasdaq_etf', 'hs300', 'zz2000'];   // 面板2/3/4 默认
  var selCharts = [], selChip = null;

  function renderSelect() {
    el('screen-select').style.display = 'block';
    el('screen-game').style.display = 'none';
    el('screen-settle').style.display = 'none';
    el('start-info').innerHTML = '起始日 ' + (HIDE ? '<b class="hid">????-??-??</b>（已隐藏）'
      : fmtDate(DAYS[S.curIdx])) + ' · 本金 ' + money(INIT_CASH);

    // 股票列表（分类排序展示：白马蓝筹→妖股→ST→周期→ETF，同类保持抽取顺序）
    var html = '';
    var etfN = 0;
    sortedPool().forEach(function (p) {
      var i = S.map[p.code][DAYS[S.curIdx]];
      var st = KL.stocks[p.code];
      var px = i != null ? st.c[i] : null;
      if (p.cat === 'etf') etfN++;
      html += '<div class="pool-item' + (p.code === S.sel ? ' on' : '') + '" data-code="' + p.code + '">' +
        '<div class="pi-name">' + p.name + '<span class="tag t-' + p.cat + '">' +
        ({ white: '白马', blue: '蓝筹', monster: '妖股', st: 'ST', cycle: '周期', etf: 'ETF' })[p.cat] + '</span></div>' +
        '<div class="pi-code">' + p.ind + '</div>' +
        '<div class="pi-px">' + (px != null ? px.toFixed(2) : '停牌') + '</div></div>';
    });
    el('pool-list').innerHTML = html;
    Array.prototype.forEach.call(el('pool-list').children, function (node) {
      node.onclick = function () { S.sel = node.getAttribute('data-code'); renderSelect(); };
    });
    var hint = el('pool-count-hint');
    if (hint) hint.innerHTML = '本局可交易 <b>' + S.pool.length + '</b> 只（含 ' + etfN + ' 只ETF · 池：' + poolLabel(curSrc) + (curSrc.kind === 'uni' ? ' · 同行业≤2' : '') + '）';

    // r30/r31 开始交易前：选股屏亮出本局种子（股票池+起始日已定）——r31 起不展示种子串，只给复制按钮+提示，放「开始你的交易人生」按钮下方一栏
    var ssd = el('sel-seed');
    if (ssd) {
      var sp2 = (!S.over) ? currentSeed() : null;
      if (sp2) {
        ssd.style.display = 'flex';
        ssd.innerHTML = '<span class="ss-lb">🎯 本局种子</span>' +
          '<button id="ss-copy-sel" title="复制本局种子，发给朋友即可同局挑战">复制本局种子</button>' +
          '<span class="ss-hint">可复制种子和朋友一起挑战</span>';
        var cb = el('ss-copy-sel');
        if (cb) cb.onclick = function () { copyText(seedShareText(sp2), '种子已复制，发给朋友挑战吧'); };
      } else ssd.style.display = 'none';
    }

    // 4 面板
    if (!selCharts.length) {
      for (var i = 0; i < 4; i++) {
        var cv = el('sel-cv' + i);
        selCharts.push(new ChartEng.KChart(cv, { subs: i === 0 ? ['vol', 'macd'] : ['vol'], maPad: false, pxTag: false }));
      }
    }
    syncPoolUI();
    drawSelPanels();
  }

  function drawSelPanels() {
    if (!S) return;
    // 手机(<880)单列全宽；桌面双列各半宽
    var w = el('sel-panels').clientWidth;
    w = isNarrow() ? w - 2 : w / 2 - 12;
    // 与主图规则一致：高度不超宽度（最高 1:1），避免细长画布
    var h = Math.max(80, Math.min(200, w));
    var idxOf = function (code) { return S.map[code] ? S.map[code][DAYS[S.curIdx]] : null; };
    // 面板1：当前股票（显示到起始日）
    var st = KL.stocks[S.sel], ei = idxOf(S.sel);
    if (ei == null) ei = lastIdxBefore(S.sel, DAYS[S.curIdx]);
    selCharts[0].resize(w, h);
    selCharts[0].opts.title = st.name;
    selCharts[0].opts.baseIdx = HIDE ? startAnchorFor(S.sel, st, DAYS[S.startIdx]) : null;
    selCharts[0].setData(st, ei);
    for (var i = 1; i < 4; i++) {
      var ix = seriesOf(panelSel[i - 1]) || IX.hs300;
      var ii = seriesEndIdx(ix, DAYS[S.curIdx]);
      selCharts[i].resize(w, h);
      selCharts[i].opts.title = ix.name;
      selCharts[i].opts.baseIdx = HIDE ? seriesEndIdx(ix, DAYS[S.startIdx]) : null;   // 指数序列锚定开局日(T0)
      selCharts[i].setData(ix, ii);
    }
  }

  // ---------- 池来源工具栏 / 自定义池 ----------
  function poolKey(src) { return (src.kind || 'uni') + ':' + (src.id || ''); }
  function poolFromKey(key) {
    var p = String(key || 'uni:').split(':');
    return { kind: p[0] || 'uni', id: p[1] || '' };
  }
  function fillPoolOptions() {
    var node = el('pool-src');
    if (!node) return;
    var total = Object.keys(KL.stocks).length;
    var etfN = etfAllObjs().length;
    var h = '<option value="uni:">全市场随机（' + total + ' 只）</option>';
    h += '<option value="etf:">全部 ETF + LOF（' + etfN + ' 只）</option>';
    var b = PL.builtin || [];
    if (b.length) {
      h += '<optgroup label="内置池">';
      for (var i = 0; i < b.length; i++) h += '<option value="builtin:' + b[i].id + '">' + b[i].name + '（' + b[i].codes.length + '）</option>';
      h += '</optgroup>';
    }
    var mine = listMinePools();
    if (mine.length) {
      h += '<optgroup label="我的池">';
      for (var j = 0; j < mine.length; j++) h += '<option value="mine:' + mine[j].id + '">' + mine[j].name + '（' + mine[j].codes.length + '）</option>';
      h += '</optgroup>';
    }
    node.innerHTML = h;
  }
  function syncPoolUI() {
    var node = el('pool-src');
    if (!node) return;
    fillPoolOptions();
    node.value = poolKey(curSrc);
    var dd = el('pool-desc'), del = el('btn-delpool');
    var size = candsSize(curSrc), total = Object.keys(KL.stocks).length;
    var tgt = poolTarget(), cap = pickCap(), mn4 = (curSrc.kind === 'mine') ? 3 : modeMin();   // r23 自定义池下限 3 只
    if (dd) {
      if (curSrc.kind === 'etf') {
        dd.innerHTML = '全市场 <b>' + size + '</b> 只场内 ETF + LOF（货币现金类已剔除），按<b>名称主题</b>分散抽取（宽基/消费/医药/半导体/军工…每主题≤2），专注板块轮动。当前 ' +
          (isEasy() ? '简单 · 抽 8 只' : '复杂 · 抽 18 只');
      } else if (curSrc.kind === 'uni') {
        dd.innerHTML = '全市场 ' + total + ' 只中随机抽取，当前 <b>' + (isEasy() ? '简单（8 只）' : '复杂（18 只）') +
          '</b>，分类配比（妖/白/蓝/周期/ST/ETF），同行业≤2 分散';
      } else if (curSrc.kind === 'builtin') {
        var bd = '';
        for (var i = 0; i < (PL.builtin || []).length; i++) if (PL.builtin[i].id === curSrc.id) bd = PL.builtin[i].desc;
        dd.innerHTML = bd + (size < tgt
          ? '　<span style="color:#f0b90b">仅 ' + size + ' 只，开局抽全部</span>'
          : '　<span style="color:#8b949e">当前 ' + (isEasy() ? '简单 · 抽 8 只' : '复杂 · 抽 18 只') + '</span>');
      } else if (curSrc.kind === 'seed') {   // r30
        dd.innerHTML = '🎯 挑战种子局：种子里写死的 ' + size + ' 只标的全部纳入，牌面与起点固定不变（换池按钮不可用，结算成绩按种子记录最佳）';
      } else {
        var md = '';
        var mine = listMinePools();
        for (var j = 0; j < mine.length; j++) if (mine[j].id === curSrc.id) md = mine[j].name;
        var tail;
        if (size < mn4) tail = '　<span style="color:#ff7b72">不足' + mn4 + '只，无法开局</span>';
        else if (size <= cap) tail = '　<span style="color:#f0b90b">≤' + cap + ' 只全部纳入</span>';
        else tail = '　<span style="color:#f0b90b">超过 ' + cap + ' 只，抽 ≤' + tgt + '</span>';
        dd.innerHTML = '我的自定义池：' + md + '（有效 ' + size + ' 只）' + tail +
          '　<span style="color:#8b949e">当前 ' + (isEasy() ? '简单模式' : '复杂模式') + '</span>';
      }
    }
    if (del) del.style.display = curSrc.kind === 'mine' ? '' : 'none';
    var editBtn = el('btn-editpool');
    if (editBtn) editBtn.style.display = curSrc.kind === 'mine' ? '' : 'none';
  }
  function openNewPoolModal(editId) {
    el('modal-newpool').style.display = 'flex';
    el('np-status').className = '';
    el('np-status').textContent = '';
    var nameEl = el('np-name'), codesEl = el('np-codes'), okBtn = el('np-ok');
    nameEl.value = ''; codesEl.value = '';
    if (editId) {
      var mine = listMinePools();
      var entry = mine.filter(function (p) { return p.id === editId; })[0];
      if (entry) {
        NP_EDIT_ID = editId;
        nameEl.value = entry.name;
        codesEl.value = (entry.codes || []).join('\n');
        if (okBtn) okBtn.textContent = '保存修改';
      } else {
        NP_EDIT_ID = null;
        if (okBtn) okBtn.textContent = '保存池';
      }
    } else {
      NP_EDIT_ID = null;
      if (okBtn) okBtn.textContent = '保存池';
    }
    var nr = el('np-rule');
    if (nr) nr.innerHTML = '粘贴 6 位股票代码，可用逗号 / 空格 / 换行分隔。系统会用全市场清单校验有效性。<b>池内 ≥3 只即可开局，无上限</b>（按经验推荐 5–20 只）。';
    NP_MODAL_OPEN = true;
    setTimeout(function () { el('np-name').focus(); }, 50);
  }
  function closeNewPoolModal() {
    el('modal-newpool').style.display = 'none';
    NP_MODAL_OPEN = false;
    NP_EDIT_ID = null;
    var okBtn = el('np-ok'); if (okBtn) okBtn.textContent = '保存池';
  }
  function saveNewPool() {
    var name = (el('np-name').value || '').trim();
    var raw = el('np-codes').value;
    var codes = raw.match(/[0-9]{6}/g) || [];
    var seen = {}, valid = [], bad = 0;
    codes.forEach(function (c) {
      if (seen[c]) return;
      seen[c] = 1;
      if (KL.stocks[c]) valid.push(c); else bad++;
    });
    var st = el('np-status');
    var MIN_MINE = 3;   // r23 自定义池下限：3 只即可开局，无上限
    if (valid.length < MIN_MINE) {
      st.className = 'bad';
      st.textContent = '有效代码仅 ' + valid.length + ' 只（需 ≥' + MIN_MINE + '，无效 ' + bad + ' 个）。请补充或修正。';
      return;
    }
    var mine = listMinePools();
    var stMsg;
    if (NP_EDIT_ID) {
      // 编辑现有池：替换 codes/name/ts；不动当前局，下一局自动用新 codes 重抽
      var hit = -1;
      for (var i = 0; i < mine.length; i++) if (mine[i].id === NP_EDIT_ID) { hit = i; break; }
      if (hit < 0) { st.className = 'bad'; st.textContent = '未找到该池，可能已被删除。'; return; }
      mine[hit].name = name || mine[hit].name;
      mine[hit].codes = valid;
      mine[hit].ts = Date.now();
      saveMinePools(mine);
      closeNewPoolModal();
      toast('自定义池「' + mine[hit].name + '」已更新为 ' + valid.length + ' 只');
      syncPoolUI();
      // r25：游戏进行中 → 直接把编辑结果应用到本局（加股拉数入池/减股需无持仓）；否则回到选股屏阶段重抽预览
      if (inGameSession()) applyMinePoolToGame(mine[hit].codes);
      else if (curSrc && curSrc.kind === 'mine' && curSrc.id === NP_EDIT_ID) applyPoolChange({ kind: 'mine', id: NP_EDIT_ID });
      return;
    }
    var id = 'm' + Date.now().toString(36);
    var uname = name || ('我的池' + (mine.length + 1));
    mine.push({ id: id, name: uname, codes: valid, ts: Date.now() });
    saveMinePools(mine);
    closeNewPoolModal();
    toast('自定义池「' + uname + '」已保存（' + valid.length + ' 只），开始抽取…');
    applyPoolChange({ kind: 'mine', id: id });
  }
  // 按池抽取：override 提供池源（新建/删除后直接指定）；下拉框 onchange 传 null
  // r25：局内「增删本池股票」辅助 -------------------------------------------------
  function nmOf(code) { return (KL.stocks[code] || {}).name || code; }
  function inGameSession() {
    var sg = el('screen-game');
    return !!(S && S.pool && S.pool.length && !S.over && sg && getComputedStyle(sg).display !== 'none');
  }
  // 把编辑后的 mine 池 codes 应用到进行中的对局：加股立即拉数入池；减股需该股无持仓
  async function applyMinePoolToGame(codes) {
    if (!inGameSession()) return;
    var have = S.pool.map(function (p) { return p.code; });
    var delC = have.filter(function (c) { return codes.indexOf(c) < 0; });
    var held = delC.filter(function (c) { return S.positions.some(function (x) { return x.code === c && x.shares > 0; }); });
    if (held.length) { toast('「' + held.map(nmOf).join('、') + '」已有持仓，请先卖出再移出自选池'); return; }
    var addC = codes.filter(function (c) { return have.indexOf(c) < 0; });
    var objs = addC.filter(function (c) { return !!KL.stocks[c]; })
      .map(function (c) { return { code: c, name: nmOf(c), cat: (KL.stocks[c] || {}).cat || 'white' }; });
    var missing = addC.filter(function (c) { return !KL.stocks[c]; });
    if (missing.length) toast('以下代码不在股票库中，已忽略：' + missing.join('、'));
    if (objs.length) {
      busy(true, '正在拉取新增股票行情', objs.map(function (o) { return o.name; }).join('、') + ' …');
      var r = await ensureData(objs, S.startIdx, false, onProg, objs);
      busy(false);
      if (r.bad && r.bad.length) { toast('无法获取行情：' + r.bad.map(function (b) { return b.name; }).join('、') + '，本次未增删。'); return; }
    }
    dropChallenge('已改动股票池，本局不再计入挑战成绩');   // r30：动了池就退出挑战
    objs.forEach(function (o) { if (have.indexOf(o.code) < 0) S.pool.push(o); });
    if (delC.length) S.pool = S.pool.filter(function (p) { return codes.indexOf(p.code) >= 0; });
    S.map = {};
    S.pool.forEach(function (p) { S.map[p.code] = buildMap(KL.stocks[p.code]); });
    if (codes.indexOf(S.sel) < 0) S.sel = S.pool[0] ? S.pool[0].code : null;
    fillMultiAdds();
    if (multiOn) renderMulti();
    renderGame();
    saveProgress();
    var pn = el('hd-pool-n'); if (pn) pn.textContent = S.pool.length + '只';
    toast('自选池已更新为 ' + S.pool.length + ' 只');
    syncPoolOps();
  }
  function syncPoolOps() {
    var o = el('pool-ops-bar');
    if (o) o.style.display = (curSrc && curSrc.kind === 'mine' && inGameSession()) ? 'block' : 'none';
  }
  // r25：局内增删入口按钮点击 → 打开当前自定义池编辑器
  function openMinePoolEditor() {
    if (curSrc && curSrc.kind === 'mine') openNewPoolModal(curSrc.id);
  }
  async function applyPoolChange(override) {
    var sel = el('pool-src');
    var src = override || (sel ? poolFromKey(sel.value) : curSrc);
    curSrc = src;
    var cands = resolveCands(src);
    if (!cands.length) { syncPoolUI(); toast('该池暂无有效标的'); return; }
    busy(true, '正在按池抽取', '池来源：<b>' + poolLabel(src) + '</b>（候选 ' + cands.length + ' 只），' + pickTxt(src, cands.length) + '并获取行情…');
    var mn2 = (src.kind === 'mine' || src.kind === 'seed') ? 3 : modeMin();   // r23 自定义池放宽 ≥3；r30/r32 种子局同（3–20 只种子自身保证）
    if (cands.length < mn2) { busy(false); toast('该池有效标的不足 ' + mn2 + ' 只，无法开局'); syncPoolUI(); return; }
    var startIdx = S ? S.startIdx : randStart();
    var pool = openingPool(cands);
    if (pool.length < mn2) { busy(false); toast('该池可抽取标的不足 ' + mn2 + ' 只'); syncPoolUI(); return; }
    // 神圣池（种子局 / C 模式全量纳入）不可替换，坏标的自留剔除；随机池交给 ensureData 按类别补抽替换
    var sacred = (src.kind === 'seed') || (src.kind === 'mine' && pool.length === cands.length && cands.length <= pickCap());
    var r = await ensureData(pool, startIdx, !sacred, onProg, cands);
    if (r.bad && r.bad.length) {
      if (sacred) {
        var dropMsg = sacredBadHandle(r, pool);
        if (dropMsg) { busy(false); syncPoolUI(); return toast(dropMsg); }
      } else {
        // r32：随机池/大自定义池个别标的一时拉不到 → 剔除放行；剩余不足底线才阻断
        var kept2 = r.pool.filter(function (p) { return r.bad.indexOf(p) < 0; });
        if (kept2.length < mn2) {
          busy(false);
          retryFn = applyPoolChange;
          return busyErr('多数标的无法获取行情，仅 ' + kept2.length + ' 只成功（需 ≥' + mn2 + '）。可切换池来源或点此重试。');
        }
        toast('以下标的无法获取足够行情，已自动剔除：' + r.bad.map(function (b) { return b.name; }).join('、') + '。本局继续。');
        r.pool = kept2; r.bad = [];
      }
    }
    busy(false);
    S.pool = r.pool;
    S.sel = r.pool[0].code;
    S.map = {};
    S.pool.forEach(function (p) { S.map[p.code] = buildMap(KL.stocks[p.code]); });
    // r30：开局前切换池来源 → 按新牌面重编本局种子（还在选股屏、未开始交易时）
    if (S && !S.over) S.seed = encodeSeed(S.pool.map(function (p) { return p.code; }), S.startIdx) || null;
    if (sacred && pool.length !== r.pool.length) {
      toast('以下标的无法获取行情，已自动剔除：' + pool.filter(function (p) { return r.pool.indexOf(p) < 0; }).map(function (p) { return p.name; }).join('、'));
    }
    renderSelect();
  }
  function delCurrentMinePool() {
    if (curSrc.kind !== 'mine') return;
    var mine = listMinePools();
    for (var i = 0; i < mine.length; i++) {
      if (mine[i].id === curSrc.id) {
        var nm = mine[i].name;
        mine.splice(i, 1);
        saveMinePools(mine);
        toast('已删除自定义池「' + nm + '」，回到全市场随机');
        syncPoolUI();
        applyPoolChange({ kind: 'uni', id: '' });
        return;
      }
    }
  }

  // ---------- 选项下拉 ----------
  function fillSelect(node, cur) {
    var h = '';
    IDX_OPTIONS.forEach(function (o) {
      h += '<option value="' + o.k + '"' + (o.k === cur ? ' selected' : '') + '>' + o.n + '</option>';
    });
    node.innerHTML = h;
  }

  function buildPanelSelects() {
    var h = '';
    for (var i = 1; i < 4; i++) {
      h += '<select id="sel-ix' + i + '">';
      IDX_OPTIONS.forEach(function (o, k) {
        h += '<option value="' + o.k + '"' + (o.k === panelSel[i - 1] ? ' selected' : '') + '>' + o.n + '</option>';
      });
      h += '</select>';
    }
    el('panel-sels').innerHTML = h;
    for (var i = 1; i < 4; i++) {
      (function (i) {
        el('sel-ix' + i).onchange = function () {
          panelSel[i - 1] = this.value; drawSelPanels();
        };
      })(i);
    }
  }

  // ---------- 开局模式选择（v5：A内置精选 / B全市场随机 / C自定义勾选） ----------
  var MAX_PICK = 20;                                        // C 模式自定义勾选上限（≤20 只全部纳入）
  var MIN_MINE = 3;                                         // r25 自定义池/自选勾选 最低可开局只数（不限上限）
  var PK = { all: [], shown: 0, sel: {}, query: '', ind: '', cat: 'all' };   // 自定义勾选器状态；cat='all'|white|…|sel
  var PICK_PAGE = 400;

  // ---------- 开局数量模式（v15：简单 8 只 / 复杂 18 只，默认复杂；localStorage 持久化） ----------
  var MODE_LS = 'sims.gameMode';
  var gameMode = (function () {
    try { return localStorage.getItem(MODE_LS) === 'easy' ? 'easy' : 'full'; } catch (e) { return 'full'; }
  })();
  function isEasy() { return gameMode === 'easy'; }
  function poolTarget() { return isEasy() ? 8 : 18; }        // A/B 自动抽取目标只数
  function modeMin() { return isEasy() ? 6 : 10; }           // A/B/D 随机抽取开局最低只数（mine/自选单独用 MIN_MINE）
  function pickCap() { return isEasy() ? 8 : MAX_PICK; }     // C 勾选上限 / 「全部纳入」阈值
  function poolModeTxt() { return isEasy() ? '简单模式 · 每局限 8 只' : '复杂模式 · 每局 18 只（默认）'; }
  function pickRangeTxt() { return '3–' + pickCap(); }       // r25 自选勾选下限 3 只、上限随模式

  // 开局模式卡对应的池源
  function modeToSrc(mode) {
    if (mode === 'a') return { kind: 'builtin', id: 'legacy' };   // A：上版精选130股+20ETF
    if (mode === 'c') return null;
    if (mode === 'd') return { kind: 'etf', id: '' };              // D：全 ETF+LOF（仅场内基金）
    return { kind: 'uni', id: '' };                                // B（及默认）：全市场随机
  }
  function openModeModal() {
    var rs = el('btn-mode-resume');
    if (rs) rs.style.display = canResume() ? '' : 'none';
    syncModeUI();
    el('modal-mode').style.display = 'flex';
  }
  function closeModeModal() { el('modal-mode').style.display = 'none'; }
  // 模式开关相关 UI 文案全量同步（弹窗每次打开 + 点击切换时调用）
  function syncModeUI() {
    var easy = isEasy();
    var sm = el('mode-simple'), cx = el('mode-complex');
    if (sm) sm.className = 'mm-chip' + (easy ? ' on' : '');
    if (cx) cx.className = 'mm-chip' + (easy ? '' : ' on');
    var sub = el('mm-sub');
    if (sub) sub.innerHTML = '选择本局要交易的「股票池」。<br>不同股票池，会决定你这局遇到什么样的市场。' +
      '<br><b style="color:var(--text)">默认是「' + (easy ? '简单模式 · 8 只' : '复杂模式 · 18 只') + '」</b>：A / B / D 会自动抽取 <b style="color:var(--text)">' + poolTarget() +
      '</b> 只标的；C 模式则由你自己选择。<br>' +
      '选定股票池后，将自动获取对应标的近 <b style="color:var(--text)">5 年日 K</b> 数据。<br>电脑、手机均可游玩，开局后也可以随时更换股票池。';
    var ca = el('mc-a-cnt'), cb = el('mc-b-cnt'), cc = el('mc-c-cnt'), cd = el('mc-d-cnt');
    if (ca) ca.textContent = '候选 ' + candsSize({ kind: 'builtin', id: 'legacy' }) + ' → 抽取 ' + poolTarget();
    if (cb) cb.textContent = '候选 ' + Object.keys(KL.stocks).length + ' → 抽取 ' + poolTarget();
    if (cc) cc.textContent = '选择 ' + pickRangeTxt() + ' 只 → 全部开局';
    if (cd) cd.textContent = '候选 ' + etfAllObjs().length + ' → 抽取 ' + poolTarget();
    var hi = el('mm-mode-hint');
    if (hi) hi.innerHTML = easy
      ? '每局只面对 <b>8</b> 只标的，决策面小，适合快速上手。'
      : '默认使用<b>复杂模式</b>，每局 <b>18</b> 只标的。标的越多，覆盖的板块与风格越丰富，市场也会更接近真实交易环境。';
  }
  // 点击“简单/复杂”切换：持久化并立即刷新弹窗文案
  function setGameMode(m) {
    var toEasy = (m === 'easy');
    if (toEasy === isEasy()) return;
    gameMode = toEasy ? 'easy' : 'full';
    try { localStorage.setItem(MODE_LS, gameMode); } catch (e) {}
    syncModeUI();
    toast(isEasy() ? '已切换：简单模式（每局 8 只标的）' : '已切换：复杂模式（每局 18 只标的）');
  }
  function modeDesc(mode) {
    if (mode === 'a') return poolDescOf({ kind: 'builtin', id: 'legacy' });
    if (mode === 'c') return '自定义勾选：从全市场勾选 ' + pickRangeTxt() + ' 只组成专属池';
    if (mode === 'd') return '全ETF+LOF：候选 ' + etfAllObjs().length + ' 只，按主题分散抽取';
    return '全市场随机：候选 ' + Object.keys(KL.stocks).length + ' 只';
  }

  // A/B：点卡片直接按该源开局抽股
  function startByMode(mode) {
    if (mode === 'c') { closeModeModal(); openPickModal(); return; }
    curSrc = modeToSrc(mode);
    closeModeModal();
    beginNewSession();
  }

  // ---------- 自定义开局日期（双击版本号） ----------
  // 在全局 DAYS 轴上找 >= datekey 的最近交易日下标（不存在→-1）
  function firstIdxOfDate(dateKey) {
    var lo = 0, hi = DAYS.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (DAYS[mid] >= dateKey) { best = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return best;
  }
  // 某年首个交易日的下标
  function firstIdxOfYear(y) { return firstIdxOfDate(y * 10000 + 101); }
  // 数据轴上所有可选年份列表
  function availableYears() {
    var maxStart = TOTAL_BARS - 1;   // 允许到最近一天（数据不足时提前结算）
    var y0 = Math.floor(DAYS[0] / 10000);
    var y1 = Math.floor(DAYS[maxStart] / 10000);
    var years = [];
    for (var y = y0; y <= y1; y++) { if (firstIdxOfYear(y) >= 0) years.push(y); }
    return years;
  }
  // 某年某月所有可选日期的日列表（DAYS[i]=YYYYMMDD，月份前缀 = YYYYMM = y*100+m）
  function availableDays(y, m) {
    var prefix = y * 100 + m;
    var out = [];
    for (var i = 0; i < DAYS.length; i++) {
      if (Math.floor(DAYS[i] / 100) === prefix) out.push(DAYS[i] % 100);
    }
    return out;
  }
  var START_CHOICE = null;   // 弹窗内当前选择：null=随机；否则为 DAYS 下标
  function openStartModal() {
    if (!el('screen-select') || getComputedStyle(el('screen-select')).display === 'none') return;
    var selY = el('start-year'), selM = el('start-month'), selD = el('start-day');
    if (!selY || !selM || !selD) return;

    var years = availableYears();
    selY.innerHTML = years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join('');
    function fillMonths() {
      var y = parseInt(selY.value, 10);
      var ms = [];
      for (var m = 1; m <= 12; m++) { if (availableDays(y, m).length) ms.push(m); }
      selM.innerHTML = ms.map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join('');
    }
    function fillDays() {
      var y = parseInt(selY.value, 10), m = parseInt(selM.value, 10);
      var ds = availableDays(y, m);
      selD.innerHTML = ds.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join('');
    }
    // 从三个下拉合成 DAYS 下标（下拉内日期必然为交易日，firstIdxOfDate 即命中该日）
    function idxOfDropdown() {
      var y = parseInt(selY.value, 10), m = parseInt(selM.value, 10), d = parseInt(selD.value, 10);
      if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
      var idx = firstIdxOfDate(y * 10000 + m * 100 + d);
      return idx < 0 ? null : idx;
    }
    function selectDropdown(idx) {   // 把 DAYS 下标回显到三个下拉（级联刷新）
      var k = DAYS[idx];
      var y = Math.floor(k / 10000), m = Math.floor(k / 100) % 100, d = k % 100;
      if (selY.value !== String(y)) { selY.value = String(y); fillMonths(); }
      if (selM.value !== String(m)) { selM.value = String(m); fillDays(); }
      if (selD.value !== String(d)) selD.value = String(d);
    }
    function rebind() {   // 下拉改动 → 同步为固定选择
      var idx = idxOfDropdown();
      if (idx != null) { START_CHOICE = idx; renderStartHint(); }
    }

    // 初始：已有存档 → 回显存档日；无存档 → 下拉落在“最近可完整窗口起点”（仍保持随机，选完即固定）
    START_CHOICE = CUR_START;
    var anchor = (CUR_START != null && CUR_START >= 0 && CUR_START < TOTAL_BARS)
      ? CUR_START : Math.max(0, TOTAL_BARS - GAME_BARS - 1);
    selectDropdown(anchor);

    selY.onchange = function () { fillMonths(); rebind(); };
    selM.onchange = function () { fillDays(); rebind(); };
    selD.onchange = function () { rebind(); };
    // 🎲 随机：保持下拉不变，仅把选择切回随机
    el('start-random').onclick = function () { START_CHOICE = null; renderStartHint(); };
    // ⏩ 尽量晚：数据末端附近仍可开局（不足一局会提前结算，nextDay 有末端保护）
    el('start-latest').onclick = function () {
      var latest = Math.max(0, Math.min(TOTAL_BARS - 6, TOTAL_BARS - GAME_BARS + 30));
      START_CHOICE = latest;
      selectDropdown(latest);
      renderStartHint();
    };

    renderStartHint();
    el('modal-start').style.display = 'flex';
  }
  function renderStartHint() {
    var h = el('start-hint'), e = el('start-ok');
    if (!h) return;
    if (START_CHOICE == null) {
      h.innerHTML = '当前：<b>随机起点</b>（每次开局在数据区间内随机抽取）。调整上方年月日后会自动切换为固定起点。';
      if (e) e.textContent = '随机起点开局';
      return;
    }
    var st = Math.max(0, Math.min(TOTAL_BARS - 1, START_CHOICE));
    var en = Math.min(TOTAL_BARS - 1, st + GAME_BARS - 1);
    var enYear = Math.floor(DAYS[en] / 10000);
    var short = (en - st + 1) < GAME_BARS;
    h.innerHTML = '当前：从 <b>' + fmtDate(DAYS[st]) + '</b> 开始' +
      (short ? '，<span style="color:var(--warn)">数据仅剩 ' + (TOTAL_BARS - st) + ' 个交易日，将提前结算。</span>'
             : '，将穿越约 1 个自然年到 ' + enYear + ' 年附近。');
    if (e) e.textContent = '保存并从 ' + fmtDate(DAYS[st]) + ' 开局';
  }
  function closeStartModal() { el('modal-start').style.display = 'none'; }
  function applyStartChoice() {
    CUR_START = START_CHOICE;
    try { if (CUR_START == null) localStorage.removeItem('sims.customStart'); else localStorage.setItem('sims.customStart', String(CUR_START)); } catch (e) { }
    closeStartModal();
    var inGame = el('screen-game').style.display !== 'none';
    var preved = !!(S && S.pool && S.pool.length);
    if (inGame || preved) {
      toast(CUR_START == null ? '已设为随机起点，正在重开一局…' : '已从 ' + fmtDate(DAYS[CUR_START]) + ' 重开一局，正在刷新 K 线…');
      beginNewSession();
    } else {
      toast(CUR_START == null ? '已设为随机起点' : '已设定从 ' + fmtDate(DAYS[CUR_START]) + ' 开局');
    }
  }

  // ---------- 模式C：自定义勾选器 ----------
  function openPickModal() {
    closeModeModal();
    // 候选 = 全市场（股+ETF，按代码升序便于查找）
    PK.all = uniAllObjs().sort(function (x, y) { return x.code < y.code ? -1 : 1; });
    PK.shown = 0; PK.sel = {}; PK.query = ''; PK.ind = ''; PK.cat = 'all';
    var q = el('pk-q'); if (q) q.value = '';
    buildPickInds();
    el('modal-pick').style.display = 'flex';
    var pt = el('pk-title');
    if (pt) pt.textContent = '勾选你的股票池（' + pickRangeTxt() + ' 只；选满后需先取消才能再勾）';
    renderPickList();
    if (q) setTimeout(function () { q.focus(); }, 60);
  }
  function closePickModal() { el('modal-pick').style.display = 'none'; }
  function buildPickInds() {
    var set = {};
    PK.all.forEach(function (o) { set[o.ind] = (set[o.ind] || 0) + 1; });
    var keys = Object.keys(set).sort();
    var h = '<option value="">全部行业</option>';
    keys.forEach(function (k) { h += '<option value="' + k + '">' + k + '（' + set[k] + '）</option>'; });
    el('pk-ind').innerHTML = h;
  }
  function catLabel(c) { return ({ white: '白马', blue: '蓝筹', monster: '妖股', st: 'ST', cycle: '周期', etf: 'ETF' })[c] || c; }
  // 当前筛选结果（不翻页）：cat='all'|white|…|'sel'(只看已勾选)；可再叠加 搜索/行业
  function pickMatched() {
    var q = (el('pk-q').value || '').trim().toLowerCase();
    var ind = el('pk-ind').value;
    var arr;
    if (PK.cat === 'sel') arr = PK.all.filter(function (o) { return PK.sel[o.code]; });
    else if (PK.cat && PK.cat !== 'all') arr = PK.all.filter(function (o) { return o.cat === PK.cat; });
    else arr = PK.all;
    if (!q && !ind) return arr;
    // 搜索归一化：东财原名常含空格/全角字符（如"五 粮 液""万  科Ａ"），按常见名称/半角输入也能命中
    var norm = function (s) { return (s || '').replace(/[\s\u3000]+/g, '').toLowerCase().replace(/[\uff01-\uff5e]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); }); };
    var qn = norm(q);
    return arr.filter(function (o) {
      if (ind && o.ind !== ind) return false;
      if (q) {
        var nm = norm(o.name);
        if (o.code.indexOf(q) < 0 && nm.indexOf(qn) < 0) return false;
      }
      return true;
    });
  }
  // 快捷筛选 chip 高亮 + 「已选 N」实时计数
  function syncPickChips() {
    var n = Object.keys(PK.sel).length;
    Array.prototype.forEach.call(document.querySelectorAll('#pick-quick .pick-chip'), function (ch) {
      var c = ch.getAttribute('data-cat');
      ch.classList.toggle('on', c === PK.cat);
      if (c === 'sel') {
        var b = ch.querySelector('.seln');
        if (b) b.textContent = n;
      }
    });
  }
  function renderPickList() {
    var matched = pickMatched();
    var h = '';
    var end = Math.min(matched.length, PK.shown + PICK_PAGE);
    for (var i = 0; i < end; i++) {
      var o = matched[i], on = !!PK.sel[o.code];
      h += '<div class="pick-row' + (on ? ' on' : '') + '" data-code="' + o.code + '">' +
        '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
        '<span class="pn">' + o.name + '</span>' +
        '<span class="tag t-' + o.cat + '">' + catLabel(o.cat) + '</span>' +
        '<span class="pc">' + o.code + '</span>' +
        '<span class="pi">' + (o.ind || '') + '</span></div>';
    }
    el('pick-list').innerHTML = h || (PK.cat === 'sel'
      ? '<div class="pk-empty">还没有勾选任何股票 — 在「全部 / 白马 / ETF…」里勾几只吧</div>'
      : '<div class="pk-empty">没有匹配的股票</div>');
    PK.shown = end;
    var more = el('pk-more');
    if (more) more.style.display = end < matched.length ? '' : 'none';
    syncPickFoot();
    syncPickChips();
  }
  function togglePickCode(code) {
    var adding = !PK.sel[code];
    if (adding && Object.keys(PK.sel).length >= pickCap()) { toast('最多选 ' + pickCap() + ' 只 — 先取消一些再勾选'); return; }
    if (adding) PK.sel[code] = 1; else delete PK.sel[code];
    syncPickFoot();
    syncPickChips();
    // “已选”视图下增减都需整表重绘（行会随勾选状态进出列表）
    if (PK.cat === 'sel') { renderPickList(); return; }
    // 普通视图：已渲染行即时勾选（增量更新，避免整表重绘掉滚动位置）
    var rows = el('pick-list').children;
    Array.prototype.forEach.call(rows, function (r) {
      if (r.getAttribute('data-code') === code) {
        r.classList.toggle('on', !!PK.sel[code]);
        var cb = r.querySelector('input');
        if (cb) cb.checked = !!PK.sel[code];
      }
    });
  }
  function syncPickFoot() {
    var n = Object.keys(PK.sel).length, mn6 = MIN_MINE, cap2 = pickCap();   // r25 自选勾选 ≥3 即可开局
    el('pick-count').innerHTML = n >= mn6
      ? '已选 <b>' + n + '</b>/' + cap2 + ' 只 · 可开局（上限 ' + cap2 + '）'
      : '已选 <b>' + n + '</b>/' + cap2 + ' 只（还需 ' + (mn6 - n) + ' 只）';
    var go = el('pk-go');
    go.disabled = n < mn6;
    go.innerHTML = n >= mn6 ? ('用这 ' + n + ' 只开局 →') : '用这 N 只开局 →';
  }
  // 快捷筛选：点击 chip 只切换列表视图（不再一键批量勾选）；
  // 切换即清空搜索词与行业下拉——否则残留的行业/关键词会把「已选」「全部」视图错误过滤（如停在 LOF 行业时已选的平安银行会消失）
  function setPickCat(cat) {
    PK.cat = (PK.cat === cat ? 'all' : cat);
    PK.query = ''; PK.ind = '';
    var q = el('pk-q'); if (q) q.value = '';
    var s = el('pk-ind'); if (s) s.value = '';
    PK.shown = 0;
    renderPickList();
  }
  function clearPickSel() { PK.sel = {}; renderPickList(); }
  // 模式C确认：保存为「我的自选」池 → 用该池开局（勾选 模式范围内，全部纳入）
  function startCustomPool() {
    var codes = Object.keys(PK.sel);
    var mn7 = MIN_MINE;   // r25 自选 ≥3 只即可开局
    if (codes.length < mn7) { toast('至少勾选 ' + mn7 + ' 只才能开局'); return; }
    if (codes.length > pickCap()) { toast('最多选 ' + pickCap() + ' 只，请先取消多余标的'); return; }
    var mine = listMinePools().filter(function (p) { return p.name !== '我的自选'; });
    var id = 'm' + Date.now().toString(36);
    mine.push({ id: id, name: '我的自选', codes: codes, ts: Date.now() });
    saveMinePools(mine);
    curSrc = { kind: 'mine', id: id };
    closePickModal();
    toast('已保存自选池（' + codes.length + ' 只），开始抽取…');
    beginNewSession();
  }
  function poolDescOf(src) {
    var size = candsSize(src);
    var nm = poolLabel(src);
    return nm + '：候选 ' + size + ' 只';
  }

  // ---------- 进入游戏 ----------
  var orientBound = false, swipeBound = false;
  function bindChartSwipe() {
    var cv = el('main-chart');
    if (!cv || swipeBound) return;
    swipeBound = true;
    var x0 = 0, y0 = 0, multi = false;
    cv.addEventListener('touchstart', function (e) {
      if (e.touches.length >= 2) { multi = true; return; }
      if (e.touches.length === 1 && !multi) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }
    }, { passive: true });
    // 双指进入捏合缩放：取消本段滑动手势，避免 pinch 结束误触发切股
    cv.addEventListener('touchmove', function (e) {
      if (e.touches.length >= 2) multi = true;
    }, { passive: true });
    cv.addEventListener('touchend', function (e) {
      if (multi) { if (e.touches.length === 0) multi = false; return; }
      var tc = e.changedTouches && e.changedTouches[0];
      if (!tc) return;
      var dx = tc.clientX - x0, dy = tc.clientY - y0;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      if (!S || !S.pool.length) return;
      var i = -1;
      S.pool.forEach(function (p, k) { if (p.code === S.sel) i = k; });
      var ni = i < 0 ? 0 : (dx < 0 ? Math.min(S.pool.length - 1, i + 1) : Math.max(0, i - 1));
      if (ni !== i) selectStock(S.pool[ni].code);
    }, { passive: true });
  }
  function startGame() {
    el('screen-select').style.display = 'none';
    el('screen-game').style.display = 'flex';
    // 池数量动态化（C 自定义自选 10–20 只时不再写死 18）
    var pn = el('hd-pool-n');
    if (pn) pn.textContent = (S && S.pool ? S.pool.length : 0) + '只';
    if (!mainChart) {
      mainChart = new ChartEng.KChart(el('main-chart'), { subs: ['vol', 'macd', 'kdj'], resetBars: defaultBars() });
      chipChart = new ChartEng.ChipChart(el('chip-chart'));
      miniChart = new ChartEng.KChart(el('mini-chart'), { subs: ['vol'], showMa: true, showBoll: false, maPad: false, pxTag: false, resetBars: 100 });
    }
    refreshSubBar();
    fillSelect(el('mini-sel'), miniSel);
    el('mini-sel').onchange = function () { miniSel = this.value; renderGame(); };
    fillMultiAdds();
    if (!orientBound) {
      orientBound = true;
      window.addEventListener('orientationchange', function () { setTimeout(layout, 260); });
    }
    bindChartSwipe();
    window.addEventListener('resize', layout);
    layout();
    renderGame();
  }

  var mainChart = null, chipChart = null, miniChart = null, miniSel = 'sh_index';
  var chipOn = false;   // 筹码峰显示开关（默认关闭）

  function layout() {
    var wrap = el('chart-wrap');
    var wrapW = wrap.clientWidth;
    if (wrapW <= 0) return;
    var ch = wrap.clientHeight;   // 手机：wrap 高 auto（由画布撑高），ch 不作为高度依据
    // 横竖屏切换时同步默认K线条数（手机 35 / 桌面 100）
    var want = defaultBars();
    if (mainChart && mainChart.resetBars !== want) {
      mainChart.resetBars = want;
      mainChart.viewBars = want;
      mainChart._fireView && mainChart._fireView();
    }
    // 左右预留给主图让出更多宽度：手机基本贴边（padX≈4），桌面保留常规边距
    var gap = 6, padX = isNarrow() ? 4 : 20;
    var chipW = chipOn ? Math.min(226, Math.max(150, Math.round(wrapW * 0.28))) : 0;
    var cw = Math.max(160, wrapW - chipW - gap - padX);
    var chCap;
    if (isNarrow()) {
      // 手机：主图蜡烛区约占屏高 0.46；每多开一个副图窗口追加 58px —— 副图不再互相挤压
      var nSub = (mainChart && mainChart.opts.subs) ? mainChart.opts.subs.length : 0;
      var vh = window.innerHeight || 800;
      var wrapEl = el('chart-wrap');
      if (wrapEl) wrapEl.style.height = 'auto';   // 高度由画布决定，页面随之变长可滚动
      chCap = Math.max(220, Math.round(vh * 0.46) + nSub * 58 + 34);
    } else {
      // 桌面：受三列版式容器高度约束，超宽则按宽高 1:1 封顶（拒绝“宽1高2”细长画布）
      chCap = Math.min(ch, Math.max(120, cw));
    }
    mainChart.resize(cw, chCap);
    if (chipOn) chipChart.resize(chipW, chCap);
    var mw = el('mini-wrap');
    // 上证指数栏与主图个股 K 线同宽、左缘对齐（两者 padL/padR 一致），K 线横向位置完全对齐
    if (mw && mw.style.display !== 'none' && miniChart) miniChart.resize(cw, Math.max(60, mw.clientHeight - 30));
    if (S) { if (multiOn) renderMulti(); else renderGame(); }
  }

  // 大盘小图（含 0AMV 可选）
  function drawMini() {
    if (!S) return;
    var ix = seriesOf(miniSel) || IX.sh_index;
    var i = seriesEndIdx(ix, DAYS[S.curIdx]);        // 当前游戏日（指数序列）下标
    miniChart.opts.title = ix.name || miniSel;
    // 标签锚点 = 开局日在指数序列中的下标（T0），右缘随游戏日推进
    miniChart.opts.baseIdx = HIDE ? seriesEndIdx(ix, DAYS[S.startIdx]) : null;
    miniChart.setData(ix, i);
    var prev = i > 0 ? ix.c[i - 1] : ix.c[i];
    var chg = prev ? (ix.c[i] - prev) / prev * 100 : 0;
    el('mini-val').textContent = ix.c[i].toFixed(2) + '  ' + pct(chg);
    el('mini-val').className = cls(chg);
  }

  // 个股在全局日期轴的索引（停牌返回 null）
  function idxAt(code, date) {
    var m = S.map[code];
    if (!m) return null;
    var i = m[date];
    return i == null ? null : i;
  }
  function pxAt(code, date) {
    var i = idxAt(code, date);
    return i == null ? null : KL.stocks[code];
  }
  // 序列内 <= date 的最近索引（不依赖当前股票池 S.map，历史/已换池标的也安全）
  function stIdxLe(st, date) {
    if (!st._dmap) {
      st._dmap = {};
      for (var a = 0; a < st.d.length; a++) st._dmap[st.d[a]] = a;
    }
    var j = st._dmap[date];
    if (j != null) return j;
    var lo = 0, hi = st.d.length - 1, best = -1, dd = st.d;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best < 0 ? 0 : best;
  }
  // 开局日标签锚点（T0）：个股取“开局日”在自身序列的下标；当日停牌则回退到 <= 开局日的最近一根
  function startAnchorFor(code, st, date) {
    var m = S && S.map && S.map[code];
    if (m && m[date] != null) return m[date];
    return stIdxLe(st, date);
  }
  function lastPx(code, date) {
    var st = KL.stocks[code];
    if (!st) return 0;
    var m = S.map[code];
    if (m) { var i = m[date]; if (i != null) return st.c[i]; }
    // 不在当前股票池（换池前的历史标的）或当日停牌：取 <= date 最近收盘
    var q = stIdxLe(st, date);
    return st.c[q] != null ? st.c[q] : 0;
  }
  function prevClose(code, date) {
    var st = KL.stocks[code], m = S.map[code];
    if (!st || !m) return null;   // 不在当前池则无前收
    var i = m[date];
    if (i == null) return null;
    return i > 0 ? st.c[i - 1] : st.c[0];
  }

  // 玩家买卖点标注（r18）：按全局交易日下标换算成"个股自身序列下标"后交给 KChart.opts.markers
  // B = 每笔开仓日（含仍持仓）；S = 每笔平仓日。同一日重复买卖只标一次。
  function markersOf(code) {
    if (!S || !S.map || !S.map[code]) return null;
    var m = S.map[code], B = [], SS = [];
    function toArr(d) { return (m[DAYS[d]] != null) ? m[DAYS[d]] : null; }
    S.positions.forEach(function (p) {
      if (p.code !== code) return;
      var q = toArr(p.buyIdx);
      if (q != null && B.indexOf(q) < 0) B.push(q);
    });
    S.trades.forEach(function (t) {
      if (t.code !== code) return;
      var q = toArr(t.buyIdx);
      if (q != null && B.indexOf(q) < 0) B.push(q);
      var r = toArr(t.sellIdx);
      if (r != null && SS.indexOf(r) < 0) SS.push(r);
    });
    return { B: B, S: SS };
  }

  // ---------- 游戏主渲染 ----------
  var stockFootNode = null;   // 自选池底部「更换股票池」槽位（缓存引用，防 innerHTML 游离后 getElementById 返回 null）
  function renderGame() {
    if (!S || (S.over && !REVIEW)) return;   // 复盘模式允许渲染已结算局（只读）
    syncPoolOps();   // r25 局内「增删本池股票」按钮随 池=自定义&进行中 显隐
    var date = DAYS[S.curIdx];
    var st = KL.stocks[S.sel], i = idxAt(S.sel, date);

    // 顶栏
    var eq = equityNow();
    var ret = (eq - INIT_CASH) / INIT_CASH * 100;
    el('hud-date').textContent = HIDE
      ? ('第 ' + S.day + '/' + GAME_BARS + ' 天 · ' + relDay(date))
      : (fmtDate(date) + ' · 第' + S.day + '/' + GAME_BARS + '天');
    el('hud-eq').textContent = money(eq);
    el('hud-cash').textContent = money(S.cash);
    el('hud-ret').textContent = pct(ret);
    el('hud-ret').className = cls(ret);
    // 更换股票池按钮：用过即隐藏（PC顶栏 / 移动自选池底部同步）
    updateRepoolBtns();

    // 主图 / 筹码峰 / 大盘
    var mi = i != null ? i : lastIdxBefore(S.sel, date);   // 当前游戏日（个股序列）下标
    mainChart.opts.title = st.name;
    // 标签锚点 = 开局日（T0）：当前游戏日显示 T+已玩天数并随推进递增，窗口右缘仍由 setData 锁在“当前日”防未来
    mainChart.opts.baseIdx = HIDE ? startAnchorFor(S.sel, st, DAYS[S.startIdx]) : null;
    mainChart.opts.markers = markersOf(S.sel);   // K线上标注玩家 B/S 买卖点
    mainChart.setData(st, mi);
    chipChart.hideDate = HIDE;
    if (chipOn) chipChart.setData(S.sel, date, (mainChart._lo != null)
      ? { lo: mainChart._lo, hi: mainChart._hi, top: mainChart._priceTop, bot: mainChart._priceBot }
      : null);
    drawMini();

    // 股票列表（分类排序展示：白马蓝筹→妖股→ST→周期→ETF）
    var html = '';
    sortedPool().forEach(function (p) {
      var pst = KL.stocks[p.code], pi = idxAt(p.code, date);
      var pos = S.positions.filter(function (x) { return x.code === p.code; })[0];
      var susp = pi == null;
      var px = lastPx(p.code, date);
      var pc = prevClose(p.code, date);
      var chg = (pc && px) ? (px - pc) / pc * 100 : 0;
      var pl = pos && px ? (px - pos.cost) / pos.cost * 100 : 0;
      html += '<div class="st-item' + (p.code === S.sel ? ' on' : '') + '" data-code="' + p.code + '">' +
        '<div class="si-l"><div class="si-n"><span class="nm">' + p.name + '</span>' +
        '<span class="tag t-' + p.cat + '">' + ({ white: '白马', blue: '蓝筹', monster: '妖股', st: 'ST', cycle: '周期', etf: 'ETF' })[p.cat] + '</span></div>' +
        (susp ? '<div class="si-c"><i>停牌</i></div>' : '') + '</div>' +
        '<div class="si-r"><div class="si-p ' + cls(chg) + '">' + px.toFixed(2) + '</div>' +
        '<div class="si-g ' + cls(chg) + '">' + (susp ? '--' : pct(chg)) + '</div></div>' +
        (pos ? '<div class="si-hold">持' + pos.shares + '股 <span class="' + cls(pl) + '">' + pct(pl) + '</span></div>' : '') +
        '</div>';
    });
    el('stock-list').innerHTML = html;
    // 「更换股票池」作为自选池网格的最后一个槽位（横跨整行），视觉上属于列表内部而非独立区域。
    // 注意：必须缓存节点引用（非 getElementById）——每次 innerHTML 会把它游离出文档，二次查询会返回 null。
    if (!stockFootNode) stockFootNode = el('stock-list-foot');
    if (stockFootNode && stockFootNode.parentNode !== el('stock-list')) el('stock-list').appendChild(stockFootNode);
    Array.prototype.forEach.call(el('stock-list').children, function (node) {
      if (node === stockFootNode) return;   // 换池按钮不响应选股
      node.onclick = function () { selectStock(node.getAttribute('data-code')); };
    });

    renderPos();
    renderNews(date);
    renderTradeBox();
  }

  function lastIdxBefore(code, date) {
    var st = KL.stocks[code];
    for (var q = st.d.length - 1; q >= 0; q--) if (st.d[q] <= date) return q;
    return 0;
  }

  function equityNow() {
    var v = S.cash - S.marginDebt;
    var date = DAYS[S.curIdx];
    S.positions.forEach(function (p) { v += lastPx(p.code, date) * p.shares; });
    return v;
  }

  function renderPos() {
    var date = DAYS[S.curIdx];
    var h = '';
    // ---- 当前持仓（上） ----
    if (!S.positions.length) {
      h += '<div class="empty">暂无持仓</div>';
    } else {
      S.positions.forEach(function (p) {
        var px = lastPx(p.code, date), st = KL.stocks[p.code];
        var mv = px * p.shares, cost = p.cost * p.shares;
        var pl = mv - cost, plr = pl / cost * 100;
        var days = S.curIdx - p.buyIdx;
        h += '<div class="pos-item" data-code="' + p.code + '">' +
          '<div class="po-n">' + st.name + '<span class="po-d">' + days + '天</span></div>' +
          '<div class="po-p">持仓' + p.shares + '股 · 成本' + p.cost.toFixed(2) + ' 现价' + px.toFixed(2) + '</div>' +
          '<div class="po-pl ' + cls(pl) + '">' + money(pl) + ' (' + pct(plr) + ')</div></div>';
      });
    }
    // ---- 历史交易记录（下，同一滚动框，最新在上） ----
    h += '<div class="tr-hd">交易记录 · ' + S.trades.length + ' 笔</div>';
    if (!S.trades.length) {
      h += '<div class="empty">暂无交易</div>';
    } else {
      S.trades.slice().reverse().forEach(function (t) {
        var r2 = (t.sell - t.cost) / t.cost * 100;
        h += '<div class="pl-tr" data-code="' + t.code + '">' +
          '<span class="tn">' + t.name + '</span>' +
          '<span class="ti">' + t.shares + '股 · ' + t.days + '天</span>' +
          '<span class="tp ' + cls(t.pl) + '">' + money(t.pl) + ' (' + pct(r2) + ')</span>' +
          (t.forced ? '<span class="forced">强平</span>' : '') + '</div>';
      });
    }
    el('pos-list').innerHTML = h;
    el('pos-cnt').textContent = '持' + S.positions.length + '只 · ' + S.trades.length + '笔';
    Array.prototype.forEach.call(el('pos-list').querySelectorAll('.pos-item'), function (node) {
      node.onclick = function () { selectStock(node.getAttribute('data-code')); };
    });
    Array.prototype.forEach.call(el('pos-list').querySelectorAll('.pl-tr'), function (node) {
      node.onclick = function () { selectStock(node.getAttribute('data-code')); };
    });
  }

  // 统一选股入口：普通模式刷新主界面；多图模式下同步第一张个股卡片跟随切换
  function selectStock(code) {
    if (!code || !KL.stocks[code]) return;
    // 换池后旧标的已不在本局池内：禁止切入选股（避免误对池外标的交易）
    if (S && S.pool && !S.pool.some(function (p) { return p.code === code; })) {
      return toast('该标的不在本局股票池内（已更换股票池）');
    }
    S.sel = code;
    if (multiOn) {
      Array.prototype.forEach.call(el('stock-list').children, function (node) {
        node.classList.toggle('on', node.getAttribute('data-code') === code);
      });
      for (var i = 0; i < multiItems.length; i++) {
        if (multiItems[i].kind === 'stock') { multiItems[i].code = code; break; }
      }
      renderTradeBox();   // 多图模式下手动刷新买卖栏(name/价/可用/持仓),原 renderGame 才更新它
      renderMulti();
    } else {
      renderGame();
    }
    closeSideDrawer(); // 移动端：选股后自动收起右侧抽屉，避免遮挡图表
  }

  // ---------- 右侧抽屉（移动端） ----------
  function toggleSideDrawer() {
    var col = document.querySelector('.col-right');
    var bd = el('side-backdrop');
    if (!col) return;
    var open = col.classList.toggle('open');
    if (bd) bd.classList.toggle('open', open);
  }
  function closeSideDrawer() {
    var col = document.querySelector('.col-right');
    var bd = el('side-backdrop');
    if (!col) return;
    col.classList.remove('open');
    if (bd) bd.classList.remove('open');
  }
  // 更换股票池按钮：PC 顶栏 / 移动自选池底部同步剩余次数
  function updateRepoolBtns() {
    var used = !!(S && S.repoolUsed);
    var a = el('btn-repool');
    if (a) a.style.display = used ? 'none' : '';
    var b = el('btn-repool-mobile');
    if (b) {
      b.disabled = used;
      b.textContent = used ? '✓ 本局更换股票池已使用' : '🔁 更换股票池（剩余 1 次）';
      b.style.opacity = used ? .55 : 1;
    }
  }

  function renderNews(date) {
    var m = (NW.market || []).filter(function (n) { return n.d === date; });
    var c = (NW.stocks[S.sel] || []).filter(function (n) { return n.d === date; });
    var h = '<div class="news-date">' + (HIDE
      ? ('第 ' + S.day + ' 交易日 · ' + relDay(date))
      : (fmtDate(date) + ' · 第' + S.day + '天')) + '</div>';
    if (!m.length && !c.length) {
      // 无当日新闻时，显示最近3条市场新闻（灰色提示历史）
      var recent = (NW.market || []).filter(function (n) { return n.d <= date; }).slice(-3).reverse();
      if (!recent.length) h += '<div class="news-none">今日无重大新闻</div>';
      else {
        h += '<div class="news-hint">近期要闻</div>';
        recent.forEach(function (n) { h += newsItem(n, true); });
      }
    } else {
      if (m.length) { h += '<div class="news-hint">市场要闻</div>'; m.forEach(function (n) { h += newsItem(n); }); }
      if (c.length) { h += '<div class="news-hint">' + KL.stocks[S.sel].name + '</div>'; c.forEach(function (n) { h += newsItem(n); }); }
    }
    el('news-box').innerHTML = h;
    el('news-box').scrollTop = 0;
  }
  function newsItem(n, old) {
    return '<div class="news-item' + (old ? ' old' : '') + '">' +
      '<a href="' + (n.u || '#') + '" target="_blank" rel="noopener">' + n.ti + '</a>' +
      '<div class="ni-m">' + (old ? dayLabel(n.d) + ' · ' : '') + (n.s || '') + '</div></div>';
  }

  function renderTradeBox() {
    var st = KL.stocks[S.sel], date = DAYS[S.curIdx];
    var i = idxAt(S.sel, date), px = lastPx(S.sel, date);
    var pos = S.positions.filter(function (x) { return x.code === S.sel; })[0];
    el('tb-name').textContent = st.name;
    el('tb-px').textContent = px.toFixed(2) + (i == null ? ' (停牌不可交易)' : '');
    var lim = limitOf(S.sel, st.cat);
    var pc = prevClose(S.sel, date), upP = pc ? (pc * (1 + lim)) : 0, dnP = pc ? (pc * (1 - lim)) : 0;
    el('tb-limit').textContent = '涨' + upP.toFixed(2) + ' 跌' + dnP.toFixed(2) + ' (' + (lim * 100) + '%)';
    el('tb-avail').textContent = money(S.cash);
    el('tb-hold').textContent = pos ? pos.shares + '股' : '0股';
    el('tb-sellable').textContent = (pos && pos.buyIdx < S.curIdx) ? pos.shares + '股' : '0股(T+1)';
    // 可卖之后显示当前持仓盈亏百分比（红涨绿跌；无持仓/停牌不显示）
    var tpl = el('tp-pl'), tbv = el('tb-pl');
    if (tpl && tbv) {
      if (pos && px) {
        var pp = (px - pos.cost) / pos.cost * 100;
        tbv.textContent = pct(pp);
        tbv.className = cls(pp);
        tpl.style.display = '';
      } else {
        tpl.style.display = 'none';
      }
    }
  }

  // ---------- 交易 ----------
  function buy() {
    if (!S || S.over) return toast('本局已结算，仅供复盘，不可交易');
    var code = S.sel, date = DAYS[S.curIdx], st = KL.stocks[code];
    var i = idxAt(code, date);
    if (i == null) return toast('停牌中，无法交易');
    var px = st.c[i], pc = i > 0 ? st.c[i - 1] : st.c[0], lim = limitOf(code, st.cat);
    if (px >= pc * (1 + lim) - 1e-6) return toast('涨停封板，无法买入');
    var shares = parseInt(el('tb-num').value, 10) * 100;
    if (!shares || shares <= 0) return toast('请输入买入数量（手）');
    var amount = px * shares;
    var fee = Math.max(5, amount * 0.00025);
    if (amount + fee > S.cash) return toast('资金不足（需 ' + money(amount + fee) + '）');
    S.cash -= amount + fee;
    var pos = S.positions.filter(function (x) { return x.code === code; })[0];
    if (pos) {
      pos.shares += shares;
      pos.cost = (pos.cost * (pos.shares - shares) + amount) / pos.shares;
      pos.buyIdx = S.curIdx;   // 加仓部分受T+1限制
    } else {
      S.positions.push({ code: code, shares: shares, cost: px, buyIdx: S.curIdx });
    }
    toast('买入 ' + st.name + ' ' + shares + '股 @' + px.toFixed(2));
    if (multiOn) renderMulti();   // 多图模式：把新 B 标记同步到对应卡片
    renderGame();
    saveProgress();
  }

  function sell() {
    if (!S || S.over) return toast('本局已结算，仅供复盘，不可交易');
    var code = S.sel, date = DAYS[S.curIdx], st = KL.stocks[code];
    var i = idxAt(code, date);
    if (i == null) return toast('停牌中，无法交易');
    var pos = S.positions.filter(function (x) { return x.code === code; })[0];
    if (!pos) return toast('无持仓');
    if (pos.buyIdx >= S.curIdx) return toast('T+1 限制：当日买入不可卖出');
    var px = st.c[i], pc = i > 0 ? st.c[i - 1] : st.c[0], lim = limitOf(code, st.cat);
    if (px <= pc * (1 - lim) + 1e-6) return toast('跌停封板，无法卖出');
    var shares = parseInt(el('tb-num').value, 10) * 100;
    if (!shares || shares <= 0) return toast('请输入卖出数量（手）');
    if (shares > pos.shares) shares = pos.shares;
    var amount = px * shares;
    var fee = Math.max(5, amount * 0.00025) + (st.cat === 'etf' ? 0 : amount * 0.0005) + amount * 0.00001;
    S.cash += amount - fee;
    S.trades.push({
      code: code, name: st.name, shares: shares,
      cost: pos.cost, sell: px, buyIdx: pos.buyIdx, sellIdx: S.curIdx,
      pl: (px - pos.cost) * shares - fee, days: S.curIdx - pos.buyIdx,
      fee: fee
    });
    pos.shares -= shares;
    if (pos.shares <= 0) S.positions = S.positions.filter(function (x) { return x.code !== code; });
    toast('卖出 ' + st.name + ' ' + shares + '股 @' + px.toFixed(2));
    if (multiOn) renderMulti();   // 多图模式：把新 S 标记同步到对应卡片
    renderGame();
    saveProgress();
  }

  function sellAll() {
    var pos = S.positions.filter(function (x) { return x.code === S.sel; })[0];
    if (!pos) return toast('无持仓');
    el('tb-num').value = Math.floor(pos.shares / 100);
    sell();
  }
  function buyMax() {
    var code = S.sel, px = lastPx(code, DAYS[S.curIdx]);
    var lots = Math.floor(S.cash / (px * 100 * 1.0003));
    el('tb-num').value = lots;
    if (lots > 0) buy(); else toast('资金不足一手');
  }
  // 按可用资金比例买入（frac=0.5 半仓 / 0.25 四分之一仓）
  function buyFrac(frac) {
    var code = S.sel, px = lastPx(code, DAYS[S.curIdx]);
    var lots = Math.floor(S.cash * frac / (px * 100 * 1.0003));
    el('tb-num').value = lots;
    if (lots > 0) buy(); else toast('资金不足一手');
  }
  // 按持仓比例卖出
  function sellFrac(frac) {
    var pos = S.positions.filter(function (x) { return x.code === S.sel; })[0];
    if (!pos) return toast('无持仓');
    if (pos.buyIdx >= S.curIdx) return toast('T+1 限制：当日买入不可卖出');
    var lots = Math.floor(pos.shares * frac / 100);
    if (lots < 1) return toast('持仓仅 ' + pos.shares + ' 股，不足一手按比例卖出，请用「全卖」');
    el('tb-num').value = lots;
    sell();
  }

  // ---------- 推进 ----------
  function nextDay(n) {
    n = n || 1;
    if (!S || S.over) return;
    var lastIdx = TOTAL_BARS - 1;
    var target = Math.min(S.startIdx + GAME_BARS, lastIdx, S.curIdx + n);
    while (S.curIdx < target) {
      S.curIdx++; S.day++;
      var date = DAYS[S.curIdx];
      var eq = equityNow();
      S.equity.push({ d: date, v: eq });
      // 融资解锁 & 强平
      if (!S.marginUnlocked && eq >= 500000) S.marginUnlocked = true;
      if (S.marginDebt > 0) {
        var ratio = eq / S.marginDebt * 100;
        if (ratio < 110) forceClose('维持担保比例低于110%，触发强制平仓');
        else if (ratio < 130) toast('警告：维持担保比例 ' + ratio.toFixed(0) + '%，低于130%警戒线');
      }
    }
    if (S.curIdx >= S.startIdx + GAME_BARS) { settle(); return; }
    // 数据已到最新交易日仍不够一整局（起点太晚）：提前结算，不再跨过数据末端
    if (S.curIdx >= lastIdx) {
      toast(S.day >= GAME_BARS ? '' : '已到数据最新一天，本局按 ' + S.day + ' 天提前结算');
      settle();
      return;
    }
    if (multiOn) { multiView.date = DAYS[S.curIdx]; renderMulti(); }
    renderGame();
    saveProgress();
  }

  function forceClose(msg) {
    var date = DAYS[S.curIdx];
    S.positions.slice().forEach(function (p) {
      var px = lastPx(p.code, date);
      var amount = px * p.shares;
      var fee = Math.max(5, amount * 0.00025) + (KL.stocks[p.code].cat === 'etf' ? 0 : amount * 0.0005);
      S.cash += amount - fee;
      S.trades.push({ code: p.code, name: KL.stocks[p.code].name, shares: p.shares, cost: p.cost,
        sell: px, buyIdx: p.buyIdx, sellIdx: S.curIdx, pl: (px - p.cost) * p.shares - fee,
        days: S.curIdx - p.buyIdx, fee: fee, forced: true });
    });
    S.positions = [];
    S.marginDebt = 0;
    toast(msg);
  }

  function borrow() {
    if (!S || S.over) return toast('本局已结算，仅供复盘');
    if (!S.marginUnlocked) return toast('总资产达50万后才解锁融资');
    var avail = INIT_CASH - S.marginDebt;
    if (avail <= 0) return toast('融资额度已用尽');
    S.marginDebt += avail; S.cash += avail; S.marginUsed += avail;
    toast('融资 ' + money(avail) + '，维持担保比例 ' + (equityNow() / S.marginDebt * 100).toFixed(0) + '%');
    renderGame();
  }
  function repay() {
    if (!S || S.over) return toast('本局已结算，仅供复盘');
    if (S.marginDebt <= 0) return toast('无融资负债');
    var pay = Math.min(S.marginDebt, S.cash);
    S.cash -= pay; S.marginDebt -= pay;
    toast('还款 ' + money(pay));
    renderGame();
  }

  // ---------- 更换股票池（每局一次） ----------
  function openRepoolModal() {
    if (!S || S.over) return;
    if (curSrc && curSrc.kind === 'seed') return toast('种子局的股票池就写在种子里，固定不变，无需更换');   // r30
    if (S.repoolUsed) return toast('本局已使用过更换股票池');
    el('modal-repool').style.display = 'flex';
  }
  function closeRepoolModal() { el('modal-repool').style.display = 'none'; }
  // 换池强平时受限持仓（当日买入，T+1 未解锁）→ 按下一可交易日「开盘价」卖出；
  // 若后续已无交易日（临近收官）则退回当日收盘价
  function nextOpenSellPx(code) {
    var date0 = DAYS[S.curIdx];
    var st = KL.stocks[code], m = S.map[code];
    var last = Math.min(DAYS.length - 1, S.startIdx + GAME_BARS);
    for (var d = S.curIdx + 1; d <= last; d++) {
      var i = m ? m[DAYS[d]] : null;
      if (i != null) return { px: (st.o[i] != null ? st.o[i] : st.c[i]), di: d };
    }
    var cur = m ? m[date0] : null;
    if (cur != null) return { px: st.c[cur], di: S.curIdx };
    var q = stIdxLe(st, date0);
    return { px: st.c[q] != null ? st.c[q] : 0, di: S.curIdx };
  }

  function closePosForRepool(p) {
    var code = p.code, amount, fee, px, di = S.curIdx;
    if (p.buyIdx < S.curIdx) {
      // 已过 T+1：当日可卖，按当前价成交
      px = lastPx(code, DAYS[S.curIdx]);
      di = S.curIdx;
    } else {
      // 当日买入未过 T+1：按下一交易日开盘价成交
      var nq = nextOpenSellPx(code);
      px = nq.px; di = nq.di;
    }
    amount = px * p.shares;
    fee = Math.max(5, amount * 0.00025) + (KL.stocks[code].cat === 'etf' ? 0 : amount * 0.0005);
    S.cash += amount - fee;
    S.trades.push({ code: code, name: KL.stocks[code].name, shares: p.shares, cost: p.cost,
      sell: px, buyIdx: p.buyIdx, sellIdx: di, pl: (px - p.cost) * p.shares - fee,
      days: di - p.buyIdx, fee: fee, forced: true });
  }

  function doRepool() {
    closeRepoolModal();
    if (!S || S.over || S.repoolUsed) return;
    S.repoolUsed = true;
    dropChallenge('已更换股票池，本局不再计入挑战成绩');   // r30：换了池就不是原来那一局了
    // 1) 清仓全部持仓：过 T+1 的按现价卖；当日买入的按下一交易日开盘价卖
    S.positions.slice().forEach(closePosForRepool);
    S.positions = [];
    // 2) 从当前池来源重抽（池源候选 ≥36 只才排除本局旧标的，小池允许重复，保证可抽足）
    busy(true, '正在更换股票池', '正在从池来源 <b>' + poolLabel(curSrc) + '</b> 重新抽取标的并获取行情（命中本地缓存将秒开）…');
    var cands = resolveCands(curSrc);
    var excl = cands.length >= 36 ? S.pool.map(function (p) { return p.code; }) : [];
    var pool = curSrc.kind === 'etf' ? sampleEtfPool(cands, excl) : samplePool(cands, excl);
    // 神圣池（C 模式自选 ≤pickCap 即用户勾选集）：换池也只从自选集里重抽，坏标的剔除不放行全市场随机替换
    var sacred = (curSrc.kind === 'seed') || (curSrc.kind === 'mine' && cands.length <= pickCap());   // r30 种子池同理
    ensureData(pool, S.startIdx, !sacred, onProg, cands).then(function (r) {
      if (r.bad && r.bad.length) {
        if (sacred) {
          var dropMsg = sacredBadHandle(r, pool);
          if (dropMsg) { busy(false); S.repoolUsed = false; return toast('换池失败：' + dropMsg); }
          // 剔除坏标的后池变小但 ≥10，可继续：走下方共用流程
        } else {
          busy(false);
          S.repoolUsed = false;   // 失败回滚，允许再次尝试
          return toast('换池失败：部分标的无可用行情，请重试');
        }
      }
      busy(false);
      S.pool = r.pool;
      S.sel = r.pool[0].code;
      S.map = {};
      S.pool.forEach(function (p) { S.map[p.code] = buildMap(KL.stocks[p.code]); });
      // 3) 退出多图对比并刷新下拉（避免残留旧池代码）
      if (multiOn) toggleMulti();
      multiItems = [];
      if (el('multi-grid')) el('multi-grid').innerHTML = '';   // 同步清掉旧卡片 DOM
      fillMultiAdds();
      var extra = sacred && pool.length !== r.pool.length
        ? '（' + pool.filter(function (p) { return r.pool.indexOf(p) < 0; }).map(function (p) { return p.name; }).join('、') + ' 无行情已剔除）'
        : '';
      toast('已更换股票池' + extra + '：已过T+1持仓按现价清仓，当日买入按下一交易日开盘价成交');
      renderGame();
      saveProgress();
    });
  }

  // ---------- 统计 ----------
  function returns() {
    var r = [];
    for (var i = 1; i < S.equity.length; i++) {
      var p = S.equity[i - 1].v;
      if (p > 0) r.push((S.equity[i].v - p) / p);
    }
    return r;
  }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function sharpeNow() {
    var r = returns();
    if (r.length < 5) return NaN;
    var sd = std(r);
    if (sd === 0) return 0;
    return (mean(r) * 252 - RF) / (sd * Math.sqrt(252));
  }
  function maxDrawdown() {
    var peak = -Infinity, mdd = 0;
    S.equity.forEach(function (e) {
      if (e.v > peak) peak = e.v;
      var dd = (peak - e.v) / peak;
      if (dd > mdd) mdd = dd;
    });
    return mdd;
  }
  function alphaBeta() {
    // 相对沪深300，按同期日收益对齐
    var bmap = {}, bd = IX.hs300.d, bc = IX.hs300.c;
    for (var i = 0; i < bd.length; i++) bmap[bd[i]] = i;
    var rp = [], rb = [];
    for (var i = 1; i < S.equity.length; i++) {
      var d0 = S.equity[i - 1].d, d1 = S.equity[i].d;
      var i0 = bmap[d0], i1 = bmap[d1];
      if (i0 == null || i1 == null) continue;
      var prev = S.equity[i - 1].v;
      if (prev <= 0) continue;
      rp.push((S.equity[i].v - prev) / prev);
      rb.push((bc[i1] - bc[i0]) / bc[i0]);
    }
    if (rp.length < 5) return { a: NaN, b: NaN };
    var mp = mean(rp), mb = mean(rb);
    var cov = 0, vb = 0;
    for (var i = 0; i < rp.length; i++) { cov += (rp[i] - mp) * (rb[i] - mb); vb += (rb[i] - mb) * (rb[i] - mb); }
    var beta = vb > 0 ? cov / vb : 0;
    return { a: (mp - beta * mb) * 252, b: beta };
  }
  function rankOf(sh) {
    if (!isFinite(sh)) return '--';
    if (sh > 3) return 'S';     // r31：评级阈值收紧——S>3 / A>2 / B>1 / C>0（原 S≥5/A≥2.5/B≥1.8/C≥1.1）
    if (sh > 2) return 'A';
    if (sh > 1) return 'B';
    if (sh > 0) return 'C';
    return 'D';
  }

  // ---------- 择时 / 选股能力评分 ----------
  // 用户规则（方差法）：大盘次日 50% 涨跌、踩中中位数 80% 概率 = 择时满分(100%)；
  // 个股次日 50% 涨跌、踩中中位数 80% 概率 = 选股前 50 分；另 50 分按期望日均收益
  // 0.5% = 满分 50、0% = 25 分。此处用「实际是否正确站位/选中」替代显式预测：
  //   择时 = 大盘涨日是否持仓、跌日是否空仓；选股 = 持仓个股当日收益是否≥池内中位数。
  function abilityScores() {
    if (S.equity.length < 2) return { timing: 0, timingHit: 0, select: 0, hitA: 0, retB: 0, scoreA: 0, scoreB: 0 };
    // 由成交流水重建每日持仓集合（buyIdx..sellIdx 为 DAYS 下标）
    var heldByDay = {};
    S.trades.forEach(function (t) {
      for (var d = t.buyIdx; d <= t.sellIdx; d++) (heldByDay[d] = heldByDay[d] || {})[t.code] = true;
    });
    var tHit = 0, tTot = 0, sHit = 0, sTot = 0, retSum = 0, retCnt = 0;
    for (var di = S.startIdx + 1; di <= S.curIdx; di++) {
      var d1 = DAYS[di - 1], d2 = DAYS[di];
      // 大盘当日收益
      var i0 = seriesEndIdx(IX.hs300, d1), i1 = seriesEndIdx(IX.hs300, d2);
      var mkt = (IX.hs300.c[i1] - IX.hs300.c[i0]) / IX.hs300.c[i0];
      var longDay = !!(heldByDay[di] && Object.keys(heldByDay[di]).length);
      // 择时命中：涨日持仓 / 跌日空仓
      tTot++;
      if (mkt > 0 && longDay) tHit++;
      else if (mkt < 0 && !longDay) tHit++;
      else if (mkt === 0) tHit++;
      // 选股 A：池内当日收益中位数
      var poolRet = [];
      S.pool.forEach(function (p) {
        var a = lastPx(p.code, d1), b = lastPx(p.code, d2);
        if (a > 0) poolRet.push((b - a) / a);
      });
      var median = 0;
      if (poolRet.length) { poolRet.sort(function (x, y) { return x - y; }); median = poolRet[Math.floor(poolRet.length / 2)]; }
      if (heldByDay[di]) {
        Object.keys(heldByDay[di]).forEach(function (code) {
          var a = lastPx(code, d1), b = lastPx(code, d2);
          if (a <= 0) return;
          sTot++; if ((b - a) / a >= median) sHit++;
        });
      }
      // 收益期望分量（玩家当日收益）
      var eqPrev = S.equity[di - 1 - S.startIdx].v, eqCur = S.equity[di - S.startIdx].v;
      retSum += (eqCur - eqPrev) / eqPrev; retCnt++;
    }
    var timingHitRate = tTot ? tHit / tTot : 0;
    var timing = clamp(timingHitRate / 0.80 * 100, 0, 100);     // 80% 命中 = 满分
    var stockHitRate = sTot ? sHit / sTot : 0;
    var scoreA = clamp(stockHitRate / 0.80 * 50, 0, 50);        // 80% 命中 = 50 分
    var avgDailyPct = retCnt ? retSum / retCnt * 100 : 0;
    var scoreB = clamp(25 + (avgDailyPct / 0.5) * 25, 0, 50);   // 0.5%/日=50分，0%=25分
    return {
      timing: timing, timingHit: timingHitRate * 100,
      select: scoreA + scoreB, hitA: stockHitRate * 100,
      retB: avgDailyPct, scoreA: scoreA, scoreB: scoreB
    };
  }

  // ---------- 结算 ----------
  function settle() {
    if (S.over && S.stats) { renderSettle(); return; }
    var date = DAYS[S.curIdx];
    // 事务化：先全部算成功再提交；任何异常回滚，避免“换池后结算”把状态置死导致按钮失灵
    var posBackup = S.positions.slice(), trBackupLen = S.trades.length;
    try {
      // 1) 按收盘价生成平仓流水（本地计算，不直接改状态）
      var posVal = 0, closing = [];
      posBackup.forEach(function (p) {
        var px = lastPx(p.code, date);
        posVal += px * p.shares;
        closing.push({ code: p.code, name: KL.stocks[p.code].name, shares: p.shares, cost: p.cost,
          sell: px, buyIdx: p.buyIdx, sellIdx: S.curIdx, pl: (px - p.cost) * p.shares,
          days: S.curIdx - p.buyIdx, fee: 0, forced: false });
      });
      S.trades = S.trades.concat(closing);
      var finalEq = S.cash + posVal - S.marginDebt;
      var totalRet = (finalEq - INIT_CASH) / INIT_CASH * 100;
      var years = GAME_BARS / 242;
      var annual = (Math.pow(finalEq / INIT_CASH, 1 / years) - 1) * 100;
      var r = returns(), sd = std(r);
      var sh = r.length >= 5 ? (mean(r) * 252 - RF) / (sd * Math.sqrt(252)) : NaN;
      var mdd = maxDrawdown() * 100;
      var ab = alphaBeta();
      var wins = S.trades.filter(function (t) { return t.pl > 0; });
      var losses = S.trades.filter(function (t) { return t.pl <= 0; });
      var avgWin = wins.length ? mean(wins.map(function (t) { return t.pl; })) : 0;
      var avgLoss = losses.length ? mean(losses.map(function (t) { return Math.abs(t.pl); })) : 0;
      var plRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
      // 最大单笔盈利只统计盈利单笔，无盈利交易时为 0
      var maxWin = wins.length ? Math.max.apply(null, wins.map(function (t) { return t.pl; })) : 0;
      // 最惨单笔
      var maxLoss = losses.length ? Math.min.apply(null, losses.map(function (t) { return t.pl; })) : 0;
      var daysArr = S.trades.map(function (t) { return t.days; });
      var maxHold = daysArr.length ? Math.max.apply(null, daysArr) : 0;
      var avgHold = daysArr.length ? mean(daysArr) : 0;
      var winRate = S.trades.length ? wins.length / S.trades.length * 100 : 0;
      var benchRet = benchReturn();
      var abil = abilityScores();

      S.stats = {
        finalEq: finalEq, totalRet: totalRet, annual: annual, sharpe: sh, mdd: mdd,
        alpha: ab.a, beta: ab.b, plRatio: plRatio, winRate: winRate,
        maxWin: maxWin, maxLoss: maxLoss, maxHold: maxHold, avgHold: avgHold,
        wins: wins.length, losses: losses.length, nTrades: S.trades.length,
        posVal: posVal, benchRet: benchRet, rank: rankOf(sh),
        timing: abil.timing, timingHit: abil.timingHit,
        select: abil.select, hitA: abil.hitA, retB: abil.retB, scoreA: abil.scoreA, scoreB: abil.scoreB
      };
      // 2) 全部算完才提交
      S.positions = [];
      S.over = true;
      // r30：挑战局结算 → 先快照既有最佳（区分首次/刷新），再记录本机在这颗种子上的最好成绩
      SEED_BEST_PREV = S.seed ? seedBestOf(S.seed) : null;
      if (S.seed) saveSeedBest(S.seed, totalRet);
      saveProgress();   // 结算后也存盘（over 局下次打开可"继续"进结算报告）
      archiveGame();    // 本局战绩归档进本机历史（r18）
      renderSettle();
    } catch (e) {
      S.positions = posBackup;
      S.trades.length = trBackupLen;
      S.over = false;
      console.error('[结算] 计算异常：', e);
      toast('结算计算异常，请重试');
    }
  }

  // 同期沪深300涨幅（对照基准）
  function benchReturn() {
    var bd = IX.hs300.d, bc = IX.hs300.c;
    var i0 = seriesEndIdx(IX.hs300, DAYS[S.startIdx]);
    var i1 = seriesEndIdx(IX.hs300, DAYS[S.curIdx]);
    if (!bc[i0]) return NaN;
    return (bc[i1] - bc[i0]) / bc[i0] * 100;
  }

  function renderSettle() {
    var st = S.stats, rank = st.rank;
    var benchTxt = isFinite(st.benchRet)
      ? '<b class="' + cls(st.benchRet) + '">' + pct(st.benchRet) + '</b>'
      : '--';
    var html = '<h2>结算报告</h2>' +
      '<div class="st-reveal">' +
      (S.revealed
        ? '<span class="lb" style="color:var(--dim);font-size:12px">本局区间</span>' +
          '<b>' + fmtDate(DAYS[S.startIdx]) + '</b> → <b>' + fmtDate(DAYS[S.curIdx]) + '</b>' +
          '<span class="note" style="flex-basis:100%;margin-top:6px">共 ' + GAME_BARS + ' 个交易日 · 同期沪深300 ' + benchTxt + '</span>'
        : '<button id="btn-reveal">🔍 显示真实日期</button>' +
          '<span class="note">本局真实起止日期待揭晓（不影响重开新局）</span>') +
      '</div>' +
      '<div class="st-top"><div class="st-rank rank-' + rank + '">' + rank + '</div>' +
      '<div class="st-sum"><div class="st-eq ' + cls(st.finalEq - INIT_CASH) + '">' + money(st.finalEq) + '</div>' +
      '<div class="st-sub">总收益 <b class="' + cls(st.totalRet) + '">' + pct(st.totalRet) + '</b> · 年化 <b class="' +
      cls(st.annual) + '">' + pct(st.annual) + '</b></div></div></div>' +
      '<table class="st-table"><tbody>' +
      row('夏普比率', st.sharpe != null && isFinite(st.sharpe) ? st.sharpe.toFixed(3) : '--', '评级 S>3 / A>2 / B>1 / C>0') +
      row('择时能力', st.timing.toFixed(1) + '%', '大盘方向踩中 ' + st.timingHit.toFixed(0) + '%（80%命中=满分100%）', true) +
      row('选股能力', st.select.toFixed(1) + '%', '中位数命中 ' + st.hitA.toFixed(0) + '%(+50) · 日均 ' + pct(st.retB) + '(0.5%/日=+50)', true) +
      row('最大回撤', '-' + st.mdd.toFixed(2) + '%') +
      row('阿尔法 α (年化)', st.alpha != null && isFinite(st.alpha) ? pct(st.alpha * 100) : '--', '相对沪深300') +
      row('贝塔 β', st.beta != null && isFinite(st.beta) ? st.beta.toFixed(3) : '--', '相对沪深300') +
      row('盈亏比', isFinite(st.plRatio) ? st.plRatio.toFixed(2) : (st.plRatio === Infinity ? '∞' : '--'), '平均盈利 / 平均亏损') +
      row('胜率', st.winRate.toFixed(1) + '%', '盈利 ' + st.wins + ' / 亏损 ' + st.losses + ' 笔') +
      row('最大单笔盈利', money(st.maxWin)) +
      row('最大单笔亏损', money(st.maxLoss)) +
      row('最大持仓天数', st.maxHold + ' 天') +
      row('平均持仓天数', st.avgHold.toFixed(1) + ' 天') +
      row('交易笔数', st.nTrades + ' 笔') +
      row('期末持股市值', money(st.posVal)) +
      '</tbody></table>';

    if (S.trades.length) {
      html += '<h3>交易明细</h3><div class="st-trades">' + S.trades.map(function (t) {
        var r2 = (t.sell - t.cost) / t.cost * 100;
        var dt = S.revealed ? '<span class="tr-d">' + fmtDate(DAYS[t.buyIdx]) + '→' + fmtDate(DAYS[t.sellIdx]) + '</span>' : '';
        return '<div class="tr-row"><span>' + t.name + '</span><span>' + t.days + '天</span>' +
          '<span class="' + cls(t.pl) + '">' + money(t.pl) + ' (' + pct(r2) + ')</span>' +
          dt + (t.forced ? '<span class="forced">强平</span>' : '') + '</div>';
      }).join('') + '</div>';
    }
    el('settle-box').innerHTML = html;
    if (!S.revealed && el('btn-reveal')) {
      el('btn-reveal').onclick = function () { S.revealed = true; renderSettle(); };
    }
    renderSettleSeed();                 // r30 结算屏：本局种子 + 成绩分享文案
    el('screen-game').style.display = 'none';
    el('screen-settle').style.display = 'block';
  }

  // r30 结算屏底部的「挑战种子分享区」：直接把可转发的分享内容写出来
  function renderSettleSeed() {
    var box = el('settle-seed');
    if (!box) return;
    var payload = currentSeed();
    if (!payload || !S.stats) { box.style.display = 'none'; return; }
    var st = S.stats;
    var elig = !!(S.seed && payload === S.seed);   // r30：换过池 / 局内增删过自选 → 不再计入该种子最佳成绩
    var prevBest = elig ? SEED_BEST_PREV : null;   // 结算瞬间快照（undefined/null = 首次挑战这颗种子）
    var fresh = elig && !prevBest;
    var beat = elig && !!prevBest && st.totalRet > prevBest.ret + 1e-9;
    var retTxt = (typeof st.totalRet === 'number') ? pct(st.totalRet) : '—';
    var benchTxt = (typeof st.benchRet === 'number' && isFinite(st.benchRet)) ? pct(st.benchRet) : '—';
    var bestTxt = elig
      ? (fresh ? '<b>首次挑战这颗种子</b>'
        : (beat ? '<b>刷新了你的最好成绩</b>'
          : (prevBest ? '你的最好成绩 <b class="' + cls(prevBest.ret) + '">' + pct(prevBest.ret) + '</b>' : '')))
      : '<span class="seed-dim">（本局更换过股票池/自选，未计入该种子最佳成绩）</span>';
    box.style.display = 'block';
    box.innerHTML =
      '<div class="ss-hd">🎯 本局种子 — 发给朋友，他们就能玩到一模一样的一局</div>' +
      '<div class="ss-best">本局 <b class="' + cls(st.totalRet) + '">' + retTxt + '</b>' +
        ' ｜ 同期沪深300 <b class="' + cls(st.benchRet) + '">' + benchTxt + '</b> ｜ ' + bestTxt +
      '</div>' +
      '<div class="ss-text" id="ss-text">' + escHtml(seedResultText()) + '</div>' +
      '<div class="ss-btns">' +
        '<button id="ss-copy-result" class="primary" title="复制种子加成绩，直接发群里">复制成绩文案</button>' +
        '<button id="ss-copy-seed" title="只复制种子">复制种子</button>' +
        '<button id="ss-view-seed" title="打开种子卡片">🎯 种子卡片</button>' +
      '</div>';
    var b1 = el('ss-copy-result'); if (b1) b1.onclick = function () { copyText(seedResultText(), '成绩文案已复制，去发给朋友吧'); };
    var b2 = el('ss-copy-seed'); if (b2) b2.onclick = function () { copyText(seedShareText(payload), '种子已复制'); };
    var b3 = el('ss-view-seed'); if (b3) b3.onclick = openSeedOutModal;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function row(k, v, note, hl) {
    return '<tr' + (hl ? ' class="hl"' : '') + '><td class="k">' + k + '</td><td class="v">' + v + '</td><td class="note">' + (note || '') + '</td></tr>';
  }

  // ---------- 提示 ----------
  var toastTimer = null;
  function toast(msg) {
    var t = el('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2200);
  }

  // ---------- 绑定 ----------
  function bind() {
    el('btn-start').onclick = function () { if (!S) { openModeModal(); return; } clearSave(); startGame(); };   // 开局：无预览先选玩法；有预览直接开始
    el('btn-resume').onclick = beginResume;                              // 继续上次存档：先联网补全行情再恢复
    el('btn-clear').onclick = function () { clearSave(); toast('已清除存档'); };
    el('btn-again').onclick = function () { clearSave(); openModeModal(); };   // 再来一局：清档 + 重新三选一
    // 开局模式弹窗（v5）：不提供"点遮罩关闭"——玩家必须选 A/B/C、「先不开局」或「继续上次存档」做出明确选择
    el('btn-mode-close').onclick = function () { closeModeModal(); syncEmptySelectHint(); };
    el('btn-mode-resume').onclick = function () { closeModeModal(); beginResume(); };
    el('mc-a').onclick = function () { startByMode('a'); };
    el('mc-b').onclick = function () { startByMode('b'); };
    el('mc-c').onclick = function () { startByMode('c'); };
    var mcd = el('mc-d'); if (mcd) mcd.onclick = function () { startByMode('d'); };
    var ms = el('mode-simple'), mcx = el('mode-complex');
    if (ms) ms.onclick = function () { setGameMode('easy'); };
    if (mcx) mcx.onclick = function () { setGameMode('full'); };
    // 模式C 勾选器：同样不点遮罩关闭，用「← 返回」回到玩法选择
    el('pk-back').onclick = function () { closePickModal(); openModeModal(); };
    el('pk-q').addEventListener('input', function () { PK.shown = 0; renderPickList(); });
    el('pk-ind').addEventListener('change', function () { PK.shown = 0; renderPickList(); });
    el('pk-clear').onclick = clearPickSel;
    el('pk-more').onclick = function () { renderPickList(); };
    el('pk-go').onclick = startCustomPool;
    el('pick-list').addEventListener('click', function (e) {
      var n = e.target;
      while (n && n !== this && !n.getAttribute('data-code')) n = n.parentNode;
      if (n && n !== this && n.getAttribute('data-code')) togglePickCode(n.getAttribute('data-code'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pick-chip'), function (ch) {
      ch.onclick = function () { setPickCat(ch.getAttribute('data-cat')); };
    });
    el('btn-next').onclick = function () { nextDay(1); };
    el('btn-f5').onclick = function () { nextDay(5); };
    el('btn-f20').onclick = function () { nextDay(20); };
    el('btn-buy').onclick = buy;
    el('btn-sell').onclick = sell;
    el('btn-buymax').onclick = buyMax;
    el('btn-sellall').onclick = sellAll;
    el('btn-buyhalf').onclick = function () { buyFrac(0.5); };
    el('btn-sellhalf').onclick = function () { sellFrac(0.5); };
    el('btn-buyquarter').onclick = function () { buyFrac(0.25); };
    el('btn-sellquarter').onclick = function () { sellFrac(0.25); };
    el('btn-settle').onclick = openSettleModal;
    el('modal-settle-cancel').onclick = closeSettleModal;
    el('modal-settle-ok').onclick = function () { closeSettleModal(); settle(); };
    el('btn-compare').onclick = toggleMulti;
    el('btn-compare-off').onclick = toggleMulti;
    el('btn-repool').onclick = openRepoolModal;
    // 双击版本号 → 自定义开局日期（选股页底部 / 顶栏版本徽章均可）
    var vbs = el('ver-badge-sel'); if (vbs) vbs.ondblclick = openStartModal;
    var vbt = el('ver-badge'); if (vbt) vbt.ondblclick = openStartModal;
    var smd = el('modal-start');
    if (smd) {
      el('start-cancel').onclick = closeStartModal;
      el('start-ok').onclick = applyStartChoice;
      smd.addEventListener('click', function (e) { if (e.target === this) closeStartModal(); });
    }
    // 副图指标条：手机折叠/展开 — 点标题行整个区域切换，展开后重算布局
    var ct = el('chart-tools'), sf = el('sub-fold');
    if (ct && sf) {
      function toggleFold() {
        var folded = ct.classList.toggle('fold');
        sf.textContent = folded ? '▼' : '▲';
        if (!folded) {
          // 展开后重算 K 线画布高度（副图数量可能变化，layout 内部读取 subs 计算）
          setTimeout(function () { if (mainChart) layout(); }, 50);
        }
      }
      // 点标题行或收纳按钮均可切换
      var title = ct.querySelector('.ct-title');
      if (title) title.style.cursor = 'pointer';
      var tipm = ct.querySelector('.ct-tipm');
      if (tipm) tipm.style.cursor = 'pointer';
      sf.onclick = function (e) { e.stopPropagation(); toggleFold(); };
      if (title) title.onclick = function (e) { e.stopPropagation(); toggleFold(); };
      if (tipm) tipm.onclick = function (e) { e.stopPropagation(); toggleFold(); };
      // 手机默认收纳为一行
      if (isNarrow() && !ct.classList.contains('fold')) { ct.classList.add('fold'); sf.textContent = '▼'; }
    }
    // 移动端自选池底部的换池按钮，逻辑共用 openRepoolModal
    var brm = el('btn-repool-mobile'); if (brm) brm.onclick = openRepoolModal;
    // 右侧抽屉（持仓 / 新闻）的开关：PC 顶栏按钮隐藏；移动端点开抽屉；×/backdrop 关闭
    var bsm = el('btn-side'); if (bsm) bsm.onclick = toggleSideDrawer;
    var bsc = el('btn-side-close'); if (bsc) bsc.onclick = closeSideDrawer;
    var sbd = el('side-backdrop');
    if (sbd) {
      sbd.addEventListener('click', closeSideDrawer);
      sbd.addEventListener('touchstart', closeSideDrawer, { passive: true });
    }
    el('modal-repool-cancel').onclick = closeRepoolModal;
    el('modal-repool-ok').onclick = doRepool;
    el('modal-repool').addEventListener('click', function (e) { if (e.target === this) closeRepoolModal(); });
    // 池来源工具栏 / 自定义池（M3）
    var ps = el('pool-src');
    if (ps) ps.onchange = function () { applyPoolChange(null); };
    var bnp = el('btn-newpool'); if (bnp) bnp.onclick = function () { openNewPoolModal(); };
    var bep = el('btn-editpool'); if (bep) bep.onclick = openMinePoolEditor;
    var bpo = el('btn-pool-ops'); if (bpo) bpo.onclick = openMinePoolEditor;
    var bdp = el('btn-delpool'); if (bdp) bdp.onclick = delCurrentMinePool;
    el('modal-newpool').addEventListener('click', function (e) { if (e.target === this) closeNewPoolModal(); });
    el('np-cancel').onclick = closeNewPoolModal;
    el('np-ok').onclick = saveNewPool;
    el('multi-add-ix').onchange = function () { if (this.value) { addMulti('index', this.value); this.value = ''; } };
    el('multi-add-st').onchange = function () { if (this.value) { addMulti('stock', null, this.value); this.value = ''; } };
    el('modal-settle').addEventListener('click', function (e) { if (e.target === this) closeSettleModal(); });
    // r18：💡 小贴士
    var bt = el('btn-tip'); if (bt) bt.onclick = openTip;
    var tp = el('tip-prev'); if (tp) tp.onclick = function () { tipStep(-1); };
    var tn = el('tip-next'); if (tn) tn.onclick = function () { tipStep(1); };
    var tr = el('tip-rand'); if (tr) tr.onclick = function () { TIP_I = Math.floor(Math.random() * TIP_LIST.length); renderTip(); };
    var tc = el('tip-close'); if (tc) tc.onclick = closeTip;
    var mt = el('modal-tip');
    if (mt) mt.addEventListener('click', function (e) { if (e.target === this) closeTip(); });
    // r24：💝 打赏与建议（结算后入口）
    var bs2 = el('btn-support'); if (bs2) bs2.onclick = openSupport;
    var scb = el('support-close'); if (scb) scb.onclick = closeSupport;
    var ms = el('modal-support');
    if (ms) ms.addEventListener('click', function (e) { if (e.target === this) closeSupport(); });
    // r18：复盘本局（结算后回看 B/S）与返回结算报告
    var brv = el('btn-review'); if (brv) brv.onclick = enterReview;
    var brb = el('btn-review-back'); if (brb) brb.onclick = exitReview;
    // r18：🏆 历史战绩（开局前入口 + 结算后入口）
    var bh1 = el('btn-hist'); if (bh1) bh1.onclick = openHistory;
    var bh2 = el('btn-hist-from-settle'); if (bh2) bh2.onclick = openHistory;
    var hc = el('hist-close'); if (hc) hc.onclick = closeHistory;
    var hcl = el('hist-clear'); if (hcl) hcl.onclick = doClearHistory;
    var mh = el('modal-hist');
    if (mh) {
      mh.addEventListener('click', function (e) {
        if (e.target === this) closeHistory();
        var sbtn = (e.target.closest) ? e.target.closest('.hist-seed-btn') : null;
        if (sbtn) {   // r31：点「🎯 种子」= 复制该局种子，不触发展开/收起
          var nd = sbtn;
          while (nd && nd !== mh && !(nd.getAttribute && nd.getAttribute('data-hi'))) nd = nd.parentNode;
          if (nd && nd !== mh) {
            var a2 = loadHist();
            var hi2 = parseInt(nd.getAttribute('data-hi'), 10);
            var rec2 = a2[a2.length - hi2];
            var pl2 = rec2 ? histSeedPayload(rec2) : null;
            if (pl2) copyText(seedShareText(pl2), '本局种子已复制，发给朋友挑战吧');
            else toast('该局无法编码成种子');
          }
          return;
        }
        var node = e.target;
        while (node && node !== mh && !(node.getAttribute && node.getAttribute('data-hi'))) node = node.parentNode;
        if (node && node !== mh && node.getAttribute('data-hi')) {
          var item = node.classList.contains('hist-item') ? node : node.parentNode;
          if (item && item.classList) item.classList.toggle('open');
        }
      });
    }
    // 副图指标：单击开/关；长按(≥550ms)或右键 → 打开该指标参数设置
    (function () {
      var sb = el('sub-bar');
      var tmr = null, lpK = null, lpUntil = 0, x0 = 0, y0 = 0;
      function kOf(t) {
        var b = t;
        while (b && b !== sb && !(b.dataset && b.dataset.k)) b = b.parentNode;
        return (b && b !== sb && b.dataset.k) ? b.dataset.k : null;
      }
      function cancelLP() { if (tmr) { clearTimeout(tmr); tmr = null; } lpK = null; }
      function armSuppress() { lpUntil = Date.now() + 800; }   // 只吞长按松开后紧随的那一次 click（手机 touch 长按无自动 click，靠时间窗自动过期）
      sb.addEventListener('pointerdown', function (e) {
        var k = kOf(e.target);
        if (!k) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        cancelLP(); lpK = k;
        x0 = e.clientX; y0 = e.clientY;
        tmr = setTimeout(function () { tmr = null; if (lpK) { armSuppress(); openSubParam(lpK); } }, 550);
      });
      sb.addEventListener('pointermove', function (e) {
        if (tmr && (Math.abs(e.clientX - x0) > 10 || Math.abs(e.clientY - y0) > 10)) cancelLP();
      });
      sb.addEventListener('pointerup', cancelLP);
      sb.addEventListener('pointercancel', cancelLP);
      sb.addEventListener('pointerleave', cancelLP);
      sb.addEventListener('contextmenu', function (e) {
        var k = kOf(e.target);
        if (!k) return;
        e.preventDefault(); cancelLP(); armSuppress(); openSubParam(k);
      });
      sb.addEventListener('click', function (e) {
        if (Date.now() < lpUntil) { e.preventDefault(); e.stopPropagation(); lpUntil = 0; return; }
        var k = kOf(e.target);
        if (k) toggleChip(k);
      });
    })();
    // 指标参数设置弹窗
    var paramOk = el('param-ok');
    if (paramOk) paramOk.onclick = function () { closeSubParam(false); };
    var paramCancel = el('param-cancel');
    if (paramCancel) paramCancel.onclick = function () { closeSubParam(true); };
    var paramReset = el('param-reset');
    if (paramReset) paramReset.onclick = resetSubParam;
    // r21：均线分图「与主图一致」一键同步（把主图均线当前周期拷到分图窗口）
    var paramSync = el('param-sync');
    if (paramSync) paramSync.onclick = function () {
      if (!SUB_EDIT_K || SUB_EDIT_K !== 'ma-pane') return;
      var src = ChartEng.subParams('ma');
      ChartEng.setSubParams('ma-pane', src);
      openSubParam('ma-pane');            // 刷新输入框与标题（实时预览）
      toast('已同步为主图均线参数 MA(' + src.join(',') + ')');
    };
    // r21：重置全部指标参数（含主图均线/布林带/副图/拥挤度）
    var paramResetAll = el('param-reset-all');
    if (paramResetAll) paramResetAll.onclick = function () {
      if (!ChartEng.resetSubParamsAll) return;
      ChartEng.resetSubParamsAll();
      closeSubParam(false);
      if (mainChart) { if (!multiOn) renderGame(); else mainChart.draw(); }
      toast('已重置全部指标参数');
    };
    var modalParam = el('modal-param');
    if (modalParam) modalParam.addEventListener('click', function (e) { if (e.target === this) closeSubParam(true); });
    el('sub-add').addEventListener('change', function () {
      var k = this.value;
      if (k) { addSubBy(k); this.value = ''; }
    });
    // r21：布林带开关并入「指标设置」chips（CHIP_ORDER 首位段），此处不再单独绑定
    el('btn-chip').onclick = function () {
      chipOn = !chipOn;
      this.classList.toggle('on', chipOn);
      el('chip-chart').style.display = chipOn ? '' : 'none';
      layout();
      if (!multiOn) renderGame();
    };
    // ---------- r30 挑战种子：入口按钮 + 两个弹窗绑定 ----------
    var bss = el('btn-seed-start');
    if (bss) bss.onclick = function () { closeModeModal(); openSeedInModal(); };
    var tseed = el('tip-seed');
    if (tseed) tseed.onclick = function () { closeTip(); openSeedOutModal(); };   // 💡 面板里「分享本局种子」
    var sic = el('seed-in-cancel'); if (sic) sic.onclick = closeSeedInModal;
    var sio = el('seed-in-ok'); if (sio) sio.onclick = applySeedInput;
    var si = el('seed-input');
    if (si) si.addEventListener('input', function () { renderSeedPreview(this.value); });
    var msi = el('modal-seed-in');
    if (msi) msi.addEventListener('click', function (e) { if (e.target === this) closeSeedInModal(); });
    var soc = el('seed-out-close'); if (soc) soc.onclick = closeSeedOutModal;
    var socs = el('seed-out-copy-seed');
    if (socs) socs.onclick = function () { var p = currentSeed(); if (p) copyText(seedShareText(p), '种子已复制'); else toast('当前没有可分享的种子'); };
    var scor = el('seed-out-copy-result');
    if (scor) scor.onclick = function () { var t = seedResultText(); if (t) copyText(t, '成绩文案已复制'); else toast('当前没有可分享的种子'); };
    var mso = el('modal-seed-out');
    if (mso) mso.addEventListener('click', function (e) { if (e.target === this) closeSeedOutModal(); });
    document.addEventListener('keydown', function (e) {
      if (el('screen-game').style.display === 'none') return;
      if (el('modal-settle').style.display !== 'none') return;
      if (el('modal-repool').style.display !== 'none') return;
      if (el('modal-newpool').style.display !== 'none') return;
      if (NP_MODAL_OPEN) return;
      if (multiOn) return;
      if (e.key === 'ArrowRight') nextDay(1);
      if (e.key === 'ArrowDown') nextDay(5);
      if (e.key === 'b' || e.key === 'B') buy();
      if (e.key === 's' || e.key === 'S') sell();
    });
  }
  // ---------- 指标设置栏：主图叠加（均线/布林带）+ 副图指标 ----------
  function refreshSubBar() {
    var bar = el('sub-bar');
    if (!bar || !mainChart) return;
    var subs = mainChart.opts.subs || [];
    var html = '';
    CHIP_ORDER.forEach(function (k) {
      var meta = SUB_META[k];
      if (!meta) return;
      var on;
      if (k === 'ma') on = mainChart.opts.showMa;
      else if (k === 'boll') on = mainChart.opts.showBoll;
      else on = subs.indexOf(k) >= 0;
      html += '<button class="sub-btn' + (on ? ' on' : '') + '" data-k="' + k +
        '" title="' + meta.t + '（点击开关 · 长按/右键可调参数）">' + meta.l + '</button>';
    });
    bar.innerHTML = html;
  }
  // 点击：主图叠加型切换 showMa/showBoll；副图型进/出副图窗口列表
  function toggleChip(k) {
    if (!mainChart) return;
    if (k === 'ma' || k === 'boll') {
      if (k === 'ma') mainChart.opts.showMa = !mainChart.opts.showMa;
      else mainChart.opts.showBoll = !mainChart.opts.showBoll;
      refreshSubBar();
      if (!multiOn) renderGame(); else mainChart.draw();
      return;
    }
    toggleSub(k);
  }
  function toggleSub(k) {
    if (!mainChart) return;
    var subs = mainChart.opts.subs;
    var i = subs.indexOf(k);
    if (i >= 0) { if (subs.length <= 1) return; subs.splice(i, 1); }
    else {
      if (subs.length >= MAX_SUB) { toast('最多同时显示 ' + MAX_SUB + ' 个副图，请先关闭一个'); return; }
      subs.push(k);
    }
    refreshSubBar();
    if (!multiOn) renderGame(); else mainChart.draw();
  }
  function addSubBy(k) {
    if (!mainChart) return;
    if (mainChart.opts.subs.indexOf(k) >= 0) { toast('该副图已显示'); return; }
    if (mainChart.opts.subs.length >= MAX_SUB) { toast('最多同时显示 ' + MAX_SUB + ' 个副图，请先关闭一个'); return; }
    mainChart.opts.subs.push(k);
    refreshSubBar();
    if (!multiOn) renderGame(); else mainChart.draw();
  }

  // ---------- ⚙️ 副图指标参数设置（r20：长按/右键打开） ----------
  var SUB_EDIT_K = null;        // 正在编辑的指标
  var SUB_EDIT_BEFORE = null;   // 打开前的参数快照（取消时还原）
  var SUB_EDIT_DEF = null;      // 当前指标的 SUB_PDEF 定义

  function subParamTitle(label, arr, chn) {
    var f = label + (arr.length ? '(' + arr.join(',') + ')' : '');
    return f + (chn ? '　·　' + chn : '');
  }
  function openSubParam(k) {
    if (!mainChart) { toast('请先开始一局游戏'); return; }
    var def = (typeof ChartEng !== 'undefined' && ChartEng.SUB_PDEF) ? ChartEng.SUB_PDEF[k] : null;
    if (!def) return;
    SUB_EDIT_K = k;
    SUB_EDIT_BEFORE = ChartEng.subParams(k).slice();
    SUB_EDIT_DEF = def;
    var psBtn = el('param-sync');
    if (psBtn) psBtn.style.display = (k === 'ma-pane') ? '' : 'none';   // 「与主图一致」仅均线分图模式显示
    el('param-title').textContent = subParamTitle(def.label, SUB_EDIT_BEFORE, def.chn);
    el('param-desc').textContent = def.desc || '';
    var rows = el('param-rows');
    if (!def.params || !def.params.length) {
      rows.innerHTML = '<div class="param-none">该指标为纯显示型，无可调参数，用法见上方说明。</div>';
    } else {
      rows.innerHTML = def.params.map(function (p, i) {
        return '<div class="param-row">' +
          '<div class="pr-top"><label>' + p.n + '</label>' +
          '<input type="number" inputmode="numeric" min="' + p.min + '" max="' + p.max + '" step="1" value="' + SUB_EDIT_BEFORE[i] + '" data-i="' + i + '"></div>' +
          '<div class="pr-hint">' + p.tip + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(rows.querySelectorAll('input'), function (inp) {
        inp.addEventListener('input', function () {
          var idx = +this.dataset.i;
          var pd = SUB_EDIT_DEF.params[idx];
          var v = parseInt(this.value, 10);
          if (!isFinite(v)) v = pd.def;
          v = Math.max(pd.min, Math.min(pd.max, v));
          if (this.value !== String(v)) this.value = v;
          var arr = ChartEng.subParams(SUB_EDIT_K).slice();
          arr[idx] = v;
          ChartEng.setSubParams(SUB_EDIT_K, arr);
          el('param-title').textContent = subParamTitle(SUB_EDIT_DEF.label, arr, SUB_EDIT_DEF.chn);
          if (mainChart) mainChart.draw();   // 实时预览
        });
      });
    }
    el('modal-param').style.display = 'flex';
  }
  function closeSubParam(restore) {
    if (restore && SUB_EDIT_K && SUB_EDIT_BEFORE) {
      var cur = ChartEng.subParams(SUB_EDIT_K);
      var diff = cur.length !== SUB_EDIT_BEFORE.length ||
        cur.some(function (v, i) { return v !== SUB_EDIT_BEFORE[i]; });
      if (diff && SUB_EDIT_BEFORE.length) ChartEng.setSubParams(SUB_EDIT_K, SUB_EDIT_BEFORE);   // 无参数指标或值没变就不写存储
    }
    el('modal-param').style.display = 'none';
    SUB_EDIT_K = null; SUB_EDIT_BEFORE = null; SUB_EDIT_DEF = null;
    if (mainChart) mainChart.draw();
  }
  function resetSubParam() {
    if (!SUB_EDIT_K || !SUB_EDIT_DEF) return;
    var d = (SUB_EDIT_DEF.params || []).map(function (p) { return p.def; });
    ChartEng.setSubParams(SUB_EDIT_K, d);
    Array.prototype.forEach.call(el('param-rows').querySelectorAll('input'), function (inp) {
      var pd = SUB_EDIT_DEF.params[+inp.dataset.i];
      if (pd) inp.value = pd.def;
    });
    el('param-title').textContent = subParamTitle(SUB_EDIT_DEF.label, d, SUB_EDIT_DEF.chn);
    if (mainChart) mainChart.draw();
  }

  // ---------- 💡 炒股小贴士（r18 内置库） ----------
  var TIP_LIST = [
    'A股最小交易单位是 1 手 = 100 股。本游戏买卖数量请填"手"数，超出现金或持仓会自动提示。',
    'T+1 规则：今天买入的股票，明天才能卖出。界面上「可卖 0股(T+1)」就是提醒你还在锁定期。',
    '涨停板买不进、跌停板卖不出——真涨停一字板时别硬追，追高被闷杀是新手亏钱第一来源。',
    'ST 股涨跌停只有 ±5%，波动小但风险不小；注册制下的创业板/科创板（30/68 开头）是 ±20%，一天能亏很多。',
    '妖股往往放巨量、换手率极高、连续涨停。情绪来得快去得也快，快进快出，别把妖股当价值股拿。',
    '白马股=业绩稳、现金流好、常年涨得慢但稳；蓝筹股=市值大、权重高。二者适合「拿得住」的玩家。',
    '周期股（有色/煤炭/钢铁/化工）看的是经济周期：景气上行期业绩爆发，下行期估值再便宜也别接。',
    'ETF 是买一篮子股票，不怕单只暴雷。宽基（沪深300/中证500）吃市场平均，行业ETF 赌板块轮动。',
    '不要满仓一只票。分散到不同板块（本游戏抽池已按风格分类），单只踩雷也不至于伤筋动骨。',
    '学会止损：单笔亏损超过你能承受的仓位比例就果断离场。死扛的票，回本遥遥无期还可能退市。',
    '分批买入（半仓/四分之一仓按钮）比一把梭更适合波动市：跌了有子弹补仓，涨了不会踏空。',
    '均线是参考不是圣旨：多头排列（短>中>长）偏强，死叉别急着抄底——趋势比点位重要。',
    '放量突破平台往往代表资金进场，但也要防"假突破"：放巨量收长上影，多半是主力出货。',
    '缩量阴跌是最阴的走势——没有接盘侠，跌起来钝刀子割肉。别在持续缩量下跌中反复"抄底"。',
    '新闻是短线最好的燃料：利好高开别追，利空低开别慌割。市场交易的是"预期差"。',
    '本游戏的新闻栏在右侧「信息」抽屉里，市场要闻 + 个股新闻都在那，操盘前先看一眼当日消息。',
    '胜率不重要，盈亏比才重要：赢的时候赚大钱、亏的时候亏小钱，长期必赢。公式 = 平均盈利/平均亏损。',
    '夏普比率 = (收益 - 无风险利率) / 波动。它衡量"每冒一分风险换来多少收益"，评级 S>3 / A>2 / B>1 / C>0。',
    '最大回撤决定你的心理承受力：先跌 50% 要涨 100% 才能回本。所以控回撤 = 控仓位。',
    '融资（本游戏总资产≥50万解锁）是双刃剑：涨一倍收益，跌一半也可能爆仓。维持担保比例低于110%会被强平。',
    '不要频繁交易：每次买卖都有手续费（最低5元）。来回倒腾，手续费会悄悄吃掉你的收益。',
    '关注 0AMV 活跃市值：它反映全市场活跃资金。活跃度上行=机会多，低迷期少折腾。',
    '牛市捂股，震荡市高抛低吸，熊市空仓等待——先判断市场状态，再决定你的策略，别永远一个打法。',
    '学习看日K就够了：开盘价、收盘价、最高最低价讲完一天的故事。长上影=上方抛压重。',
    '同样一只票，不同人赚赔不同：差别在「买点」和「仓位」。B（买点）画在K线上，复盘时多看看自己的B买在什么位置。',
    '股票不是彩票：买之前问自己三个问题——为什么买？涨了怎么办？跌了怎么办？答不上来就别买。',
    'K线收盘后看成交量柱：价涨量增才健康；价涨量缩要警惕随时回落。',
    '板块轮动像击鼓传花：先涨的会歇脚，补涨的会跟上。别永远追已经涨上天的那一个。',
    '情绪管理是炒股第一课：连续盈利后容易飘、连续亏损后容易赌。每局结束后，回结算报告冷静复盘再开下一局。',
    '历史战绩会自动保存在本机浏览器里（最近40局）。开局前点「🏆 历史战绩」，用数据看自己到底擅长追涨还是抄底。'
  ];
  var TIP_I = -1;
  function openTip() {
    if (!TIP_LIST.length) return;
    if (TIP_I < 0) TIP_I = Math.floor(Math.random() * TIP_LIST.length);
    renderTip();
    el('modal-tip').style.display = 'flex';
  }
  function renderTip() {
    el('tip-kicker').textContent = '第 ' + (TIP_I + 1) + ' / ' + TIP_LIST.length + ' 条';
    var tb = el('tip-body');
    tb.textContent = TIP_LIST[TIP_I];
    tb.scrollTop = 0;
  }
  function tipStep(d) {
    if (!TIP_LIST.length) return;
    TIP_I = (TIP_I + d + TIP_LIST.length) % TIP_LIST.length;
    renderTip();
  }
  function closeTip() { el('modal-tip').style.display = 'none'; }

  // ---------- 复盘模式（r18：结算后只读回看本局盘面 + B/S 买卖点） ----------
  var REVIEW = false;
  function exitMultiNow() {
    multiOn = false;
    el('chart-wrap').style.display = 'flex';
    var cts = el('chart-tools'); if (cts) cts.style.display = '';
    el('trade-panel').style.display = '';
    el('multi-panel').style.display = 'none';
    var bc = el('btn-compare'); if (bc) bc.classList.remove('on');
    layout();
  }
  function enterReview() {
    if (!S || !S.over) return;
    if (multiOn) exitMultiNow();   // 复盘统一回到单图主界面
    REVIEW = true;
    closeSideDrawer();
    el('review-bar').classList.add('on');
    var sg = el('screen-game');
    sg.classList.add('review');
    el('screen-settle').style.display = 'none';
    sg.style.display = 'flex';
    renderGame();
  }
  function exitReview() {
    REVIEW = false;
    el('review-bar').classList.remove('on');
    var sg = el('screen-game');
    sg.classList.remove('review');
    sg.style.display = 'none';
    el('screen-settle').style.display = 'block';
  }

  // ---------- 🏆 历史战绩弹窗（r18） ----------
  var HIST_CLEAR_ARM = false;
  function openHistory() {
    var a = loadHist();
    var nn = el('hist-n'), sub = el('hist-sub');
    if (nn) nn.textContent = a.length ? '共 ' + a.length + ' 局' : '';
    if (sub) sub.textContent = a.length
      ? '战绩保存在<b>本机浏览器</b>（最多 40 局）。点任意一条展开看交易明细。'
      : '还没有历史战绩 — 结算一局后会自动记录在这里，下次打开仍可查看。';
    var box = el('hist-list');
    if (!a.length) {
      box.innerHTML = '<div class="hist-empty">📭 本机还没有历史战绩<br>去玩一局并结算，战绩会自动存入这里</div>';
    } else {
      box.innerHTML = a.map(function (r, i) {
        return histRowHtml(r, a.length - i);
      }).join('');
    }
    el('modal-hist').style.display = 'flex';
  }
  // r31：一条历史战绩对应的挑战种子载荷（优先用结算时快照 sd；旧档按标的池 + 起始日期回推编码）
  function histSeedPayload(r) {
    if (r && r.sd) return r.sd;
    if (!r || !r.pool || !r.pool.length) return null;
    var codes = r.pool.map(function (p) { return p.c; });
    var sIdx = (typeof r.sIdx === 'number') ? r.sIdx : DAYS.indexOf(String(r.s0));
    return encodeSeed(codes, sIdx >= 0 ? sIdx : 0) || null;
  }
  function rankColor(rk) {
    return ({ S: '#8957e5', A: '#238636', B: '#1f6feb', C: '#9e6a03', D: '#da3633' })[rk] || '#555';
  }
  function histRowHtml(r, no) {
    var tag = (r.simple ? '简单8' : '复杂18');
    var hasSeed = !!histSeedPayload(r);
    var head =
      '<div class="hist-head" data-hi="' + no + '">' +
      '<span class="hist-badge" style="background:' + rankColor(r.rank) + '">' + (r.rank || '-') + '</span>' +
      '<span class="hist-t"><b>#' + no + ' ' + r.mode + ' · ' + tag + '</b>' +
      '<span>' + fmtDate(r.s0) + ' → ' + fmtDate(r.s1) + ' · ' + r.days + ' 个交易日 · ' + r.nPool + ' 只标的</span></span>' +
      '<span class="hist-ret"><b class="' + cls(r.ret) + '">' + pct(r.ret) + '</b>' +
      '<span>' + money(r.eq) + '</span></span>' +
      (hasSeed ? '<button class="hist-seed-btn" data-hi="' + no + '" title="把这一局编成挑战种子，发给朋友即可玩到一模一样的一局">🎯 种子</button>' : '') +
      '</div>';
    var body = '<div class="hist-body">';
    var st = r.sh, ab = r.alpha, bt = r.beta, be = r.bench;
    var num = function (x) { return x != null && isFinite(x); };   // 存档 JSON 会把 NaN 转成 null，需一并判空
    body += '<div class="kv">' +
      '<span>期末总资产 <b>' + money(r.eq) + '</b></span>' +
      '<span>年化 <b class="' + cls(r.annual) + '">' + pct(r.annual) + '</b></span>' +
      '<span>夏普 <b>' + (num(st) ? st.toFixed(3) : '--') + '</b></span>' +
      '<span>最大回撤 <b>-' + (r.mdd != null ? r.mdd.toFixed(2) : '--') + '%</b></span>' +
      '<span>α <b>' + (num(ab) ? pct(ab * 100) : '--') + '</b></span>' +
      '<span>β <b>' + (num(bt) ? bt.toFixed(3) : '--') + '</b></span>' +
      '<span>胜率 <b>' + (r.wr != null ? r.wr.toFixed(1) : '--') + '%</b></span>' +
      '<span>交易 <b>' + r.nTr + ' 笔</b></span>' +
      '<span>最大单笔盈利 <b class="up">' + money(r.maxWin) + '</b></span>' +
      '<span>最大单笔亏损 <b class="dn">' + money(r.maxLoss) + '</b></span>' +
      '<span>平均持仓 <b>' + (r.avgHold != null ? r.avgHold.toFixed(1) : '--') + ' 天</b></span>' +
      '<span>同期沪深300 <b class="' + cls(be) + '">' + (num(be) ? pct(be) : '--') + '</b></span>' +
      '</div>';
    if (r.pool && r.pool.length) {
      body += '<div style="margin-bottom:6px">标的池：' + r.pool.map(function (p) {
        return p.n + '<span style="opacity:.6">(' + (CAT_LABEL[p.t] || p.t) + ')</span>';
      }).join('、') + '</div>';
    }
    if (r.trs && r.trs.length) {
      body += '<div class="trs">交易明细' + (r.trunc ? '（仅前300笔）' : '') + '：' + r.trs.map(function (t) {
        return '<div class="hist-tr"><span class="h-ic">' + (t.f ? '⚡' : '·') + '</span>' +
          '<span>' + t.n + '</span>' +
          '<span style="opacity:.7">' + fmtDate(DAYS[t.b]) + '→' + fmtDate(DAYS[t.x]) + ' · ' + t.d + '天</span>' +
          '<span class="' + cls(t.pl) + '">' + money(t.pl) + '</span></div>';
      }).join('') + '</div>';
    } else {
      body += '<div class="trs">交易明细：无</div>';
    }
    body += '</div>';
    return '<div class="hist-item" data-hi="' + no + '">' + head + body + '</div>';
  }
  function closeHistory() { el('modal-hist').style.display = 'none'; HIST_CLEAR_ARM = false; }
  // r24：💝 打赏与建议（感谢文案 + 反馈邮箱 + 赞赏二维码）
  function openSupport() {
    var m = el('modal-support');
    if (m) m.style.display = 'flex';
  }
  function closeSupport() { var m = el('modal-support'); if (m) m.style.display = 'none'; }
  function doClearHistory() {
    var btn = el('hist-clear');
    if (!HIST_CLEAR_ARM) {
      HIST_CLEAR_ARM = true;
      if (btn) btn.textContent = '再点一次确认清空';
      setTimeout(function () { HIST_CLEAR_ARM = false; if (btn) btn.textContent = '清空历史'; }, 3000);
      return;
    }
    HIST_CLEAR_ARM = false;
    try { localStorage.removeItem(HIST_LS); } catch (e) {}
    if (btn) btn.textContent = '清空历史';
    openHistory();
    toast('已清空全部历史战绩');
  }

  // ---------- 结算确认弹窗 ----------
  function openSettleModal() {
    if (!S || S.over) return;
    el('modal-settle').style.display = 'flex';
  }
  function closeSettleModal() { el('modal-settle').style.display = 'none'; }

  // ---------- 多图对比（内联，保留左/下/右栏，范围与主图同步） ----------
  var multiOn = false, multiItems = [], multiId = 0;
  var multiView = { viewBars: 120, date: null };

  function onMultiView(viewBars, date) {
    if (viewBars) multiView.viewBars = viewBars;
    if (date) multiView.date = date;
    renderMulti();
  }
  function fillMultiAdds() {
    if (!S) return;
    var sel = el('multi-add-st');
    if (sel) {
      var h = '<option value="">+ 个股（池内）</option>';
      sortedPool().forEach(function (p) { h += '<option value="' + p.code + '">' + p.name + '</option>'; });
      sel.innerHTML = h;
    }
    var ix = el('multi-add-ix');
    if (ix) {
      var h2 = '<option value="">+ 指数 / ETF</option>';
      IDX_OPTIONS.forEach(function (o) { h2 += '<option value="' + o.k + '">' + o.n + '</option>'; });
      ix.innerHTML = h2;
    }
  }
  function toggleMulti() {
    if (!S || S.over || !mainChart || !mainChart.data) return;
    multiOn = !multiOn;
    var cts = el('chart-tools');
    if (multiOn) {
      // 进入：以当前主图视图（缩放 + 截止日）为基准
      multiView.viewBars = mainChart.viewBars;
      multiView.date = mainChart.data.d[mainChart.endIdx];
      if (!multiItems.length) {
        el('multi-grid').innerHTML = '';   // 清空历史残留卡片，避免与旧 DOM 叠加成 8 卡
        addMulti('stock', null, S.sel);
        panelSel.forEach(function (k) { addMulti('index', k); });
      }
      el('chart-wrap').style.display = 'none';
      el('chart-tools').style.display = 'none';   // 主图已被多图替换，副图栏一并隐藏
      // 多图模式保留买卖栏：点左侧自选池即可切换当前交易标的，第一张个股卡片会同步跟随，
      // 桌面浮动面板与网格底部留白由 CSS #multi-panel.with-trade #multi-grid 避开。
      // 手机：block 流式（内容把页面撑长，一列逐张滚动浏览）；桌面：flex 双列网格
      el('multi-panel').style.display = isNarrow() ? 'block' : 'flex';
      el('multi-panel').classList.add('with-trade');
      el('btn-compare').classList.add('on');
      renderMulti();
    } else {
      el('chart-wrap').style.display = 'flex';
      if (cts) cts.style.display = '';
      el('trade-panel').style.display = '';
      el('multi-panel').style.display = 'none';
      el('multi-panel').classList.remove('with-trade');
      el('btn-compare').classList.remove('on');
      layout();
      renderGame();
    }
  }
  function addMulti(kind, key, code) {
    multiItems.push({ id: ++multiId, kind: kind, key: key, code: code, card: null, head: null, canvas: null, chart: null });
    renderMulti();
  }
  function removeMulti(id) {
    for (var i = 0; i < multiItems.length; i++) {
      if (multiItems[i].id === id) {
        if (multiItems[i].card && multiItems[i].card.parentNode) multiItems[i].card.parentNode.removeChild(multiItems[i].card);
        multiItems.splice(i, 1);
        break;
      }
    }
    renderMulti();
  }
  function buildCard(it) {
    var card = document.createElement('div');
    card.className = 'mc-card';
    var head = document.createElement('div');
    head.className = 'mc-head';
    var title = document.createElement('span');
    title.className = 'mc-t';
    var series = it.kind === 'stock' ? KL.stocks[it.code] : seriesOf(it.key);
    title.textContent = series ? series.name : it.key;
    head.appendChild(title);
    if (it.kind === 'stock') {
      var sel = document.createElement('select');
      sel.className = 'mc-sel';
      S.pool.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.code; o.textContent = p.name;
        if (p.code === it.code) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { it.code = this.value; renderMulti(); };
      head.appendChild(sel);
    }
    var x = document.createElement('button');
    x.className = 'mc-x'; x.textContent = '×';
    x.onclick = function () { removeMulti(it.id); };
    head.appendChild(x);
    card.appendChild(head);
    var cv = document.createElement('canvas');
    cv.className = 'mc-cv';
    card.appendChild(cv);
    el('multi-grid').appendChild(card);
    it.card = card; it.head = head; it.canvas = cv;
  }
  function renderMulti() {
    if (!multiOn || !S) return;
    var grid = el('multi-grid');
    var csG = getComputedStyle(grid);
    // grid 的 clientWidth 含内边距，需扣除后才是可放置卡片的宽度，否则卡片/canvas 溢出被裁
    var padLR = (parseFloat(csG.paddingLeft) || 0) + (parseFloat(csG.paddingRight) || 0);
    var usable = grid.clientWidth - padLR;
    if (usable <= 0) return;
    var padTB = (parseFloat(csG.paddingTop) || 0) + (parseFloat(csG.paddingBottom) || 0);
    var gap = 8;
    // 手机：1+1+1+1 一列纵排（替换主图显示，页面变长逐张浏览）；桌面 2×2
    var cols = isNarrow() ? 1 : 2;
    var n = multiItems.length || 1;
    var rows = Math.ceil(n / cols);
    var gh = grid.clientHeight - padTB;
    var rowH, cw;
    if (isNarrow()) {
      // 手机：每张图约半屏高，纵向放大可看清；不依赖 grid 可用高度（页面随内容变长）
      var vh = window.innerHeight || 800;
      rowH = Math.max(240, Math.round(vh * 0.5));
    } else {
      // 桌面：按网格可用高度均分行（gap 只算实际间隔 (rows-1)）
      rowH = Math.max(140, Math.floor((gh - (rows - 1) * gap) / rows));
    }
    // 卡片精确宽度：同源同 gap，避免 canvas 比格子窄或溢出
    cw = Math.floor((usable - (cols - 1) * gap) / cols);
    multiItems.forEach(function (it) { if (!it.canvas) buildCard(it); });
    multiItems.forEach(function (it) {
      if (it.card) it.card.style.height = rowH + 'px';   // 显式卡高 → 内部 canvas flex 精确填充
      var headH = it.head ? it.head.offsetHeight : 24;
      var h = Math.max(80, rowH - headH - 6);
      // 桌面卡高不超卡宽（最高 1:1）；手机单列纵向看盘，允许细长画布
      if (!isNarrow()) h = Math.min(h, cw - 2);
      if (!it.chart) it.chart = new ChartEng.KChart(it.canvas, { subs: ['vol'], showMa: true, showBoll: false, maPad: false, pxTag: false, onView: onMultiView });
      var series = it.kind === 'stock' ? KL.stocks[it.code] : seriesOf(it.key);
      if (!series) return;
      // 头部（标题 + 下拉框）与 it.code 保持同步（左侧点股联动时 code 会变）
      if (it.head) {
        var hsel = it.kind === 'stock' ? it.head.querySelector('.mc-sel') : null;
        if (hsel && hsel.value !== it.code) hsel.value = it.code;
        var ht = it.head.querySelector('.mc-t');
        if (ht && ht.textContent !== series.name) ht.textContent = series.name;
      }
      var end = seriesEndIdx(series, multiView.date);
      var maxI = seriesEndIdx(series, DAYS[S.curIdx]);   // 防未来函数：不超过当前游戏日
      // 标签锚点 = 开局日(T0)：个股按自身序列、指数按指数序列，横轴天数从开局日起算
      var a0 = it.kind === 'stock'
        ? startAnchorFor(it.code, series, DAYS[S.startIdx])
        : seriesEndIdx(series, DAYS[S.startIdx]);
      it.chart.opts.title = (it.kind === 'stock' ? KL.stocks[it.code].name : series.name);
      it.chart.opts.baseIdx = HIDE ? a0 : null;
      it.chart.opts.markers = (it.kind === 'stock') ? markersOf(it.code) : null;   // 个股卡标注 B/S，指数/ETF卡不标
      it.chart.viewBars = multiView.viewBars;
      it.chart.resize(cw - 2, h - 2);
      it.chart.setData(series, end);
      it.chart.maxIdx = maxI;
    });
  }

  // ---------- 启动 ----------
  global.__DBG = function () {
    var probe = null;
    try {
      var c = resolveCands(curSrc);
      var catCnt = {};
      c.forEach(function (o) { catCnt[o.cat] = (catCnt[o.cat] || 0) + 1; });
      var s0 = samplePool(c, []);
      var s1 = samplePool(c, []);
      probe = { candN: c.length, catCnt: catCnt, s0: s0.length, s1: s1.length, first: s0[0] ? s0[0].code : null };
    } catch (e) { probe = { err: String(e).slice(0, 300) }; }
    // 选中标的的红绿统计（真机验证 K 线颜色用；Bug 特征 close≈low → redPct 趋近 0）
    var selK = null;
    try {
      var ss = S && S.sel ? KL.stocks[S.sel] : null;
      if (ss && ss.c && ss.c.length) {
        var red = 0, eqLow = 0, n = ss.c.length;
        for (var qi = 0; qi < n; qi++) {
          if (ss.c[qi] >= ss.o[qi]) red++;
          if (ss.c[qi] === ss.l[qi]) eqLow++;
        }
        selK = { code: S.sel, name: ss.name, n: n, redPct: Math.round(red / n * 1000) / 10, eqLowPct: Math.round(eqLow / n * 1000) / 10 };
      }
    } catch (e) { selK = { err: String(e).slice(0, 120) }; }
    return { ver: GAME_VERSION, S: S ? { pool: S.pool.length, poolCodes: S.pool.map(function (p) { return p.code; }), day: S.day, sel: S.sel } : null,
      mainBars: mainChart ? mainChart.viewBars : null, narrow: isNarrow(),
      stats: OL.stats, curSrc: curSrc, probe: probe, selK: selK };
  };
  global.GameApp = {
    boot: function () {
      if (!IX || !UNI.stocks.length) {
        document.body.innerHTML = '<p style="color:#f66;padding:40px">基础数据包未加载（data_index / data_universe）</p>';
        return;
      }
      bind();
      buildPanelSelects();
      var vb = el('ver-badge'); if (vb) vb.textContent = GAME_VERSION;
      var vbs = el('ver-badge-sel'); if (vbs) vbs.textContent = GAME_VERSION;
      // v4：不再自动抽股；开局先三选一（A内置精选 / B全市场 / C自定义勾选），选定后才抽取
      var rb = el('btn-resume'); if (rb) rb.style.display = canResume() ? '' : 'none';
      syncEmptySelectHint();
      openModeModal();
    }
  };
  // 无预览时的选股屏提示
  function syncEmptySelectHint() {
    if (S && S.pool && S.pool.length) return;
    var hc = el('pool-count-hint');
    if (hc) hc.innerHTML = '尚未抽取标的 — 点击「开始你的交易人生」选择玩法（A 精选股票池 / B 全市场随机 / C 自定义股票池 / D ETF+LOF）';
    var si = el('start-info');
    if (si) si.innerHTML = '等待选择玩法…';
    var dd = el('pool-src');
    if (dd) dd.value = poolKey(curSrc);
  }
})(window);
