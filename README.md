# Argus-Util

Argus 前端监控平台的采集端。一个 npm 包，两个入口：

| 入口 | 用途 | 形态 |
| --- | --- | --- |
| `import { initArgus } from 'argus-util'` | 浏览器 SDK：错误 / 面包屑 / Web Vitals / 会话与用户 | 零运行时依赖，仅 ESM |
| `npx argus-cli` | Sourcemap 上传 | Node CLI |

---

## 快速开始

### 1. 安装

```powershell
npm i https://github.com/guhuang666/Argus-Frontend-Monitoring-SDK-and-Cli/releases/download/v0.3.0/argus-util-0.3.0.tgz
```

不想走包，也可以把 `sdk/index.ts` 拷进宿主源码直供编译 —— 两者取舍见「两种接入方式」。

### 2. SDK：三行接入

```ts
// 必须在模块作用域调用。放进 useEffect 会因 StrictMode 执行两次而重复挂监听器。
import { initArgus } from 'argus-util'

initArgus({
  key: 'argus_pub_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  release: 'web@1.2.4',
  environment: 'production',
})
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 无 | 项目公钥。不配则每条事件在本地告警后**丢弃**（不发请求）；填错则服务端 401 |
| `release` | string | 无 | ≤100 字符。**必须与 CLI 的 `--release` 逐字节一致**，否则堆栈永远"未符号化" |
| `environment` | string | 无 | ≤50 字符，写入 `error_events.environment`，看板按环境筛选的依据 |
| `getUser` | `() => {id} \| string \| number \| null` | 无 | 每次上报调用一次，须同步、轻量、不抛错 |
| `userSources` | string[] | 6 个内置源 | 语法 `window.K` / `localStorage:K` / `jwt:K`；传 `[]` 关闭自动探测 |
| `anonymousId` | boolean | `true` | 拿不到身份时退化为匿名设备 ID（localStorage，键名带项目后缀） |

**自动采集**（宿主零代码）：

- 错误三通道：`onerror`（捕获阶段）、`unhandledrejection`、资源加载失败
- 面包屑四类：点击 / 路由 / 请求 / 控制台，环形缓冲 **50** 条
- Web Vitals：LCP / CLS / INP，含元素与 `inp_phase` 归因
- 会话：30 分钟无活动切新会话（`localStorage: argus_session`）
- 用户：`getUser` → 6 个内置探测源 → 匿名设备 ID

**上报契约**：

| 通道 | 地址 | 鉴权 | 时机 |
| --- | --- | --- | --- |
| 错误 | `POST http://47.119.32.85/api/v1/error/batch`（body `{ events: [...] }`） | 头 `X-Argus-Key` | 攒批：满 **50** 条 / 每 **5 s** / 退场；常规批次 `keepalive: false`，**退场批次 `keepalive: true`** |
| 性能 | `POST http://47.119.32.85/api/v1/performance` | 头 `X-Argus-Key` | 页面**首次** `hidden` / `pagehide`，只发一次；`keepalive: true` |

⚠️ 服务端地址只在 `SERVER_URL` 一行（`sdk/config.ts:28`），三个端点都由它派生（`sdk/config.ts:36,39,52`）。换后端 = 改这一行 + 重新构建；CLI 的 `DEFAULT_ENDPOINT`（`cli/index.ts`）要一起改，两处没有单一真源。

### 3. CLI：上传 Sourcemap

```powershell
# ① 看清单（不联网、不需要私钥）
npx argus-cli --release web@1.2.4 --dir ./dist --dry-run

# ② 真传
npx argus-cli --release web@1.2.4 --dir ./dist
```

私钥从**当前工作目录**的 `.env` 读（只认 cwd，不读 shell 环境变量）：

