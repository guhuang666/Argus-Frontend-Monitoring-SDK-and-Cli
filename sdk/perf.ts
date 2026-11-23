/**
 * 性能监控 —— LCP / CLS / INP 三个 Core Web Vitals（FR-1.11）。
 *
 * 与错误域最大的区别：它**必须等到页面退场才能结账**。
 * LCP 会一直被更大的元素覆盖，CLS 是累加值，INP 要取所有交互里最差的那个 ——
 * 三项都只有到 hidden 那一刻才有定论，所以统一打包、退场时单发一条。
 *
 * 出口也在这里（transport），理由见 errors.ts 顶部：错误与性能是两条互不相通的链路。
 */
import { genId, perfUrl, tagOf } from './common'
import { PERF_ENDPOINT, SDK_NAME, SDK_VERSION, options } from './config'
import { resolveUser } from './identity'
import { currentSession, touchSession } from './session'
import type { PerfEvent } from './types'

/* ==========================================================================
 * 三个观察器 + 归因（FR-1.11）
 * ==========================================================================
 * 和错误采集最大的不同：
 *   错误 = 事件驱动，出事那一刻上报；
 *   性能 = 页面生命周期结束时才有最终值，必须在退场时打包发出。
 *
 * 三个指标各有各的"定稿时机"，都不能采一个报一个：
 *   LCP —— 陆续出现更大的元素，每次都要覆盖，取最后一个
 *   CLS —— 累加值，每次布局偏移往上加
 *   INP —— 取所有交互里最差的那个
 *
 * 退场时机用 visibilitychange，禁用 unload / beforeunload（FR-1.17）。
 * 页面彻底关闭时 visibilitychange 一定触发（hidden 是必经状态），
 * 而 beforeunload 在移动端和部分场景会被跳过。
 * ========================================================================*/

/** LCP 当前值；每次出现更大的元素就覆盖 */
let lcpValue = 0;
/** 触发 LCP 的元素，用来做归因 */
let lcpElement: string | null = null;
/** CLS 累加值 */
let clsValue = 0;
/** INP 当前最差值 */
let inpValue = 0;
/** 触发 INP 的交互类型 */
let inpTarget: string | null = null;
/** 触发 INP 的元素标签名 */
let inpElement: string | null = null;
/** INP 的时间主要花在哪一段 */
let inpPhase: PerfEvent['attribution']['inp_phase'] = null;
/** 导航类型（navigate / reload / back_forward），从 LCP 条目上取 */
let navigationType: string | null = null;
/** 已发出的观察器，退场前用 takeRecords() 把队列里没派发的条目收干净 */
const perfObservers: PerformanceObserver[] = [];
/**
 * 观察器 → 它的处理函数。
 *
 * 存在的唯一原因：`takeRecords()` 返回条目并清空队列，但**不会触发回调**。
 * 退场时要把返回值手动喂回 handler，否则最后那批条目（往往是最有价值的一次交互）
 * 会被直接丢掉。见 flushPerf。
 */
const perfHandlers = new WeakMap<PerformanceObserver, (entries: PerformanceEntry[]) => void>();
/** 只上报一次：visibilitychange 会触发多次（切走、切回、再切走） */
let perfFlushed = false;

/**
 * 设备与网络上下文。**必须在 init 时就抓，不能等到退场**：
 * 退场那一刻页面可能已经被冻结，`window` / `navigator` 的读取有失败风险。
 * 这几个值在页面生命周期内基本不变，早抓晚抓一样。
 */
const perfContext = (() => {
  let viewport = '';
  let dpr = 0;
  let connection: string | null = null;
  try {
    viewport = `${window.innerWidth}x${window.innerHeight}`;
    dpr = window.devicePixelRatio;
  } catch {
    // 非浏览器环境
  }
  try {
    // Network Information API：Chrome 系支持，Safari / Firefox 没有，拿不到就是 null
    const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
    connection = nav.connection?.effectiveType ?? null;
  } catch {
    // 静默
  }
  return { viewport, dpr, connection };
})();


