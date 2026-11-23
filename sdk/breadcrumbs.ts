/**
 * 面包屑 —— 出错前的用户轨迹。
 *
 * 它是唯一"平时不上报"的模块：全局一个环形缓冲一直在滚，
 * 只有错误发生那一刻才 snapshot() 拍一张照片附在事件里。
 * 没出错就随页面关闭一起丢掉，一条都不发。
 *
 * 四个采集器（点击 / 路由 / 请求 / 控制台）纪律统一：
 * 先存原装引用 → 记一笔 → 原样转发 → 自身出错静默。
 */
import { describeElement, redact } from './common'
import { isOwnRequest } from './config'
import type { Breadcrumb } from './types'

/** 环形缓冲上限：满了顶掉最旧的 */
const BREADCRUMB_MAX = 50;

/* ==========================================================================
 * 存储 + 四个采集器（FR-1.10 的四类）
 * ==========================================================================
 * 它是一台"行车记录仪"：全局只有一个数组，一直在滚（最多 50 条，满了顶掉最旧的）。
 * 出错那一刻调用 snapshot() 拍一张照片（值拷贝 —— 各错误各拿各的），附在事件里上报。
 * 没出错 → 这些数据随页面关闭一起丢掉，一条都不发。
 * 要加淘汰规则 = 改 addBreadcrumb，结构不用动。
 *
 * 四个采集器都靠"包裹全局方法"实现，纪律统一：
 *   先存原装引用 → 记一笔 → 原样转发 → 自身出错静默
 * ========================================================================*/

const breadcrumbs: Breadcrumb[] = [];

function addBreadcrumb(crumb: Breadcrumb): void {
  try {
    breadcrumbs.push(crumb);
    if (breadcrumbs.length > BREADCRUMB_MAX) breadcrumbs.shift(); // 满了顶掉最旧的
  } catch {
    // 记线索失败必须静默：采集不能影响宿主应用（TC-07）
  }
}

/** 拍照：值拷贝（slice），不是把原数组交出去 —— 否则后续行为会污染已上报的事件 */
export function snapshot(): Breadcrumb[] {
  return breadcrumbs.slice();
}

/** ① 点击：挂在 document 的捕获阶段，宿主 stopPropagation 拦不住 */
export function installClickBreadcrumbs(): void {
  document.addEventListener(
    'click',
    (event) => {
      try {
        const el = event.target as HTMLElement | null;
        if (!el || !el.tagName) return;
        addBreadcrumb({ timestamp: Date.now(), category: 'click', level: 'info', message: describeElement(el) });
      } catch {
        // 静默：记线索不能影响宿主应用
      }
    },
    true,
  );
}

/** 上一次记录到的 URL（脱敏后）。popstate / hashchange 触发时地址已经变了，只能靠它还原 from */
let lastPath = '';

function pushNavigation(via: string, from: string, to: string): void {
  try {
    lastPath = to;
    addBreadcrumb({
      timestamp: Date.now(),
      category: 'navigation',
      level: 'info',
      message: `${via} → ${to}`,
      data: { from, to },
    });
  } catch {
    // 静默
  }
}

/** ② 路由：pushState / replaceState **不派发任何事件**，只能包裹；另有两个原生事件 */
export function installNavigationBreadcrumbs(): void {
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: unknown[]): void {
      // 必须在转发之前记录：此刻 location 还是旧地址，args[2] 才是新地址
      try {
        const from = redact(location.href);
        pushNavigation(method, from, redact(args[2] == null ? location.href : String(args[2])));
      } catch {
        // 静默
      }
      (original as (...a: unknown[]) => void).apply(this, args); // 原样转发
    } as unknown as History[typeof method];
  }

  // 前进 / 后退不触发 pushState，只会触发 popstate；hash 路由同理。
  // 这两个事件触发时地址已经变了，from 只能用上一次记住的
  const onUrlChange = (via: string): void => {
    try {
      const to = redact(location.href);
      pushNavigation(via, lastPath || to, to);
    } catch {
      // 静默
    }
  };
  window.addEventListener('popstate', () => onUrlChange('popstate'));
  window.addEventListener('hashchange', () => onUrlChange('hashchange'));
}

/**
 * ③ 请求：包裹 fetch 与 XHR。
 * 只记 method / 脱敏后的 URL / 状态码 / 耗时，**不记请求体与响应体**。
 * 这里也是 FR-1.6（失败请求上报）将来要落地的位置。
 */
export function installHttpBreadcrumbs(): void {
  // —— fetch ——
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const start = Date.now();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = redact(url);
      const skip = isOwnRequest(path); // 别把 SDK 自己的上报记成面包屑

      return originalFetch.call(window, input, init).then(
        (res) => {
          if (!skip) {
            addBreadcrumb({
              timestamp: Date.now(),
              category: 'http',
              level: res.ok ? 'info' : 'error',
              message: `${method} ${path} → ${res.status}`,
              data: { method, status: res.status, duration: Date.now() - start },
            });
          }
          return res; // 原样返回，不改变宿主拿到的结果
        },
        (err: unknown) => {
          if (!skip) {
            addBreadcrumb({
              timestamp: Date.now(),
              category: 'http',
              level: 'error',
              message: `${method} ${path} → 网络失败`,
              data: { method, duration: Date.now() - start },
            });
          }
          throw err; // 原样抛出，绝不吞掉
        },
      );
    } as typeof window.fetch;
  }

  // —— XMLHttpRequest ——
  const proto = XMLHttpRequest.prototype as unknown as {
    open: (...args: unknown[]) => void;
    send: (...args: unknown[]) => void;
  };
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const requests = new WeakMap<XMLHttpRequest, { method: string; path: string }>(); // 只挂在实例上

  proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    try {
      requests.set(this, {
        method: String(args[0] ?? 'GET').toUpperCase(),
        path: redact(String(args[1] ?? '')),
      });
    } catch {
      // 静默
    }
    originalOpen.apply(this, args); // 原样转发
  };

  proto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
    const start = Date.now();
    try {
      this.addEventListener('loadend', () => {
        try {
          const req = requests.get(this);
          if (!req || isOwnRequest(req.path)) return;
          const { status } = this;
          const ok = status >= 200 && status < 400;
          addBreadcrumb({
            timestamp: Date.now(),
            category: 'http',
            level: ok ? 'info' : 'error',
            // status === 0：网络错误、被 CORS 拦下、或请求被中断
            message: `${req.method} ${req.path} → ${status === 0 ? '网络失败' : status}`,
            data: { method: req.method, status, duration: Date.now() - start },
          });
        } catch {
          // 静默
        }
      });
    } catch {
      // 静默
    }
    originalSend.apply(this, args); // 原样转发
  };
}

/** ④ 控制台：包裹 log / warn / error；原样转发 + 跳过 SDK 自己的日志 */
export function installConsoleBreadcrumbs(): void {
  for (const method of ['log', 'warn', 'error'] as const) {
    const original = console[method].bind(console); // 先存原始引用，否则会递归
    console[method] = (...args: unknown[]): void => {
      try {
        // 只做 String + 截断：对象不序列化，免得循环引用或爆体积
        const text = args.map((a) => String(a)).join(' ').slice(0, 200);
        // 跳过自家输出，否则每条错误的轨迹里都是监控系统自己的日志
        if (!text.startsWith('[argus]')) {
          addBreadcrumb({
            timestamp: Date.now(),
            category: 'console',
            level: method === 'error' ? 'error' : method === 'warn' ? 'warning' : 'info',
            message: text,
          });
        }
      } catch {
        // 静默
      }
      original(...args); // 原样转发，绝不吞
    };
  }
}
