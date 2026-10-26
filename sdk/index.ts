/**
 * Argus Browser SDK —— 错误捕捉 + 性能指标 + 上报
 *
 * 三个错误通道：未捕获异常、未处理的 Promise 拒绝、资源加载失败。
 * 三个性能指标：LCP / CLS / INP，页面退场时打包上报（FR-1.11）。
 * 上报用 fetch + keepalive，保证页面卸载时也送得出去。
 * 面包屑：点击 / 路由 / 请求 / 控制台四类齐全（对应 FR-1.10）。
 *
 * 未实现：时间窗淘汰、退场通道裁剪、用户/会话、
 *        体积裁剪、退场通道降级、离线重试、FR-1.6 的失败请求上报、
 *        性能指标采样（FR-1.15，采样应在 setupPerformance 之前判断）、
 *        FCP / TTFB / 白屏检测。
 *        版本（release / environment）只上了错误通道，性能通道的对应字段
 *        待后端 IngestPerfDto 补上后再一起发 —— 现在发过去会被 whitelist 静默剥掉。
 * 已知缺陷：reason / event.error 非 Error 时会生成指向本文件内部的"假堆栈"，
 *        应改为 stack 发空串（待修）。
 * 已知限制：性能只在【第一次】hidden 时上报一次（perfFlushed 锁死），
 *        用户切走再回来那段时间的指标不再补报；bfcache 恢复后同理。
 *        这是为了避开重复上报而做的取舍，要改成多次上报需先解决去重口径。
 *        INP 算法简化为"取最差"，规范是交互 ≥ 50 次时取 P98。
 * 待联调：性能接口 POST /api/v1/performance 已实现（backend/src/performance），
 *        但尚未在真实 MongoDB 上跑通端到端。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 文件结构（七层，自下而上，每层只依赖它上面的层）
 *
 *   ① 类型定义      对外契约：CapturedError / PerfEvent / Breadcrumb
 *   ② 常量与配置    地址、上限、正则
 *   ③ 通用工具      不含业务状态的小函数（URL 处理、元素描述、包装辅助）
 *   ④ 面包屑        存储 + 点击 / 路由 / 请求 / 控制台 四个采集器
 *   ⑤ 错误采集      事件组装 + 两条 window 级通道
 *   ⑥ 性能采集      三个观察器 + 退场打包
 *   ⑦ 上报出口      传输 + 两个出口 + 入口 initArgus()
 *
 * 读代码的建议路径：
 *   想知道整体怎么启动   → 直接翻到文件最后
 *   想知道性能怎么采     → 找 ⑥
 *   想知道 URL 怎么处理  → 找 ③
 * ─────────────────────────────────────────────────────────────────────────
 */

/* ==========================================================================
 * ① 类型定义 —— SDK 对外的数据契约
 * ========================================================================*/

/** 采集通道 */
export type Mechanism = 'onerror' | 'unhandledrejection' | 'resource';

export interface CapturedError {
  /** 事件唯一 ID，后端据此去重（重试或 keepalive 重复投递时同一事件会到两次） */
  event_id: string;
  /**
   * 会话标识（M5 / FR-1.23）。
   *
   * 同一次访问内的所有事件共享同一个值，判定规则见下方"会话"那段注释。
   * 后端用它算 PV / UV / 错误率 —— 错误率的分母就是会话数，不是事件数。
   */
  session_id: string;
  /** 采集通道 */
  mechanism: Mechanism;
  /** Error.name，如 TypeError；资源通道是标签名，如 img */
  type: string;
  /** 原始 message，未做归一化；资源通道形如「资源加载失败 <img> https://…」 */
  message: string;
  /** 整段 error.stack 原文，后端负责解析成帧；资源通道没有堆栈，恒为空串 */
  stack: string;
  /** 出错位置：运行时错误形如 app.js:12:34；资源通道是失败的资源 URL；Promise 通道为空串 */
  source: string;
  timestamp: string;
  url: string;
  user_agent: string;
  sdk: { name: string; version: string };
  /**
   * 发布版本号，形如 web@1.2.4。M3 的 Sourcemap 处理按它匹配产物文件（FR-3.4），
   * 后端 error_events.release 靠这个字段才有值。
   *
   * 可空：没配置时整个 key 不会出现在 JSON 里（stringify 会丢掉 undefined），
   * 后端落 NULL。「没带版本」和「版本是空串」必须分开 —— 后者会污染按版本的聚合。
   */
  release?: string;
  /** 运行环境，如 production / staging。可空，理由同 release */
  environment?: string;
  /**
   * 触发这条事件的用户标识。null = 此刻拿不到身份（既没有登录态、匿名兜底也关掉了）。
   *
   * 为什么是 `{ id }` 而不是裸字符串：以后要加 `username` / `segment` 之类的维度时，
   * 不用再改一次契约。**只放 ID，不放邮箱手机号** —— 上报链路没理由承担 PII 风险。
   */
  user?: { id: string } | null;
  /** 错误发生前的行为轨迹（最小版：只有点击） */
  breadcrumbs?: Breadcrumb[];
}

