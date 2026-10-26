# Argus-Util

Argus 监控平台的**随包内置工具**：浏览器 SDK + Sourcemap 上传 CLI。

它默认**随宿主项目拷入使用**（把整个文件夹放到项目根），也可以在 `Argus-Util` 里 `npm run build` 出一个标准 npm 包（`dist/` + `bin`，见第七节）。

---

## 一、三步接入

### 1. 拷贝

```
你的项目/
└── Argus-Util/          ← 把整个文件夹放到项目根
```

### 2. 配 `.env`（放到项目根，和 `package.json` 同级）

```ini
# 公钥：会被打进浏览器 bundle（Vite 只内联 VITE_ 前缀的变量）
VITE_ARGUS_KEY=argus_pub_xxxxxxxx

# 私钥：CLI 上传 Sourcemap 用。绝不能加 VITE_ 前缀
ARGUS_SECRET=argus_sec_xxxxxxxx
```

> **为什么两把钥匙能放在同一个文件里？**
> Vite 只把 `VITE_` 前缀的变量注入 `import.meta.env` 并内联进 bundle。
> `ARGUS_SECRET` 没有前缀，所以它只在本机/CI 里可见，永远不会进前端产物。
> 这不是"小心别写错"，而是 Vite 的机制。

别忘了在 `.gitignore` 里加一行 `.env`。

### 3. 装 SDK（`src/main.tsx`）

```ts
import { initArgus } from '../Argus-Util/sdk/index.ts'

initArgus({
  // Vite 构建时把 VITE_ARGUS_KEY 替换成字面量；它出现在浏览器里是正常的
  key: import.meta.env.VITE_ARGUS_KEY,
  release: import.meta.env.VITE_ARGUS_RELEASE ?? 'dev',
  environment: import.meta.env.VITE_ARGUS_ENV ?? 'local',
})
```

**必须在模块作用域调用**，不要放进 `React.useEffect` —— StrictMode 会让 effect 执行两次，于是每个错误上报两遍。

还要把 SDK 加进 `tsconfig.json` 的 `include`，否则 `tsc -b` 会报"不在 rootDir 内"：

```jsonc
"include": ["src", "Argus-Util/sdk/index.ts"]
```

---

## 二、上传 Sourcemap

```powershell
# 方式 A：直接跑源码（Node ≥ 23.6，不需要构建）
# 只打印清单，不发请求（不需要私钥）
node Argus-Util/cli/index.ts --release demo@1.0.0 --dir ./dist --dry-run

# 真传（私钥从当前目录的 .env 读）
node Argus-Util/cli/index.ts --release demo@1.0.0 --dir ./dist
```

```powershell
# 方式 B：构建后跑产物（Node ≥ 18）
cd Argus-Util; npm i; npm run build; cd ..

node Argus-Util/dist/cli/index.js --release demo@1.0.0 --dir ./dist --dry-run
node Argus-Util/dist/cli/index.js --release demo@1.0.0 --dir ./dist
```

> 装成 npm 包之后，命令名是 `argus-cli`（`bin` 指向 `dist/cli/index.js`），
> 即 `npx argus-cli --release ...`。两种方式的行为完全一致，区别只是跑源码还是跑编译产物。

上传地址里**没有项目 id**：私钥本身就是项目级凭据，服务端 `sha256()` 反查就知道传到哪个项目。所以你不可能"传错项目"—— 除非私钥本身拿错了。

### ⚠️ `--release` 必须和 SDK 里的 `release` 逐字节一致

两个字符串不一致时：

- 上传会**成功**（201）
- 看板**不会报任何错**
- 但堆栈永远显示"未符号化"

因为 Worker 是拿「事件里的 project_id + release」去查 map 的。

推荐做法：**版本号只算一次，同时注入构建和上传**（`测试代码/demo-app/scripts/release.mjs` 是参考实现）。

---

## 三、目录结构

```
Argus-Util/
├── sdk/index.ts        浏览器 SDK（源码直供宿主 import，不编译）
├── cli/                CLI 源码
│   ├── index.ts        命令行入口
│   ├── discover.ts     找 .map 文件
│   ├── paths.ts        本地路径 → 站点 pathname
│   ├── upload.ts       multipart 上传 + 并发 + 重试
│   └── tsconfig.json   只做类型检查（cli 下不再有自己的 package.json）
├── dist/               构建产物（npm run build 生成，不进版本库）
│   ├── sdk/index.js    ESM 入口（package.json 的 main/exports）
│   ├── sdk/index.d.ts  类型声明（package.json 的 types）
│   └── cli/index.js    CLI 产物（package.json 的 bin）
├── .env.example        凭据模板（不含真实值，可提交）
├── .gitignore
└── package.json        build / typecheck / upload 脚本
```

---

## 四、红线

| 禁止 | 后果 |
|---|---|
| 给 `ARGUS_SECRET` 加 `VITE_` 前缀 | 私钥被打进浏览器 bundle，任何人可见 |
| 在前端代码里写 `process.env.ARGUS_SECRET` | 同上，可能被构建工具内联 |
| 提交 `.env` | 私钥进了 Git 历史，只能吊销重发 |
| 用公钥替换私钥去上传 | 401（两类凭据能力完全不同） |

---

## 五、环境要求

- Node **≥ 18**（跑 `dist/` 产物）；如果直接跑源码 `cli/index.ts`，需要 **≥ 23.6**（Node 内置类型擦除，不需要 ts-node）
- 宿主：TypeScript + Vite（SDK 是 TS 源码，其他构建工具需要自行加编译步骤）

---

## 六、构建与打包

```bash
cd Argus-Util
npm i
npm run build      # 产出 dist/sdk（ESM + .d.ts）与 dist/cli
npm run typecheck  # 只做类型检查，不产出文件
npm pack           # 打成 tarball（只含 dist/ 与 README/package.json）
```

包入口有两个，各管一件事：

| 用途 | 字段 | 指向 |
|---|---|---|
| `import { initArgus } from 'argus-util'` | `main` / `exports` / `types` | `dist/sdk/index.js` + `index.d.ts` |
| `npx argus-cli` | `bin` | `dist/cli/index.js` |

---

## 七、升级

拷进来的副本不会自动更新。更新时：

1. 从 Argus 仓库重新拷 `sdk/` 和 `cli/`（覆盖）
2. 保留自己的 `.env`
3. 重新跑一次 `--dry-run` 确认路径换算没变
