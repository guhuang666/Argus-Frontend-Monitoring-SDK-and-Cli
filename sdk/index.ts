/**
 * Argus Browser SDK —— 装配层（唯一入口）。
 *
 * 这个文件只做三件事：归一化配置、按依赖顺序把各模块挂上去、把对外接口转出去。
 * 具体采集逻辑在 session / identity / breadcrumbs / errors / perf 里，
 * 这里不出现任何业务代码 —— 想知道"某个指标怎么采"，别从这个文件找。
 *
 * 安装顺序不是风格问题：
 *   · 会话必须最先 —— 后面所有采集器都靠 currentSession() 取 session_id，
 *     挂晚了首屏那段时间（恰恰最活跃）的活动不会被记录；
 *   · 面包屑要在错误之前 —— 错误发生那一刻要能拍到用户轨迹；
 *   · 错误与性能互不依赖，谁先谁后都行。
 *
 * 所有采集器都通过 safeInstall 挂载：任何一个失败都只记日志，
 * 不影响其它采集器，也绝不影响宿主页面（TC-07）。
 */
import { installClickBreadcrumbs, installConsoleBreadcrumbs, installHttpBreadcrumbs, installNavigationBreadcrumbs } from './breadcrumbs'
import { safeInstall } from './common'
import { ERROR_BATCH_ENDPOINT, applyOptions } from './config'
import { FLUSH_INTERVAL_MS, MAX_BATCH, installBatchExit, installErrorChannels } from './errors'
import { DEFAULT_USER_SOURCES } from './identity'
import { setupPerformance } from './perf'
import { installSessionTracking } from './session'
import type { ArgusOptions } from './types'

// 对外接口原样转出：宿主 import 的仍是 'argus-util' 这同一个入口，
// 拆文件不该让任何人改他们自己的代码。
export { ENDPOINT, PERF_ENDPOINT, SERVER_URL } from './config'
export type { ArgusOptions, Breadcrumb, CapturedError, Mechanism, PerfEvent } from './types'

/**
 * 已挂载的采集器。
 *
 * initArgus 非幂等是个真实的坑：React StrictMode、或宿主里两处初始化，
 * 都会把 8 组监听器各挂两遍 —— 同一次点击记两条面包屑、同一条错误报两次。
 * 只记下来就够，不需要"卸载"能力：SDK 的语义就是挂着不动。
 */
const installed = new Set<string>()

function installOnce(label: string, install: () => void): void {
  if (installed.has(label)) return;
  installed.add(label);
  safeInstall(label, install);
}

/**
 * 挂载全局采集。这是 SDK 的唯一入口。
 */
export function initArgus(opts: ArgusOptions = {}): void {
  if (typeof window === 'undefined') return;

  // 配置必须赶在挂采集器之前就位：installErrorChannels 之后随时可能触发上报，
  // 那时再赋 options 就晚了（首屏错误往往发生在 init 返回后的同一个宏任务里）
  const config = applyOptions(opts);

  // SDK 已挂载：错误出口和批参数是排查"为什么没数据"时最先要看的两件事
  console.log(
    `[argus] SDK 已挂载，错误上报地址 ${ERROR_BATCH_ENDPOINT}` +
      `（${MAX_BATCH} 条 / ${FLUSH_INTERVAL_MS / 1000}s 攒批）` +
      (config.release ? `，版本 ${config.release}` : '（未配置版本，Sourcemap 不会生效）'),
  );

  // 用户维度的实际来源要说清楚：否则"users_seen 为什么一直是匿名 ID"
  // 会变成一条要翻源码才能回答的问题
  console.log(
    `[argus] 用户维度：` +
      (config.getUser !== undefined
        ? '宿主 getter'
        : `${(config.userSources ?? DEFAULT_USER_SOURCES).length} 个自动探测源`) +
      (config.anonymousId === false ? '（匿名兜底已关闭）' : ' + 匿名兜底'),
  );

  // —— 会话跟踪：必须最先挂 ——
  installOnce('会话跟踪', installSessionTracking);

  // —— 面包屑四类钩子：各自独立挂载，一个失败不影响其它 ——
  installOnce('点击面包屑', installClickBreadcrumbs);
  installOnce('路由面包屑', installNavigationBreadcrumbs);
  installOnce('请求面包屑', installHttpBreadcrumbs);
  installOnce('控制台面包屑', installConsoleBreadcrumbs);

  // —— 错误采集 + 退场：两条 window 级通道 ——
  installOnce('错误通道', installErrorChannels);

  // 退场必须和错误通道一起挂：只挂通道不挂退场，关页时缓冲区里那几条就白攒了。
  installOnce('批量退场', installBatchExit);

  // —— 性能采集：三个观察器 + 退场上报 ——
  installOnce('性能采集', setupPerformance);
}
