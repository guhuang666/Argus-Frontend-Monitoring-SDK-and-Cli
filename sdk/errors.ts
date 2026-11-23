/**
 * 错误监控 —— 三条采集通道 + 它们自己的出口。
 *
 * 出口在这里而不在单独的传输模块里，是有意的：错误走批量（满 50 条 / 每 5 s /
 * 退场 → /api/v1/error/batch），性能走单发，两者不共享任何状态或代码。
 * 为什么必须分开：/api/v1/error 的 DTO 只认错误事件的字段，后端 ValidationPipe
 * 开了 whitelist —— 性能字段发过去会被**静默剥掉**（不报错，数据凭空消失）。
 *
 * 三条通道共用 common() 拼公共字段，各自补上自己的差异部分：
 *   onerror            有 Error 对象，有 filename / lineno / colno
 *   unhandledrejection 有 reason，但可能不是 Error
 *   resource           没有 Error 对象，唯一线索是出错的那个元素
 */
import { snapshot } from './breadcrumbs'
import { genId, toError } from './common'
import { ERROR_BATCH_ENDPOINT, SDK_NAME, SDK_VERSION, options } from './config'
import { resolveUser } from './identity'
import { currentSession, touchSession } from './session'
import type { CapturedError, Mechanism } from './types'

/** browser-extension 之类上报上来只会污染数据，直接丢弃 */
const IGNORED_SCHEME = /^(chrome|moz|safari|ms-browser)-extension:\/\//;

/** 可能是加载失败的元素：img / script 用 src，link 用 href */
type ResourceTarget = HTMLElement & { src?: string; href?: string };

/** 扩展的资源或扩展抛的错：不是宿主站点的问题，一律丢弃 */
function isExtension(url: string | undefined): boolean {
  return IGNORED_SCHEME.test(url ?? '');
}

/* ==========================================================================
 * 事件组装 + 两条 window 级通道
 * ========================================================================
 * 三条采集通道共用 common() 拼公共字段，各自补上自己的差异部分：
 *   onerror            有 Error 对象，有 filename / lineno / colno
 *   unhandledrejection 有 reason，但可能不是 Error
 *   resource           没有 Error 对象，唯一线索是出错的那个元素
 * ========================================================================*/

/** 三条通道共用的字段，集中写一处，免得每个构造函数各写一遍 */
function common(mechanism: Mechanism) {
  return {
    event_id: genId(),
    // 会话：与事件同一时刻取快照（离线补报时也要归到"发生时"的那个会话）
    session_id: currentSession().id,
    mechanism,
    timestamp: new Date().toISOString(),
    url: location.href,
    user_agent: navigator.userAgent,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    // 版本与环境：没配时是 undefined，JSON.stringify 会整个丢掉这个 key，
    // 后端 DTO 是 @IsOptional 的，最终落 NULL（不是空串）
    release: options.release,
    environment: options.environment,
    // 用户维度：三条错误通道共用，所以放在 common 里一次覆盖
    user: resolveUser(),
    // 出错这一刻拍照：三条通道自动全覆盖
    breadcrumbs: snapshot(),
  };
}

function build(mechanism: Exclude<Mechanism, 'resource'>, err: Error, source = ''): CapturedError {
  return {
    ...common(mechanism),
    type: err.name || 'Error',
    message: err.message,
    stack: err.stack ?? '',
    source,
  };
}

/** 资源失败：没有 Error 对象，唯一线索是那个元素。扩展资源返回 null，调用方丢弃 */
function buildResource(el: ResourceTarget): CapturedError | null {
  const tag = el.tagName.toLowerCase();
  const url = el.src || el.href || '';
  return {
    ...common('resource'),
    type: tag,
    message: `资源加载失败 <${tag}>${url ? ` ${url}` : ''}`,
    stack: '',
    source: url,
  };
}

/**
 * 安装两条 window 级错误通道。
 *
 * onerror 这一个事件混着两种来源，靠 event.target 分流：
 *   运行时错误 —— 浏览器在 window 上派发（target 就是 window），有 message / error / stack
 *   资源失败   —— 浏览器在那个元素上派发（target 是 img / script / link…），这些字段全无
 * 资源错误不冒泡，能收到全靠第三个参数 true；元素游离在文档外则收不到
 * （传播路径里没有 window，capture 也救不了）。
 */
export function installErrorChannels(): void {
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      try {
        const target = event.target;
        // target 不是 window → 是某个元素加载失败
        if (target && target !== window) {
          const resource = buildResource(target as ResourceTarget);
          if (resource !== null) report(resource);
          return;
        }

        const err = event.error ?? new Error(event.message);
        report(build('onerror', err, `${event.filename}:${event.lineno}:${event.colno}`));
      } catch (err) {
        // 采集自身出错必须静默，不能把宿主页面搞崩
        console.warn('[argus] 采集失败', err);
      }
    },
    true, // 捕获阶段，否则部分错误收不到
  );

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const err = toError(event.reason);
      report(build('unhandledrejection', err));
    } catch (err) {
      console.warn('[argus] 采集失败', err);
    }
  });
}