```ini
ARGUS_SECRET=argus_sec_xxxxxxxx
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--release` | ✅ | — | ≤100 字符 |
| `--dir` | ✅ | — | 构建产物目录，必须存在 |
| `--dry-run` | | false | 只打印清单；不需要私钥；有非法路径时退出码 1 |
| `--url-prefix` | | `/` | 产物部署前缀，对应 Vite 的 `base` |
| `--endpoint` | | `http://47.119.32.85` | 服务端地址；本机开发时传 `http://localhost:3000` |
| `--secret` | | 读 `.env` | 临时覆盖私钥（CI 注入用） |
| `--concurrency` | | `4` | 1~16 的整数 |
| `--help` | | — | 打印用法 |

**三条对齐规则**，错一条就会出现"传了 map 却永远未符号化"：

1. `--release` = SDK 的 `release`；
2. `--url-prefix` = 产物部署前缀；
3. 公私钥属于**同一个项目**（私钥决定传到哪个项目，URL 里不带 projectId）。

其他行为：

- `artifact_path` = `--dir` 内的相对路径，**去掉 `.map` 后缀**、以 `/` 开头（存的是产物路径，因为浏览器堆栈里出现的是 `.js`）；
- 重传幂等：同一 `(release_id, artifact_path)` 覆盖，输出 `↻`；首次为 `✓`；
- 单个 `.map` 上限 50 MB（服务端校验）；
- 退出码：`0` 全成功 / `1` 参数错误或有文件失败。

---

## 已知限制（v0.2.0）

| 限制 | 后果 | 出处 |
| --- | --- | --- |
| 错误已批量（满 50 条 / 每 5 s / 退场），但**批次失败不重试、不落盘补发** | 网络抖动或离线期间的整批事件直接丢；`.catch` 里只有一行 `console.warn` | `sdk/errors.ts:160-165,190-197` |
| 退场通道只有 `fetch + keepalive`：无 `sendBeacon` 降级，也不切块、不做字节记账 | 错误风暴中正好关页时，批次超 64 KB 会被浏览器**整批**拒绝，`.catch` 里只有一行 `console.warn` | `sdk/errors.ts:167-174,184-196` |
| 性能不进批量，仍单条直发 | 每次页面加载一个请求；攒批省不下来（它也天然只有一条） | `sdk/perf.ts:353-364` |
| 无采样 | `sampleRate` 参数不存在 | — |
| 上报地址无运行时配置 | 换环境必须改 `SERVER_URL` 并重新构建（CLI 另有一处 `DEFAULT_ENDPOINT`） | `sdk/config.ts:28` |
| 字段不截断 | 超限整条被后端 400 丢弃 | 见下 |
| 每次上报都 `console.log` 成功/失败 | 生产环境控制台噪音 | `sdk/perf.ts:321-325,sdk/errors.ts:190-197` |
| 性能只在首次 `hidden` 上报一次；INP 取最差不取 P98 | 切走再回来的指标不补报 | `sdk/perf.ts:60,239-242` |
| 性能事件不带 `release` / `environment` | 性能趋势无法按版本切分（后端 DTO 尚未接收这两个字段） | `sdk/types.ts:126-174` |
| LCP 直接取 `renderTime`，不做降级 | 跨域图片未配 `Timing-Allow-Origin` 时会报 **0 ms**（看板上像"完美"） | `sdk/perf.ts:146-147` |
| 会话只按「30 分钟无活动」判定 | 挂机过夜、系统时间被回拨都不切新会话，会话数可能偏少 | `sdk/session.ts:10,25-38` |
| 只有 ESM 产物 | `<script>` 直引需自行打包（未提供 IIFE） | `package.json:12-18` |

后端入参上限（超了整条 400）：`message ≤ 2000`、`stack ≤ 64 KB`、`url ≤ 2048`、`user_agent ≤ 512`、`release ≤ 100`、`environment ≤ 50`、`user.id ≤ 100`。

---

## 两种接入方式

| | **npm 包（推荐）** | 源码直供 |
| --- | --- | --- |
| 用法 | `npm i <tgz 地址>`，`npx argus-cli` 可用 | 把整个 `sdk/` 目录拷进宿主 |
| 依赖 | 无 | 宿主需 TS 并能转译 `.ts` |
| 类型 | 随包 `.d.ts` | 用宿主自己的 tsconfig |
| 升级 | 换 URL 重装 | 手动覆盖文件 |