/**
 * initArgus() 的配置。
 *
 * 现在只有项目 key 与版本相关的几项，其余（采样率、ignoreErrors、beforeSend…）
 * 随里程碑陆续加 —— 一次只加当前真的会读的字段，避免出现"配了不生效"的空开关。
 */
export interface ArgusOptions {
  /**
   * 项目公钥，形如 argus_pub_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx。
   *
   * 它是**写权限的唯一凭据**：后端靠它判断"这条事件属于哪个项目"。
   * 所以它必须出现在浏览器里（也就是必须能公开），代价是别人也能拿它往你项目灌数据 ——
   * 这件事由服务端限流兜住，而不是靠"把 key 藏起来"。
   *
   * 不配的话上报一律 401，事件全部丢失。SDK 会在 init 时明确警告，
   * 但不会阻断采集（否则连"确实没配"这件事都看不见）。
   */
  key?: string;
  /**
   * 版本号，形如 web@1.2.4。**必须 ≤ 100 字符** —— 后端列宽是 VARCHAR(100)，
   * 超了整条错误事件会被判 400 丢掉（丢版本可以接受，丢错误不行）。
   *
   * 这个字符串要和 CLI 上传 Sourcemap 时的 --release 逐字节一致，
   * 否则 M3 的 Worker 查不到 map，只会安静降级成未符号化。
   */
  release?: string;
  /** 运行环境，如 production / staging。≤ 50 字符，理由同上 */
  environment?: string;

  /**
   * 用户标识的「拉取函数」（可选）。
   *
   * ── 为什么是拉而不是推（不提供 setUser）────────────────────────────────
   * 推模式要求宿主在「登录成功 / 登出 / 刷新后恢复登录态」三个地方各调一次，
   * 漏一处就有一段事件没有身份。拉模式由 SDK 在**每个事件产生的那一刻**调用它，
   * 宿主只需保证「调用时读得到最新值」，永远不用关心调用时机。
   *
   * ── 实现要求 ────────────────────────────────────────────────────────────
   * 必须**同步、轻量、不抛错**（每次报错都会执行一次）。别在里面发网络请求。
   * 返回值三种都认：`{ id }` / 裸 ID / `null`（null 表示此刻匿名）。
   */
  getUser?: () => { id: string | number } | string | number | null | undefined;

  /**
   * 用户身份的自定义探测源，按顺序尝试。**不配就用内置的常见位置**，
   * 所以多数宿主一行都不用写。传 `[]` 表示完全关闭自动探测。
   *
   * 语法：`window.KEY` / `localStorage:KEY` / `jwt:KEY`
   */
  userSources?: readonly string[];

  /**
   * 拿不到真实用户时，是否退化成匿名设备 ID（存 localStorage），默认 true。
   *
   * 开着才能让「零配置」也统计得出 UV / 影响用户数（设备级口径）。
   * 传 false 表示只统计登录用户 —— 此时未登录产生的事件 user 为 null。
   */
  anonymousId?: boolean;
}

/**
 * 性能指标事件（三个 Core Web Vitals）。
 *
 * 和错误事件的根本区别：错误是"出事才报"，性能是"每个页面都有值"。
 * 而且三个指标都不能采一个报一个：
 *   LCP 会随更大的元素出现不断更新，要取最后一个；
 *   CLS 是累加值，要攒到页面走；
 *   INP 要从所有交互里取最差的那个，同样要等交互结束。
 * 所以统一在页面进入 hidden 时一次性打包上报。
 */
