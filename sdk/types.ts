/**
 * 对外数据契约 —— SDK 与后端、宿主之间的唯一共同语言。
 *
 * 这一层没有任何运行时逻辑，只有 interface / type。改这里等于改协议：
 * 字段增删要和后端 DTO、看板查询同时对齐；只加不改才是安全的。
 */

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