拷源码时记得把 `sdk/` 加进宿主 `tsconfig.json` 的 `include`，否则 `tsc` 会报"不在 rootDir 内"；此时 CLI 只能用 `node cli/index.ts`（Node ≥23.6）或先 `npm run build` 再跑 `dist/cli/index.js`。`sdk/` 内部是 9 个文件、互相之间用无扩展名的相对 import（`./config`），Vite / Webpack / Rollup / 宿主自己的 `tsc` 都能直接解析。

---

## 目录与构建

```
Argus-Util/
├── sdk/             浏览器 SDK（零运行时依赖，仅 ESM）
│   ├── index.ts     装配层：唯一入口 initArgus()，只做配置 + 挂载 + 转出
│   ├── types.ts     对外契约：CapturedError / PerfEvent / Breadcrumb / ArgusOptions
│   ├── common.ts    无状态工具：genId / tagOf / redact / throttle / safeInstall…
│   ├── config.ts    SERVER_URL、三个端点、SDK_VERSION、运行期 options 与归一化
│   ├── session.ts   会话（session_id 的唯一来源）
│   ├── identity.ts  用户识别（getter → 探测源 → 匿名 ID）
│   ├── breadcrumbs.ts  轨迹缓冲 + 点击 / 路由 / 请求 / 控制台 四个采集器
│   ├── errors.ts    错误三通道 + 批量缓冲 + 退场（错误域独占的出口）
│   └── perf.ts      LCP / CLS / INP + 退场打包 + 单发出口（性能域独占）
├── cli/             CLI：index / discover / paths / upload
├── dist/            npm run build 产物（sdk: ESM + d.ts；cli: ESM）
├── package.json     build / typecheck / pack
└── .env.example     凭据模板
```

模块之间是单向依赖、无环：`types ← common ← config ← session / identity ← breadcrumbs ← errors`，`perf` 只依赖前四层，`index` 在最上层做装配。想看「某个指标怎么采」找对应的域文件，`index.ts` 里只有安装顺序。

```powershell
npm i                # 只装构建期依赖（tsup / typescript）
npm run build        # → dist/sdk 与 dist/cli
npm run typecheck    # 只类型检查，不产出
npm pack             # 打成 argus-util-<version>.tgz（只含 dist + README + package.json）
```

---

## 安全红线

| 禁止 | 后果 |
| --- | --- |
| 给 `ARGUS_SECRET` 加 `VITE_` 前缀 | 私钥被内联进浏览器 bundle，任何人可见 |
| 提交 `.env` | 私钥进 git 历史，只能重建钥匙 |
| 用公钥上传 map / 用私钥上报 | 401（两类凭据能力完全不同） |
| 在 CI 日志或命令行回显完整 `--secret` | 私钥进日志；参数还会进 shell history 与进程列表 |

---

## 环境要求

- 跑 `dist/` 产物与 CLI：**Node ≥ 18**
- 直接跑 `cli/index.ts` 源码：**Node ≥ 23.6**（内置类型擦除，不需要 ts-node）
- SDK 运行环境：Chrome / Edge / Firefox / Safari 近两个大版本；`crypto.randomUUID` 不可用时自动降级
- 宿主构建工具：任何支持 ESM 的（Vite / Webpack / Rollup / esbuild），SDK 本身零依赖

---

## 发布新版本

```powershell
# 1. 版本号有两处，没有单一真源，必须手动对齐
#    package.json 的 "version"
#    sdk/config.ts 的 SDK_VERSION（会作为 event.sdk.version 上报）
npm run build
npm pack

# 2. 建 Release 并上传 tgz；tag 不要复用
gh release create v0.2.1 argus-util-0.2.1.tgz -t "argus-util v0.2.1" -n "变更说明"
```

宿主把安装 URL 里的版本号换成新 tag 即可升级。