/**
 * 一次交互的耗时拆成三段，返回最长的那段。
 *
 *   用户按下 → processingStart      输入延迟：主线程忙，事件排队等着
 *            → processingEnd        事件处理：你的回调执行
 *            → startTime + duration 呈现延迟：等下一帧画出来
 *
 * 三段互斥且加起来就是 duration，所以"哪段最长"直接决定开什么药方：
 *   input-delay  → 拆长任务 / 放 Worker
 *   processing   → 优化回调里的代码
 *   presentation → 减少 DOM、简化样式
 */
function pickInpPhase(
  entry: PerformanceEntry & { processingStart?: number; processingEnd?: number },
): PerfEvent['attribution']['inp_phase'] {
  const start = entry.processingStart;
  const end = entry.processingEnd;
  // Safari 等实现可能没有这两个字段，拿不到就不猜
  if (typeof start !== 'number' || typeof end !== 'number') return null;

  const inputDelay = start - entry.startTime;
  const processing = end - start;
  const presentation = entry.startTime + entry.duration - end;

  // 相等时优先算前面那段：前面的延迟意味着问题更靠上，更值得优先处理
  if (inputDelay >= processing && inputDelay >= presentation) return 'input-delay';
  if (processing >= presentation) return 'processing';
  return 'presentation';
}

/** 订阅一个性能条目类型。不支持该 type 的浏览器会抛错，静默跳过 */
function observe(type: string, handler: (entries: PerformanceEntry[]) => void): void {
  try {
    const observer = new PerformanceObserver((list) => {
      try {
        handler(list.getEntries());
      } catch {
        // 单批数据解析失败不能影响后续采集
      }
    });
    // buffered 必开：SDK 执行时页面往往已经加载了一部分，不开会漏掉之前发生的条目
    observer.observe({ type, buffered: true } as PerformanceObserverInit);
    perfObservers.push(observer);
    // 记下处理函数：takeRecords() 不会触发回调，退场时要手动喂回去
    perfHandlers.set(observer, handler);
  } catch {
    // 老浏览器不支持 PerformanceObserver 或该 type，跳过
  }
}

/** 订阅三个指标 */
function installPerfObservers(): void {
  // ① LCP：每次出现更大的元素都会回调一次，取最后一条即可
  //    顺带取 navigationType —— 它在 PerformanceNavigationTiming 上，但 LCP 条目也带着，
  //    在这里顺手记下来就不用再查一次 performance.getEntriesByType('navigation')
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (!last) return;
    const lcpEntry = last as PerformanceEntry & { renderTime?: number; element?: unknown; navigationType?: string };
    lcpValue = lcpEntry.renderTime ?? 0;
    lcpElement = tagOf(lcpEntry.element);
    if (typeof lcpEntry.navigationType === 'string') navigationType = lcpEntry.navigationType;
  });

  // ② CLS：累加，但必须跳过"用户操作引起的偏移"——
  //    点了按钮导致元素移动是预期行为，不该算进稳定性问题
  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (shift.hadRecentInput) continue;
      clsValue += shift.value ?? 0;
    }
  });

  // ③ INP：取所有交互里最差的那个
  //    durationThreshold: 40 —— 只收耗时超过 40ms 的交互。
  //    不设的话每次点击都会进来，事件量白涨几十倍。
  //    注意规范最终取的是 P98（交互 < 50 次时才取最差），这里简化成取最差，
  //    属于已知偏差：交互很多的页面上数值会偏严格。
  const onInteraction = (entries: PerformanceEntry[]): void => {
    for (const entry of entries) {
      if (entry.duration <= inpValue) continue;
      const e = entry as PerformanceEntry & {
        processingStart?: number;
        processingEnd?: number;
        target?: unknown;
      };
      inpValue = entry.duration;
      inpTarget = entry.name; // pointerdown / keydown / click…
      inpElement = tagOf(e.target);
      inpPhase = pickInpPhase(e);
    }
  };

  // durationThreshold 必须配 PerformanceObserverInit 的断言：它在 lib.dom 里还是可选项
  try {
    const observer = new PerformanceObserver((list) => {
      try {
        onInteraction(list.getEntries());
      } catch {
        // 静默
      }
    });
    observer.observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    perfObservers.push(observer);
    perfHandlers.set(observer, onInteraction); // 退场补采用同一个 handler
  } catch {
    // 不支持 event 条目类型，跳过
  }
}