export interface PerfEvent {
  event_id: string;
  /** 会话标识。与错误事件同源（currentSession），用来把 PV/性能归到同一次访问 */
  session_id: string;
  timestamp: string;
  url: string;
  user_agent: string;
  sdk: { name: string; version: string };
  /** 三项指标。拿不到的那项是 null，不是 0 —— 0 是合法值，用 0 会污染统计 */
  metrics: {
    /** Largest Contentful Paint，毫秒 */
    lcp: number | null;
    /** Cumulative Layout Shift，无单位小数 */
    cls: number | null;
    /** Interaction to Next Paint，毫秒；用户没交互过就是 null */
    inp: number | null;
  };
  /** 归因：光有数字没法优化，得知道是哪个元素/哪种交互 */
  attribution: {
    /** 触发 LCP 的元素标签名，如 IMG */
    lcp_element: string | null;
    /** 触发 INP 的交互类型，如 pointerdown */
    inp_target: string | null;
    /** 触发 INP 的元素标签名。光知道"点击慢"没法优化，得知道点的哪个元素 */
    inp_element: string | null;
    /**
     * INP 的时间花在哪一段：
     *   input-delay  —— 主线程被占着，事件排队等（要拆长任务 / 放 Worker）
     *   processing   —— 事件回调本身太重（要优化代码）
     *   presentation —— 渲染太贵（要减少 DOM / 简化样式）
     * 三段互斥，哪段最长记哪段。不知道是哪段就没法开药方。
     */
    inp_phase: 'input-delay' | 'processing' | 'presentation' | null;
  };
  /**
   * 导航类型。不看这个，看板上会出现大量"假警报"：
   * 用户刷新（reload）和从别的页返回（back_forward）的 LCP 天然比首次导航差。
   */
  navigation_type: string | null;
  /** 设备上下文。性能分位数在不同视口下差异巨大，不分维度算出来的 P75 没有指导意义 */
  device: {
    viewport: string;
    dpr: number;
  };
  /** 网络类型（Network Information API，仅部分浏览器支持），如 4g / 3g / slow-2g */
  connection: string | null;
  /** 用户标识。与错误事件同源（resolveUser），null 表示拿不到 */
  user?: { id: string } | null;
}

export interface Breadcrumb {
  /** 行为发生时刻（毫秒时间戳），用于排序与"只取错误之前"的过滤 */
  timestamp: number;
  category: 'click' | 'navigation' | 'http' | 'console';
  level?: 'info' | 'warning' | 'error';
  /** 一行人能读的描述，如 button#submit、GET /api/order → 500 */
  message: string;
  /** 结构化细节（状态码、耗时、from/to），别塞大对象 */
  data?: Record<string, unknown>;
}

/* ==========================================================================
 * ② 常量与配置
 * ========================================================================*/

/**
 * 上报地址，暂时写死为本机后端。
 *
 * 项目不再由 URL 里的路径区分（M4 之前是 /api/v1/error 一条通路），
 * 而是由请求头 X-Argus-Key 里的公钥反查 —— 所以这两个常量对所有项目都是同一个。
 */
export const ENDPOINT = 'http://localhost:3000/api/v1/error';

/** 性能指标上报地址 */
export const PERF_ENDPOINT = 'http://localhost:3000/api/v1/performance';

/** 上报公钥的前缀。只做形状检查，真正的合法性由服务端判断 */
const PUBLIC_KEY_PREFIX = 'argus_pub_';

const SDK_NAME = 'argus.browser';
const SDK_VERSION = '0.1.0';

/** 面包屑环形缓冲上限：满了顶掉最旧的 */
const BREADCRUMB_MAX = 50;

/** browser-extension 之类上报上来只会污染数据，直接丢弃 */
const IGNORED_SCHEME = /^(chrome|moz|safari|ms-browser)-extension:\/\//;

/**
 * SDK 自己的上报地址（脱敏后），用来把自己的请求排除在面包屑之外。
 *
 * 这两个常量在模块加载时就算好了。它们依赖下面的 redact()，而函数声明会提升，
 * 所以放在这里不构成初始化顺序问题。
 */
const ENDPOINT_PATH = redact(ENDPOINT);
const PERF_ENDPOINT_PATH = redact(PERF_ENDPOINT);

/**
 * 运行期配置。
 *
 * initArgus() 之前是空对象：页面一加载就抛错、而业务代码还没走到 init 的那段时间里，
 * 事件会不带版本上报。这是主动接受的：宁缺毋错，猜一个版本比不带更难查。
 */
let options: ArgusOptions = {};

