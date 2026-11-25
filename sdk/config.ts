/**
 * 配置 —— 唯一知道"数据发到哪"的模块。
 *
 * 两条职责：
 *   ① 常量：服务端地址、三个端点、SDK 版本号、公钥前缀；
 *   ② 运行期配置：宿主传给 initArgus 的那几个字段，归一化后存在 options 里。
 *
 * 这里**不碰任何采集逻辑**，也绝不发起请求。换服务器的全部改动都集中在
 * SERVER_URL 这一行 —— 这是本模块存在的意义。
 */
import { redact } from './common'
import type { ArgusOptions } from './types'

/**
 * 服务端地址。
 *
 * ── 为什么是一个可以写死的常量，而不是 initArgus({ serverUrl }) ────────────
 * 本 SDK 的定位是「一个演示用的自建监控」，服务端只有一台机器、一个地址。
 * 让宿主每次 init 都传一遍 serverUrl，等于把「部署地址」这个后端概念
 * 泄漏到每个接入方的业务代码里 —— 换机器时所有宿主都要改代码并发版。
 *
 * 代价是：换机器 / 上域名时必须改这里并重新构建 SDK。这是主动接受的取舍，
 * 因为换服务器的频率远低于「接入方的数量」。
 *
 * ⚠️ 唯一需要改的地方就是这一行。下面所有上报地址都由它派生。
 *    换机器时 CLI 的 DEFAULT_ENDPOINT（cli/index.ts）要一起改，两处没有单一真源。
 */
export const SERVER_URL = 'http://ghargus.cn:8080';

/**
 * 上报地址。
 *
 * 项目不再由 URL 里的路径区分（M4 之前是 /api/v1/error 一条通路），
 * 而是由请求头 X-Argus-Key 里的公钥反查 —— 所以这些常量对所有项目都是同一个。
 */
export const ENDPOINT = `${SERVER_URL}/api/v1/error`;

/** 性能指标上报地址 */
export const PERF_ENDPOINT = `${SERVER_URL}/api/v1/performance`;

/**
 * 错误事件的**批量**上报地址。
 *
 * 为什么单开一条：跨域 + 自定义头意味着每个请求前面还要打一次 OPTIONS 预检，
 * 所以「1 条错误 = 2 次往返」。攒批之后是「N 条错误 = N/50 个请求」。
 *
 * 旧的单条 ENDPOINT 保留不删（宿主可能有 import，面包屑判定也还在用它的路径），
 * 但错误事件已经全部走这条批量通道。
 *
 * 不导出：和 ENDPOINT 一样是硬编码常量，导出只会让人以为可以换。
 */
export const ERROR_BATCH_ENDPOINT = `${SERVER_URL}/api/v1/error/batch`;

export const SDK_NAME = 'argus.browser';
export const SDK_VERSION = '0.2.0';

/**
 * SDK 自己的上报地址（脱敏后），用来把自己的请求排除在面包屑之外。
 *
 * 这三个常量在模块加载时就算好了。它们依赖的 redact() 来自 common 模块：
 * ES 模块保证被依赖的模块先执行完，所以 import 进来时它已经就位 ——
 * 拆文件之前这里靠的是函数声明提升，现在靠的是模块求值顺序。
 */
export const ENDPOINT_PATH = redact(ENDPOINT);
export const PERF_ENDPOINT_PATH = redact(PERF_ENDPOINT);
export const ERROR_BATCH_PATH = redact(ERROR_BATCH_ENDPOINT);

/**
 * 运行期配置。
 *
 * initArgus() 之前是空对象：页面一加载就抛错、而业务代码还没走到 init 的那段时间里，
 * 事件会不带版本上报。这是主动接受的：宁缺毋错，猜一个版本比不带更难查。
 *
 * 导出成 `let` 是为了让其它模块直接读 `options.key`，但**只有本模块能写** ——
 * 外部赋值请走 applyOptions()，否则归一化和校验都会被绕过去。
 */
export let options: ArgusOptions = {};

/** 是不是 SDK 自己的上报请求 —— 自己的请求不该出现在宿主的面包屑里 */
export function isOwnRequest(path: string): boolean {
  // 批量端点必须一起认：漏了它，每条批量上报都会给自己记一条 http 面包屑，
  // 于是"出错前的用户轨迹"里全是监控系统自己的请求。
  return path === ENDPOINT_PATH || path === PERF_ENDPOINT_PATH || path === ERROR_BATCH_PATH;
}

/**
 * 装进运行期单例。
 *
 * MVP：只做三件事 —— 空串归一成 undefined、挂到 options、原样返回。
 * 不做类型守卫和形状校验：`ArgusOptions` 已经把类型写清楚了，传错是调用方的 bug，
 * SDK 不替宿主兜底（真传错了，各处已有的 try/catch 会让它降级而不是炸掉宿主）。
 *
 * 三处 `|| undefined` 留着是有用的：空串 release 会被后端存成 ""，
 * 和"没配版本"混在一起会污染按版本聚合，所以必须归一成"没有"。
 */
export function applyOptions(opts: ArgusOptions): ArgusOptions {
  options = {
    key: opts.key?.trim() || undefined,
    release: opts.release?.trim() || undefined,
    environment: opts.environment?.trim() || undefined,
    getUser: opts.getUser,
    userSources: opts.userSources,
    anonymousId: opts.anonymousId,
  };
  return options;
}