/** 单批最多几条。满了立刻发，不等定时器 */
export const MAX_BATCH = 50;

/** 攒批最长等多久。没有它，半天不出一条错的页面就永远发不出去 */
export const FLUSH_INTERVAL_MS = 5000;

/**
 * 待发的错误事件。
 *
 * 队列里放**事件本身**，不放序列化后的字符串 —— 序列化只在 sendBatch 里做一次，
 * 免得同一件事在内存里存两份、改字段时还要同步维护第二份。
 */
const pendingErrors: CapturedError[] = [];
let flushTimer: number | null = null;

/**
 * 武装定时器。
 *
 * 只在队列非空时武装一次，**不是 setInterval**：空队列每秒醒一次纯属浪费电池。
 * 后台标签页里定时器会被浏览器节流到分钟级 —— 这个偏差可以接受，
 * 因为退场那两个监听器仍会在页面真的走的时候把数据带出去。
 *
 * 回调里**不**把 flushTimer 置空：那是 flush() 的职责，见那里的注释。
 * 同一个变量只在两处被写（这里设、flush 里清），读代码时"谁负责清"才有唯一答案。
 */
function armFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flush(false);
  }, FLUSH_INTERVAL_MS);
}

/** 入队：不再一条一发，满了或到点了才发 */
function enqueue(payload: CapturedError): void {
  pendingErrors.push(payload);
  if (pendingErrors.length >= MAX_BATCH) return flush(false);
  armFlushTimer();
}

/**
 * 发一批错误事件。
 *
 * `keepalive` 是本函数唯一的调用差异：
 *   · 常规 → false。keepalive 的请求体硬上限是 64 KB，而 50 条事件很容易超；
 *     且常规批次发出时页面还活着，根本不需要它。
 *   · 退场 → true。否则请求会在卸载时被浏览器取消，等于白攒。
 */
function sendBatch(events: readonly CapturedError[], keepalive: boolean): void {
  try {
    const key = options.key;
    if (key === undefined) {
      // 不静默：401 的根因在这里，而 401 在浏览器控制台只有一行"net::ERR"
      console.warn('[argus] 错误事件未上报：没有配置项目公钥（initArgus({ key })）');
      return;
    }

    fetch(ERROR_BATCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Argus-Key': key },
      body: JSON.stringify({ events }),
      keepalive,
    })
      .then((res) => {
        if (res.ok) console.log(`[argus] 批量上报成功 HTTP ${res.status}（${events.length} 条）`);
        else console.warn(`[argus] 批量上报失败 HTTP ${res.status}（${events.length} 条）`);
      })
      .catch((err) => {
        // 退场批次超过 64 KB 时浏览器会在这里 reject。页面已经走了，只能记一笔
        console.warn('[argus] 批量上报请求失败', err);
      });
  } catch (err) {
    // JSON.stringify 循环引用、fetch 被宿主禁用等
    console.warn('[argus] 批量上报异常', err);
  }
}

/**
 * 把缓冲区发出去。
 *
 * 幂等性靠"摘走即清空"实现，不设 flag：`visibilitychange` 与 `pagehide`
 * 会在关页时连着触发两次，第二次进来队列已经空了，自然 no-op。
 */
function flush(exit: boolean): void {
  // ⚠ 这两行必须是函数体的第一件事。
  //  定时器那条路径也靠它归零（回调里刻意不写），一旦把它们挪到任何提前 return
  //  之后，闹钟响完 flushTimer 就还是非 null 值 → armFlushTimer 会以为"还有闹钟
  //  在等"直接返回 → 之后再也不会武装新定时器，只能等攒满 50 条才发。
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingErrors.length === 0) return;

  sendBatch(pendingErrors.splice(0), exit);
}

/**
 * 挂退场发送。
 *
 * 两个事件都挂是刻意的：`visibilitychange → hidden` 覆盖"切标签页 / 最小化 / 关页"，
 * `pagehide` 是最后一道保险（有些场景 hidden 之后页面就被冻结，pagehide 仍会派发）。
 *
 * 禁用 unload / beforeunload（FR-1.17）：移动端根本不保证触发，而 hidden 是必经状态。
 */
export function installBatchExit(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));
}

function report(payload: CapturedError): void {
  // 一条事件本身就是"用户还在"的证据 —— 顺手续一下会话寿命。
  // 放在这里而不是 common() 里：common() 已经在构造时有过一次 currentSession()，
  // 而 touchSession 带可见性判断，语义不同（这里是"确实要发出去了"）。
  // 攒批之后"发出去"变成了"进队列"，但语义不变：这条事件确实产生了。
  touchSession();
  enqueue(payload);
}