/* ==========================================================================
 * ③ 通用工具 —— 不含业务状态的小函数
 * ========================================================================*/

/** 生成事件 ID。crypto.randomUUID 只在安全上下文（https / localhost）可用，需兜底 */
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/* ── 用户维度 ─────────────────────────────────────────────────────────────
 *
 * 浏览器里**没有**「当前登录用户」这个标准 API —— 这个信息只存在于宿主自己的
 * 登录体系里（token / 用户对象）。所以 SDK 能做的是三档降级：
 *
 *   ① 宿主显式给 getUser            → 100% 准确，宿主写一个读内存的函数
 *   ② 自动探测常见登录态位置        → 猜得中就不用写代码（多数情况）
 *   ③ 匿名设备 ID（localStorage）    → 零配置也有 UV / 影响用户数（设备级口径）
 *
 * 三者都不会让上报失败：任何一步抛错都静默降级到下一档（TC-07）。
 * ────────────────────────────────────────────────────────────────────── */

/** 与后端 error_events.user_id 的列宽一致（VARCHAR(100)）；超了会 P2000，整条事件丢失 */
const USER_ID_MAX = 100;

/** 匿名 ID 的存储键前缀。带上项目公钥后缀，同域名挂多个项目时不会互相串号 */
const ANON_STORAGE_PREFIX = 'argus_anon_id';

/**
 * 内置的身份探测源，按顺序尝试。
 *
 * 存在意义：多数项目登录后必然把 token / 用户对象存在某个固定位置，
 * 探测命中就等于宿主零改动拿到账号级精度。想完全关掉就传 `userSources: []`。
 */
const DEFAULT_USER_SOURCES: readonly string[] = [
  // 最优先：明确约定（SSR 模板注入、或宿主显式赋值），不会和别人的 key 撞车
  'window.__ARGUS_USER__',
  // 常见登录态存储位置
  'localStorage:argus_user',
  'localStorage:user',
  'localStorage:userInfo',
  // 常见 JWT 存储位置（从 payload 里取 sub / userId）
  'jwt:token',
  'jwt:access_token',
];

/** 从 localStorage 里的用户 JSON 取 ID，兼容 { id } / { userId } / { uid } */
function idFromStoredUser(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const id = obj.id ?? obj.userId ?? obj.user_id ?? obj.uid;
    if (id === undefined || id === null || typeof id === 'object') return null;
    return String(id);
  } catch {
    return null;
  }
}

/**
 * 解 JWT payload 取用户标识。
 *
 * 只解码、**不验签名** —— 这里不是鉴权，只是"读一个 ID 用来统计"。
 * 也正因为不验签，user_id 是不可信数据，后端绝不能拿它做权限判断。
 */
function idFromJwt(token: string | null): string | null {
  if (token === null || token === '') return null;
  try {
    const part = token.split('.')[1];
    if (part === undefined || part === '') return null;
    // JWT 用 base64url（- _），atob 只认 base64（+ /），两个字符要换回来
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as Record<string, unknown>;
    const id = payload.sub ?? payload.userId ?? payload.user_id ?? payload.uid;
    if (id === undefined || id === null || typeof id === 'object') return null;
    return String(id);
  } catch {
    return null;
  }
}

/** 依次尝试各个探测源；第一个命中的胜出。单个源失败不影响继续尝试 */
function detectUserId(sources: readonly string[]): string | null {
  if (typeof window === 'undefined') return null;

  for (const source of sources) {
    let id: string | null = null;
    try {
      if (source.startsWith('window.')) {
        const holder = (window as unknown as Record<string, unknown>)[source.slice(7)];
        if (holder !== null && typeof holder === 'object') {
          const record = holder as Record<string, unknown>;
          const raw = record.id ?? record.userId;
          id = raw === undefined || raw === null || typeof raw === 'object' ? null : String(raw);
        } else if (typeof holder === 'string' || typeof holder === 'number') {
          // 容忍宿主直接赋一个裸 ID：window.__ARGUS_USER__ = 1024
          id = String(holder);
        }
      } else if (source.startsWith('localStorage:')) {
        id = idFromStoredUser(localStorage.getItem(source.slice('localStorage:'.length)));
      } else if (source.startsWith('jwt:')) {
        id = idFromJwt(localStorage.getItem(source.slice('jwt:'.length)));
      }
    } catch {
      // 存储被禁（隐私模式）、JSON 坏了 —— 都只是"这个源不可用"
      id = null;
    }
    if (id !== null && id.trim() !== '') return id.trim().slice(0, USER_ID_MAX);
  }
  return null;
}