/** 组装性能事件。三项全空说明什么都没采到，没必要发 */
function buildPerf(): PerfEvent | null {
  const hasAny = lcpValue > 0 || clsValue > 0 || inpValue > 0;
  if (!hasAny) return null;

  return {
    event_id: genId(),
    // 会话：性能事件与错误事件同源，才能把"这次访问里出了错、同时很慢"关联起来
    session_id: currentSession().id,
    timestamp: new Date().toISOString(),
    // 用 perfUrl 去掉 hash、保留 query：锚点跳转不影响性能，但 query 是不同的页面
    url: perfUrl(location.href),
    user_agent: navigator.userAgent,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    // 性能事件同样带身份：否则「哪个用户的 LCP 最差」这类问题答不出来
    user: resolveUser(),
    metrics: {
      // 取整：LCP / INP 是毫秒，小数点后没有意义
      lcp: lcpValue > 0 ? Math.round(lcpValue) : null,
      // CLS 是很小的数（好的页面 < 0.1），取整会全变 0，保留 4 位
      cls: clsValue > 0 ? Number(clsValue.toFixed(4)) : null,
      // 用户全程没交互时 INP 无值 —— 报 null 而不是 0，别把"没测到"当成"完美"
      inp: inpValue > 0 ? Math.round(inpValue) : null,
    },
    attribution: {
      lcp_element: lcpElement,
      inp_target: inpTarget,
      inp_element: inpElement,
      inp_phase: inpPhase,
    },
    navigation_type: navigationType,
    device: {
      viewport: perfContext.viewport,
      dpr: perfContext.dpr,
    },
    connection: perfContext.connection,
  };
}

/** 退场：先把队列里没派发的条目收干净，再打包上报 */
function flushPerf(): void {
  if (perfFlushed) return;
  perfFlushed = true;

  try {
    // 关键一步：条目是攒批派发的，直接读变量可能漏掉最后几条。
    // 比如用户关页前刚有一次很差的交互，那条 event 条目还在队列里没派发。
    //
    // ⚠️ takeRecords() 只返回条目并清空队列，**不会触发回调** ——
    // 所以必须把返回值手动喂回 handler，否则这批（往往是最有价值的一条）
    // 会被直接丢掉。这正是本函数存在的意义，喂回去这一步不能省。
    for (const observer of perfObservers) {
      try {
        const pending = observer.takeRecords();
        if (pending.length > 0) perfHandlers.get(observer)?.(pending);
      } catch {
        // 单个观察器取失败不影响整体
      }
    }

    const payload = buildPerf();
    if (!payload) return;
    reportPerformance(payload);
  } catch {
    // 采集失败必须静默
  }
}

/** 挂退场监听 */
function installPerfExit(): void {
  // visibilitychange 覆盖"切标签页 / 最小化 / 关闭页面"；
  // pagehide 是最后一道保险，两个都挂，靠 perfFlushed 去重
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPerf();
  });
  window.addEventListener('pagehide', flushPerf);
}

/**
 * 性能采集入口。整体包一层：任何一步失败都不能影响宿主页面（TC-07）。
 *
 * 采样建议：性能是每次页面加载都上报，量级远大于错误。
 * 接入 FR-1.15 的确定性采样后，应在调用本函数之前就判断好，
 * 未命中直接不挂观察器 —— 比"采了再丢"省掉全部开销。
 */
export function setupPerformance(): void {
  try {
    installPerfObservers();
    installPerfExit();
  } catch {
    // 静默
  }
}

