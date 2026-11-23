/**
 * 通用工具 —— 不含任何业务状态的小函数。
 *
 * 全模块唯一"零依赖"层：不 import 别的东西，也不碰 options / 全局状态。
 * 代价是影响半径最大 —— genId / redact / tagOf 被多个域共用，
 * 改一个函数的签名会牵动整个 SDK。加新东西之前先问一句"它真的无状态吗"。
 */

/** 生成事件 ID。crypto.randomUUID 只在安全上下文（https / localhost）可用，需兜底 */
export function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 活动节流器。
 *
 * 为什么不引 lodash：只需要这几行，而 SDK 有 15 KB 的体积硬约束（SRS §9.1）。
 * 为什么第一次要立刻执行：用户点第一下就该算"在场"；若要等 30 秒后才记第一次，
 * 那 30 秒里用户在系统眼里就"没活动"了。
 */
export function throttle(fn: () => void, waitMs: number): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < waitMs) return;
    last = now;
    fn();
  };
}

/** unhandledrejection 的 reason 可能是字符串、对象、甚至 undefined，统一转成 Error */
export function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  try {
    return new Error(JSON.stringify(reason));
  } catch {
    return new Error(String(reason));
  }
}

/**
 * 取元素标签名。用 Duck Typing 而不是 HTMLElement：
 *   - LCP 可能是 SVG 元素，它不是 HTMLElement
 *   - INP 的 target 在某些实现里也不是标准元素
 * 取不到一律返回 null，绝不抛错。
 */
export function tagOf(el: unknown): string | null {
  try {
    const tag = (el as { tagName?: unknown } | null)?.tagName;
    return typeof tag === 'string' ? tag : null;
  } catch {
    return null;
  }
}

/** 把元素描述成一行人话；不取文本内容，免得把用户数据带出去 */
export function describeElement(el: HTMLElement): string {
  const tag = tagOf(el) ?? 'element';
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/)[0]}`
      : '';
  return `${tag.toLowerCase()}${id}${cls}`.slice(0, 80);
}

/**
 * URL 脱敏：只留 origin + pathname，query 与 hash 一律丢掉。
 * query 里经常躺着 token、手机号、邮箱，hash 里常有路由参数，都不该进监控数据。
 * 注意：只对面包屑用。错误事件自身字段（如资源通道的 source）必须原样保留（TC-10）。
 */
export function redact(url: string): string {
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
    // hash 只在"看着像路由"时保留（#/orders、#!/orders）；#frag 和 OAuth 隐式流的
    // #access_token=… 一律丢掉，别把凭证带出去
    const hash = /^#!?\//.test(u.hash) ? u.hash.split('?')[0] : '';
    return `${u.origin}${u.pathname}${hash}`;
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

/**
 * 性能指标的 URL 清洗：**只丢 hash，保留 query**。
 *
 * 和 redact() 的区别，以及为什么不能复用：
 *   redact() 是给面包屑用的，连 query 一起丢 —— 因为 query 里常有 token、手机号。
 *   但性能是按页面统计的，`?page=2` 和 `?tab=orders` 是不同的页面，
 *   把 query 丢了会让看板上所有分页/筛选态合并成一行，趋势和排行全部失真。
 *
 * hash 则一定要丢：锚点跳转（#item-3）不影响加载性能，却会把同一个页面分裂成多行。
 * 代价是 query 里的敏感参数会进监控数据 —— 与性能数据的可用性之间，这里选了可用性，
 * 因为上报体里本来就有完整 URL 的场景（资源通道），一致处理更简单。
 */
export function perfUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return href.split('#')[0];
  }
}

/** 挂一个采集器，失败只记日志：一个类目挂了不该拖垮其它类目（TC-07） */
export function safeInstall(label: string, install: () => void): void {
  try {
    install();
  } catch (err) {
    console.warn(`[argus] ${label}挂载失败`, err);
  }
}