/** 匿名设备 ID：读不到 / 写不进都不能炸，所以整段包 try */
function readAnonymousId(): string | null {
  try {
    if (options.anonymousId === false) return null;
    const storageKey = `${ANON_STORAGE_PREFIX}:${options.key ?? 'default'}`;
    const existing = localStorage.getItem(storageKey);
    if (existing !== null && existing !== '') return existing;
    const created = `anon_${genId()}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return null;
  }
}

/**
 * 解析当前用户，返回 `{ id }` 或 null（null = 连匿名 ID 都拿不到）。
 *
 * 在**事件产生时**调用（不是发送时）：离线重试/延迟上报时，身份应该是
 * "出错那一刻的身份"，而不是"重发那一刻的身份"。
 */
function resolveUser(): { id: string } | null {
  // ① 宿主显式 getter（也容忍它直接返回裸 ID，省得宿主踩契约的坑）
  try {
    const returned = options.getUser?.();
    const raw =
      returned !== null && typeof returned === 'object'
        ? (returned as { id?: unknown }).id
        : returned;
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      return { id: String(raw).trim().slice(0, USER_ID_MAX) };
    }
  } catch {
    // 宿主的函数崩了 → 继续往下降级，绝不让采集链路中断
  }

  // ② 自动探测（宿主零代码）
  const detected = detectUserId(options.userSources ?? DEFAULT_USER_SOURCES);
  if (detected !== null) return { id: detected };

  // ③ 匿名设备 ID
  const anonymous = readAnonymousId();
  return anonymous === null ? null : { id: anonymous };
}

/* ── 会话（M5 / FR-1.23）──────────────────────────────────────────────────
 *
 * 会话 = 用户连续使用网站的一段时间。判定靠**懒判定**：只在"需要 session_id"
 * 或"用户有新活动"时，回头看 lastActivity 有多久没更新。
 * 没有任何定时器 —— 定时器在后台标签页里仍会跑（只是被节流），
 * 会让会话永不超时：用户挂着标签页去睡觉，第二天回来 idle = 0。
 *
 * 三条规则（顺序即优先级）：
 *   ① 距上次活动 > 30 分钟            → 新会话
 *   ② 跨过本地时区的午夜              → 新会话
 *   ③ 系统时间被回拨（now < 上次活动）→ 新会话（否则永远不超时）
 * 都不满足 → 沿用，并刷新 lastActivity。
 *
 * ⚠ 「判定」和「刷新」必须写在同一个函数（currentSession）里。
 * lastActivity 的语义是"上一次活动时刻"，而写它的时机正是"现在发生了一次活动"，
 * 所以写之前必须先回答"这是上一次的延续，还是新一次的开始"。
 * 拆成两个函数（一个只写、一个只判）就会造出
 * "离开 40 分钟后回来仍被续进旧会话"的漏洞 —— 会话数偏少、错误率偏高。
 * ────────────────────────────────────────────────────────────────────── */

/** 会话空闲阈值：30 分钟。与 GA 的默认口径一致，也贴合用户"又来了"的直觉 */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * localStorage 的键名。**不加项目后缀**，因为会话描述的是"这个浏览器这一段时间的
 * 使用"，它不属于某个项目。同域名下挂两个 Argus 项目时共用一个 id 无害 ——
 * sessions 表按 (project, id) 区分，不会互相覆盖。
 * （匿名用户 ID 则相反：它按项目分开存，避免把人算混。）
 */
const SESSION_KEY = 'argus_session';

/** 活动触发的节流窗口。判定阈值是 30 分钟，30 秒的精度绰绰有余 */
const SESSION_TOUCH_THROTTLE_MS = 30_000;

interface SessionRecord {
  /** 会话标识（UUID） */
  id: string;
  /** 会话开始时刻（客户端时钟，毫秒） */
  startedAt: number;
  /** 最后一次活动时刻 —— 超时判定全靠它 */
  lastActivity: number;
  /** 本地时区的 YYYY-MM-DD，用来判"跨天切会话" */
  day: string;
}

/** 读写 localStorage 一律吞异常：隐私模式下它会直接抛，采集不能因此崩（TC-07） */
function sessionStorageGet(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function sessionStorageSet(value: string): void {
  try {
    localStorage.setItem(SESSION_KEY, value);
  } catch {
    // 写不进去 = 退化成"每条事件一个新会话"。能接受，但绝不能让上报失败
  }
}

function readSession(): SessionRecord | null {
  const raw = sessionStorageGet();
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRecord>;
    // 形状校验：被别的脚本写坏、或旧版本字段不兼容时，一律当"没有"
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.lastActivity !== 'number' ||
      typeof parsed.day !== 'string'
    ) {
      return null;
    }
    return parsed as SessionRecord;
  } catch {
    return null;
  }
}

/** 本地时区日期串。用本地而不是 UTC：用户直觉里的"跨天"是过了他这边的午夜 */
function localDay(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function startSession(now: number): SessionRecord {
  const record: SessionRecord = {
    id: genId(),
    startedAt: now,
    lastActivity: now,
    day: localDay(now),
  };
  sessionStorageSet(JSON.stringify(record));
  return record;
}

/**
 * 解析当前会话：必要时新建，否则沿用并刷新活动时间。
 *
 * 在**事件产生时**调用（与 resolveUser 同一时机）：离线补报时，
 * 事件应该归到"它发生时的那个会话"，而不是"重发时的会话"。
 */
function currentSession(): SessionRecord {
  const now = Date.now();
  const saved = readSession();

  if (saved === null) return startSession(now);
  // 时钟回拨：不处理的话 lastActivity 永远在未来，会话再也不会超时
  if (now < saved.lastActivity) return startSession(now);
  if (now - saved.lastActivity > SESSION_IDLE_MS) return startSession(now);
  if (saved.day !== localDay(now)) return startSession(now);

  const touched: SessionRecord = { ...saved, lastActivity: now };
  sessionStorageSet(JSON.stringify(touched));
  return touched;
}

/**
 * 只处理"用户在场"的活动。
 *
 * hidden 时一律不记：那一刻用户不在页面上，记下来会让会话永不超时。
 */
function touchSession(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'visible') return;
  currentSession();
}

/**
 * 活动节流器。
 *
 * 为什么不引 lodash：只需要这几行，而 SDK 有 15 KB 的体积硬约束（SRS §9.1）。
 * 为什么第一次要立刻执行：用户点第一下就该算"在场"；若要等 30 秒后才记第一次，
 * 那 30 秒里用户在系统眼里就"没活动"了。
 */
function throttle(fn: () => void, waitMs: number): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < waitMs) return;
    last = now;
    fn();
  };
}

/**
 * 挂载活动信号。
 *
 * 四个来源：真实上报（调用方负责，见 report / reportPerformance）、
 * click / keydown / scroll（这里）、visibilitychange → visible（这里）。
 *
 * 三个事件共用**同一个节流器**：各自造一个的话，用户点一下又滚一下会写两次。
 */
function installSessionTracking(): void {
  const onActivity = throttle(touchSession, SESSION_TOUCH_THROTTLE_MS);

  // passive: true 必须给 —— scroll 监听不加它，浏览器要等回调跑完才能滚动，
  // 长列表页面会明显掉帧
  window.addEventListener('click', onActivity, { passive: true });
  window.addEventListener('keydown', onActivity, { passive: true });
  window.addEventListener('scroll', onActivity, { passive: true });

  // 切回来 = 活动；切走（hidden）什么都不做。
  // 注意：hidden 在性能采集那边另有用途（退场时把数据发出去），
  // 方向与本函数相反，别混在一起。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touchSession();
  });
}

/** unhandledrejection 的 reason 可能是字符串、对象、甚至 undefined，统一转成 Error */
function toError(reason: unknown): Error {
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
function tagOf(el: unknown): string | null {
  try {
    const tag = (el as { tagName?: unknown } | null)?.tagName;
    return typeof tag === 'string' ? tag : null;
  } catch {
    return null;
  }
}

/** 把元素描述成一行人话；不取文本内容，免得把用户数据带出去 */
function describeElement(el: HTMLElement): string {
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
function redact(url: string): string {
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
function perfUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return href.split('#')[0];
  }
}

/** 是不是 SDK 自己的上报请求 —— 自己的请求不该出现在宿主的面包屑里 */
function isOwnRequest(path: string): boolean {
  return path === ENDPOINT_PATH || path === PERF_ENDPOINT_PATH;
}

/** 挂一个采集器，失败只记日志：一个类目挂了不该拖垮其它类目（TC-07） */
function safeInstall(label: string, install: () => void): void {
  try {
    install();
  } catch (err) {
    console.warn(`[argus] ${label}挂载失败`, err);
  }
}

/* ==========================================================================
 * ④ 面包屑 —— 存储 + 四个采集器（FR-1.10 的四类）
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
function snapshot(): Breadcrumb[] {
  return breadcrumbs.slice();
}

/** ① 点击：挂在 document 的捕获阶段，宿主 stopPropagation 拦不住 */
function installClickBreadcrumbs(): void {
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
function installNavigationBreadcrumbs(): void {
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
function installHttpBreadcrumbs(): void {
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
function installConsoleBreadcrumbs(): void {
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

/* ==========================================================================
 * ⑤ 错误采集 —— 事件组装 + 两条 window 级通道
 * ========================================================================
 * 三条采集通道共用 common() 拼公共字段，各自补上自己的差异部分：
 *   onerror            有 Error 对象，有 filename / lineno / colno
 *   unhandledrejection 有 reason，但可能不是 Error
 *   resource           没有 Error 对象，唯一线索是出错的那个元素
 * ========================================================================*/

/** 三条通道共用的字段，集中写一处，免得每个构造函数各写一遍 */
function common(mechanism: Mechanism): Pick<
  CapturedError,
  | 'event_id'
  | 'session_id'
  | 'mechanism'
  | 'timestamp'
  | 'url'
  | 'user_agent'
  | 'sdk'
  | 'release'
  | 'environment'
  | 'user'
  | 'breadcrumbs'
> {
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

function buildResource(el: HTMLElement & { src?: string; href?: string }): CapturedError {
  const tag = el.tagName.toLowerCase();
  const assetUrl = el.src || el.href || '';
  return {
    ...common('resource'),
    type: tag,
    message: `资源加载失败 <${tag}>${assetUrl ? ` ${assetUrl}` : ''}`,
    stack: '',
    source: assetUrl,
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
function installErrorChannels(): void {
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      try {
        const target = event.target;
        if (target && target !== (window as unknown as EventTarget)) {
          const el = target as HTMLElement & { src?: string; href?: string };
          if (IGNORED_SCHEME.test(el.src || el.href || '')) return; // 浏览器扩展的资源，丢弃
          report(buildResource(el));
          return;
        }

        const err = event.error ?? new Error(event.message);
        if (IGNORED_SCHEME.test(err.stack ?? '')) return; // 扩展抛的错，丢弃
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
      if (IGNORED_SCHEME.test(err.stack ?? '')) return;
      report(build('unhandledrejection', err));
    } catch (err) {
      console.warn('[argus] 采集失败', err);
    }
  });
}

/* ==========================================================================
 * ⑥ 性能采集 —— LCP / CLS / INP 三个 Core Web Vitals（FR-1.11）
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
 * LCP 的值要按 renderTime → loadTime → startTime 依次取。
 *
 * 跨域图片（没有 Timing-Allow-Origin 响应头）读不到 renderTime，
 * 这时它是 0；直接用会把 LCP 记成 0，比不报还糟。
 */
function pickLcpTime(entry: PerformanceEntry): number {
  const e = entry as PerformanceEntry & { renderTime?: number; loadTime?: number };
  return e.renderTime || e.loadTime || entry.startTime;
}

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
    lcpValue = pickLcpTime(last);
    const lcpEntry = last as PerformanceEntry & { element?: unknown; navigationType?: string };
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
function setupPerformance(): void {
  try {
    // 没有 PerformanceObserver 的浏览器直接放弃，不报错
    if (typeof PerformanceObserver === 'undefined') return;
    // SSR / 非浏览器环境没有 document
    if (typeof document === 'undefined' || typeof location === 'undefined') return;

    installPerfObservers();
    installPerfExit();
  } catch {
    // 静默
  }
}

/* ==========================================================================
 * ⑦ 上报出口 + 入口
 * ========================================================================
 * 出口只有一条传输逻辑，上面两个薄壳（错误 / 性能）。
 * 两个出口必须分开的原因：/api/v1/error 的 DTO 只认错误事件的字段，而且后端
 * ValidationPipe 开了 whitelist —— 性能字段发过去会被**静默剥掉**（不报错，数据凭空消失）。
 * ========================================================================*/

/**
 * 统一出口。错误事件与性能事件共用一套发送逻辑：
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

function report(payload: CapturedError): void {
  // 一条事件本身就是"用户还在"的证据 —— 顺手续一下会话寿命。
  // 放在这里而不是 common() 里：common() 已经在构造时有过一次 currentSession()，
  // 而 touchSession 带可见性判断，语义不同（这里是"确实要发出去了"）。
  touchSession();
  console.log(`[argus] 即将上报 ${payload.mechanism} → ${payload.message.slice(0, 60)}`);
  transport(ENDPOINT, payload, '错误事件');
}

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

/**
 * 挂载全局采集。这是 SDK 的唯一入口。
 *
 * 所有采集器都通过 safeInstall 挂载：任何一个失败都只记日志，
 * 不影响其它采集器，也绝不影响宿主页面（TC-07）。
 */
export function initArgus(opts: ArgusOptions = {}): void {
  if (typeof window === 'undefined') return;

  // 配置必须赶在挂采集器之前就位：installErrorChannels 之后随时可能触发上报，
  // 那时再赋 options 就晚了（首屏错误往往发生在 init 返回后的同一个宏任务里）
  //
  // 空串 / 全空格一律当"没配"：空版本号和"没带版本"混在一起会污染按版本的聚合，
  // 所以宁可发 undefined（stringify 会丢掉整个 key，后端落 NULL）也不发 ""
  const key = opts.key?.trim();
  options = {
    key: key || undefined,
    release: opts.release?.trim() || undefined,
    environment: opts.environment?.trim() || undefined,
    // 函数不能 trim，只能做类型检查：传了非函数一律当没配，免得每次上报都抛错
    getUser: typeof opts.getUser === 'function' ? opts.getUser : undefined,
    userSources: Array.isArray(opts.userSources) ? opts.userSources : undefined,
    anonymousId: opts.anonymousId,
  };

  // 起始位置的日志：这条是排查"为什么看板没数据"的第一条线索，
  // 所以 key 缺失必须足够刺眼（而不是等用户去 Network 面板里找 401）
  if (options.key === undefined) {
    console.warn(
      '[argus] 未配置项目公钥：所有上报都会被服务端拒绝（401）。' +
        '请在 initArgus({ key: "argus_pub_..." }) 里补上',
    );
  } else if (!options.key.startsWith(PUBLIC_KEY_PREFIX)) {
    // 形状不对时提前说，但**不阻断**：前缀是约定，不是协议，
    // 服务端才是唯一裁判（万一以后换前缀，旧 SDK 也不该因此停摆）
    console.warn(`[argus] 项目公钥看起来不是 ${PUBLIC_KEY_PREFIX}... 开头的串，请确认没有填成私钥`);
  }

  console.log(
    `[argus] SDK 已挂载，上报地址 ${ENDPOINT}` +
      (options.release ? `，版本 ${options.release}` : '（未配置版本，Sourcemap 不会生效）'),
  );

  // 用户维度的实际来源要说清楚：否则"users_seen 为什么一直是匿名 ID"
  // 会变成一条要翻源码才能回答的问题
  console.log(
    `[argus] 用户维度：` +
      (options.getUser !== undefined
        ? '宿主 getter'
        : `${(options.userSources ?? DEFAULT_USER_SOURCES).length} 个自动探测源`) +
      (options.anonymousId === false ? '（匿名兜底已关闭）' : ' + 匿名兜底'),
  );

  // —— 会话跟踪：必须最先挂 ——
  // 它决定"用户还在不在"，后面所有采集都依赖 currentSession() 的副产物。
  // 挂晚了不会报错，只会让首屏那段时间的活动不被记录（首屏恰恰是最活跃的时段）。
  safeInstall('会话跟踪', installSessionTracking);

  // —— 面包屑四类钩子：各自独立挂载，一个失败不影响其它 ——
  safeInstall('点击面包屑', installClickBreadcrumbs);
  safeInstall('路由面包屑', installNavigationBreadcrumbs);
  safeInstall('请求面包屑', installHttpBreadcrumbs);
  safeInstall('控制台面包屑', installConsoleBreadcrumbs);

  // —— 错误采集：两条 window 级通道 ——
  safeInstall('错误通道', installErrorChannels);

  // —— 性能采集：三个观察器 + 退场上报 ——
  safeInstall('性能采集', setupPerformance);
}