/**
 * 性能事件的出口（错误事件已改走下方的批量通道）。
 * POST JSON + keepalive（页面卸载时普通请求会被中断，keepalive 让浏览器把请求发完）。
 *
 * 公钥走请求头 X-Argus-Key。为什么不用 URL 上的 ?key=：
 *   ① URL 会进访问日志、Referer、浏览器历史，比请求头更容易被抄走
 *   ② fetch 能自由设头，没有必须用 query 的理由
 * 服务端也**只认请求头**（曾为 sendBeacon 退场通道预留过 ?key=，但本项目
 * 从未实现 sendBeacon 降级，那段接收逻辑已移除）。
 *
 * 只负责"发出去"，不判断成败 —— 网络失败一律静默，离线重试未实现。
 */
function transport(endpoint: string, payload: unknown, label: string): void {
  try {
    const key = options.key;
    if (key === undefined) {
      // 不静默：401 的根因在这里，而 401 在浏览器控制台只有一行"net::ERR"
      console.warn(`[argus] ${label}未上报：没有配置项目公钥（initArgus({ key })）`);
      return;
    }

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Argus-Key': key },
      body: JSON.stringify(payload),
      keepalive: true,
    })
      .then((res) => {
        if (res.ok) console.log(`[argus] ${label}上报成功 HTTP ${res.status}`);
        else console.warn(`[argus] ${label}上报失败 HTTP ${res.status}`);
      })
      .catch((err) => {
        console.warn(`[argus] ${label}上报请求失败`, err);
      });
  } catch (err) {
    // JSON.stringify 循环引用、fetch 被宿主禁用等
    console.warn(`[argus] ${label}上报异常`, err);
  }
}

/* ── 批量缓冲 ────────────────────────────────────────────────────────────
 *
 * 一条错误一个请求太贵：跨域 + 自定义头意味着每个请求前还有一次 OPTIONS 预检，
 * 所以「1 条错误 = 2 次往返」。攒批之后是「N 条错误 = N/50 个请求」。
 *
 * 触发只有三个：满 50 条、攒够 5 秒、页面要走了。
 *
 * ── 退场为什么"和平常一样"────────────────────────────────────────────────
 * 早期设计给退场单独定了一套更小的预算（20 条 / 48 KB / 裁剪）。结论是
 * 这里不需要：有 5 秒定时器兜着，关页时队列通常只有 0~3 条、几 KB。
 * 所以退场与常规**只差一个 keepalive**：
 *   · 常规批次页面还活着，普通 fetch 就够了，也不受 64 KB 限制；
 *   · 退场时普通 fetch 会被浏览器在卸载时直接取消，必须 keepalive。
 *
 * ⚠ 已知代价：「错误风暴中正好关页」时队列可能堆到几十条、上百 KB，
 * 而带 keepalive 的请求体超过 64 KB 会被浏览器整批拒绝（`.catch` 里能看到）。
 * 这一版接受它：不做字节记账、不切块、不裁剪 —— 换来的是一个 50 行的批量层。
 * ────────────────────────────────────────────────────────────────────── */

/** 性能事件上报。走独立出口，理由见本段开头 */
function reportPerformance(payload: PerfEvent): void {
  // 与 report 同理：性能上报也是活动证据。
  // 但注意这条上报通常发生在 hidden 时（退场），touchSession 会因不可见而直接返回 ——
  // 那是正确行为：用户已经走了，不该给会话续命。
  touchSession();
  const { lcp, cls, inp } = payload.metrics;
  console.log(
    `[argus] 即将上报性能 → LCP ${lcp ?? '无'} / CLS ${cls ?? '无'} / INP ${inp ?? '无'}` +
      (inp !== null ? ` (${payload.attribution.inp_element ?? '?'} · ${payload.attribution.inp_phase ?? '?'})` : ''),
  );
  transport(PERF_ENDPOINT, payload, '性能指标');
}
