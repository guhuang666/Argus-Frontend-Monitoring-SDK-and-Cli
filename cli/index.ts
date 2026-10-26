#!/usr/bin/env node
/**
 * argus-cli —— 把构建产物里的 Sourcemap 传到 Argus 服务器（FR-3.1 / FR-9.2）
 *
 * 用法：
 *   node Argus-Util/cli/index.ts --release web@1.0.0 --dir ./dist --dry-run   ← 先看清单，不联网
 *   node Argus-Util/cli/index.ts --release web@1.0.0 --dir ./dist             ← 真传
 *
 * ── 私钥从哪来 ──────────────────────────────────────────────────────────
 * **当前工作目录**的 .env 里的 `ARGUS_SECRET`。也可以用 `--secret` 临时覆盖。
 * 只读 .env，不读 shell 环境变量 —— 规则一句话说得清，不会出现
 * "我明明没设变量，它却用了某个值"这种谜。
 *
 * ── 为什么上传地址里没有 projectId ──────────────────────────────────────
 * 私钥本身就是**项目级**凭据：数据库 `project_keys` 那一行就带 project_id，
 * 服务端 `sha256(私钥)` 反查一次就知道是哪个项目。
 * 早先要求客户端同时给出 projectId 和私钥，等于把"我是哪个项目"说两遍，
 * 两遍不一致时只能回一句 401 —— 使用者完全看不出是钥匙错了还是项目选错了。
 * 现在这类错误在物理上不存在。
 *
 * ── 为什么默认先 dry-run 是这个工具最重要的设计 ──────────────────────────
 * 路径换算（paths.ts）错了**不会报任何错**，只会让后面的 Worker 匹配不上 map，
 * 然后你在"明明传了却还原不出来"里耗掉两小时。所以先花 10 秒看一眼清单。
 *
 * 参数解析用 Node 内置的 parseArgs，不上 commander：参数就这么几个，
 * 一个依赖都不引。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findSourcemaps } from './discover.ts';
import { toArtifactPath, validateArtifactPath } from './paths.ts';
import { uploadAll, type UploadResult, type UploadTarget } from './upload.ts';

const DEFAULT_ENDPOINT = 'http://localhost:3000';
const RELEASE_MAX = 100;

/**
 * 凭据文件：**当前工作目录**下的 .env。
 *
 * 不往上递归找父目录：那会让"我到底用了哪个文件"变成需要推理的事，
 * 而读错文件的表现是 401，很难反推。只认 cwd 的规则一句话说得清：
 * **你在哪个目录敲命令，就用哪个目录的 .env。**
 */
const ENV_FILE = resolve('.env');

/**
 * 读 .env 里的键值对。
 *
 * ── 为什么自己解析，不用 process.loadEnvFile ────────────────────────────
 * `loadEnvFile` 会把值写进 `process.env`，而它**不覆盖已存在的变量**。
 * 于是 shell 里恰好 export 过一个同名变量时，那个值会悄悄赢过文件 ——
 * 等于又开了一条"环境变量"的路，而当前约定是"只认这个 .env 文件"。
 * 自己解析没有这个歧义，还能顺手剥掉 BOM。
 *
 * 支持的语法只有三种：`KEY=value`、`KEY="value"`、`# 注释`。
 * 多行值、`${VAR}` 引用一律不支持 —— .env 里用不到，实现了只会多 bug。
 */
function readEnvFile(filePath: string): Map<string, string> {
  const values = new Map<string, string>();

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    // 文件不存在 = 没有配置，交给调用方报"缺少私钥"
    return values;
  }

  // PowerShell 的 Set-Content -Encoding utf8、旧版记事本都会写 BOM。
  // 不剥掉的话，第一行的键名会变成 "\uFEFFARGUS_SECRET"，读不到。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));

    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // 没引号时，` #` 之后当行尾注释
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    if (key !== '') values.set(key, value);
  }

  return values;
}

const USAGE = `
argus-cli —— 上传 Sourcemap 到 Argus

用法
  node Argus-Util/cli/index.ts --release <版本号> --dir <构建产物目录> [选项]

必填
  --release <string>     版本号，如 web@1.0.0。必须与 SDK initArgus({release}) 逐字节一致
  --dir <string>         构建产物目录，如 ./dist

凭据从哪来
  私钥读**当前工作目录**下的 .env：
    ARGUS_SECRET="argus_sec_..."        项目私钥

  也可以用命令行临时覆盖（CI 注入，或不想写文件）：
    --secret <string>     覆盖 .env 里的 ARGUS_SECRET

  · 只读 .env，不读 shell 环境变量 —— 避免"我到底用了哪把钥匙"变成猜。
  · 换目录就换 .env：在哪个目录敲命令，就用哪个目录的配置。
  · 上传地址里不带项目 id：私钥是哪把，就传到哪个项目。

  · 注意：私钥必须与 SDK 里配的公钥属于**同一个项目**，
    否则 map 传上去了，事件却记在另一个项目名下 —— 堆栈永远是"未符号化"。

选项
  --dry-run              只打印将要上传的清单，不发任何请求【建议先跑这个】
                         （这一步不需要私钥）
  --url-prefix <string>  产物在站点上的前缀，默认 "/"。Vite 配了 base: '/app/' 时传 /app/
  --endpoint <string>    服务端地址，默认 ${DEFAULT_ENDPOINT}
  --concurrency <number> 并发数，默认 4
  --help                 显示本帮助

示例
  # ① 只看清单（不需要私钥）
  node Argus-Util/cli/index.ts --release web@1.0.0 --dir ./dist --dry-run

  # ② 项目根目录建好 .env 后，直接传
  node Argus-Util/cli/index.ts --release web@1.0.0 --dir ./dist

  # ③ 临时覆盖私钥
  node Argus-Util/cli/index.ts --release web@1.0.0 --dir ./dist --secret argus_sec_xxx

退出码
  0 全部成功   1 参数错误 / 有文件上传失败
`.trimStart();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      dir: { type: 'string' },
      'url-prefix': { type: 'string', default: '/' },
      endpoint: { type: 'string', default: DEFAULT_ENDPOINT },
      secret: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    // 不认识的参数直接报错退出，而不是静默忽略 ——
    // 拼错 --release 却没收到任何提示，是 CLI 最气人的体验
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // ── 凭据 ────────────────────────────────────────────────────────────
  // 命令行优先（CI 注入 / 临时换），否则用当前目录 .env 里的 ARGUS_SECRET
  const envValues = readEnvFile(ENV_FILE);
  const envFileExists = existsSync(ENV_FILE);
  const secret = values.secret?.trim() || envValues.get('ARGUS_SECRET')?.trim();
  const secretSource = values.secret !== undefined ? '命令行 --secret' : ENV_FILE;

  // ── 参数校验 ────────────────────────────────────────────────────────
  const release = values.release?.trim();
  if (!release) {
    return fail('缺少 --release。例如：--release web@1.0.0');
  }
  if (release.length > RELEASE_MAX) {
    return fail(`--release 超过 ${RELEASE_MAX} 字符（后端列宽限制），当前 ${release.length}`);
  }

  const dirInput = values.dir?.trim();
  if (!dirInput) {
    return fail('缺少 --dir。例如：--dir ./dist');
  }
  const dirAbs = resolve(dirInput);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return fail(`--dir 不是有效目录：${dirAbs}`);
  }

  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    return fail(`--concurrency 必须是 1~16 的整数，当前是 ${values.concurrency}`);
  }

  const urlPrefix = values['url-prefix'] ?? '/';

  // ── 收集待上传清单 ──────────────────────────────────────────────────
  const mapFiles = findSourcemaps(dirAbs);
  if (mapFiles.length === 0) {
    return fail(`目录里没有 .map 文件：${dirAbs}`);
  }

  const targets: UploadTarget[] = mapFiles.map((mapAbs) => ({
    mapAbs,
    artifactPath: toArtifactPath(mapAbs, dirAbs, urlPrefix),
    size: statSync(mapAbs).size,
  }));

  // 路径不合法的先挑出来：本地能发现的错不要发给服务器
  const invalid = targets
    .map((t) => ({ t, reason: validateArtifactPath(t.artifactPath) }))
    .filter((x): x is { t: UploadTarget; reason: string } => x.reason !== null);

  if (values['dry-run']) {
    printListing(release, dirAbs, targets, invalid);
    // 清单里存在非法路径 → 退出码 1，让 CI / 脚本也能拦住
    return invalid.length > 0 ? 1 : 0;
  }

  if (invalid.length > 0) {
    printListing(release, dirAbs, targets, invalid);
    process.stderr.write(
      `\n发现 ${invalid.length} 个非法路径，已中止（没有上传任何文件）。\n` +
        `这通常是 --url-prefix 不对，或产物目录选错了。\n`,
    );
    return 1;
  }

  // ── 真上传 ──────────────────────────────────────────────────────────
  // 私钥缺失放在 dry-run 之后拦：只想看清单的人不该被凭据卡住。
  // 而一旦要真传，就必须在本地先报错 —— 否则表现成"每个文件都 401"，
  // 最后只剩一屏失败汇总，看不出根因只是少配了一把钥匙。
  if (secret === undefined) {
    const detail = envFileExists
      ? '（文件存在，但里面没有 ARGUS_SECRET）'
      : '（文件不存在）';

    return fail(
      [
        `缺少私钥，无法上传。当前查找的凭据文件：${ENV_FILE}${detail}`,
        '',
        '两种给法：',
        '',
        '  ① 在这个文件里写一行：',
        '       ARGUS_SECRET="argus_sec_..."',
        '',
        '  ② 本次命令临时指定：',
        '       --secret argus_sec_...',
        '',
        '  ⚠️ 私钥决定传到哪个项目，写错就是传到别人名下（或 401）。',
      ].join('\n'),
    );
  }

  process.stdout.write(
    `\n${release} · ${targets.length} 个 map → ${values.endpoint}/api/v1/sourcemaps （并发 ${concurrency}）\n` +
      `   私钥来源：${secretSource}\n\n`,
  );

  let done = 0;
  // 支持 Ctrl+C 中断：已传的不会回滚，重跑靠服务端的 (release_id, artifact_path) 幂等覆盖
  const results = await uploadAll({
    endpoint: values.endpoint ?? DEFAULT_ENDPOINT,
    secret,
    release,
    targets,
    concurrency,
    onResult: (r) => {
      done += 1;
      process.stdout.write(`  ${formatResultLine(r, done, targets.length)}\n`);
    },
  });

  return printSummary(results);
}

/** 一行结果：[12/37] ✓ /assets/index.js  183.4 KB */
function formatResultLine(r: UploadResult, index: number, total: number): string {
  const tag = `[${String(index).padStart(String(total).length)}/${total}]`;
  if (r.ok) {
    const mark = r.reused ? '↻' : '✓';
    return `${tag} ${mark} ${r.target.artifactPath}  ${formatSize(r.target.size)}`;
  }
  return `${tag} ✗ ${r.target.artifactPath}  ${r.error ?? '未知错误'}`;
}

/** dry-run 的清单输出：每一行是一条将要写进 sourcemap_files 的记录 */
function printListing(
  release: string,
  dirAbs: string,
  targets: UploadTarget[],
  invalid: Array<{ t: UploadTarget; reason: string }>,
): void {
  const bad = new Set(invalid.map((x) => x.t.artifactPath));
  const width = Math.min(64, Math.max(...targets.map((t) => t.artifactPath.length)));
  const totalSize = targets.reduce((sum, t) => sum + t.size, 0);

  process.stdout.write(`\n${release} · 从 ${dirAbs} 找到 ${targets.length} 个 map\n\n`);

  for (const t of targets) {
    const mark = bad.has(t.artifactPath) ? '✗' : ' ';
    process.stdout.write(
      `  ${mark} ${t.artifactPath.padEnd(width)}  ${formatSize(t.size).padStart(9)}\n`,
    );
  }

  process.stdout.write(`\n共 ${targets.length} 个，合计 ${formatSize(totalSize)}\n`);

  if (invalid.length > 0) {
    process.stdout.write(`\n有 ${invalid.length} 个路径不合法：\n`);
    for (const { t, reason } of invalid) {
      process.stdout.write(`  ✗ ${t.artifactPath}\n      原因：${reason}\n`);
    }
  }

  process.stdout.write('\n（--dry-run：没有上传任何文件）\n');
}

function printSummary(results: UploadResult[]): number {
  const failed = results.filter((r) => !r.ok);
  const reused = results.filter((r) => r.ok && r.reused).length;
  const uploaded = results.length - failed.length - reused;
  const bytes = results.filter((r) => r.ok).reduce((sum, r) => sum + r.target.size, 0);

  if (failed.length === 0) {
    process.stdout.write(
      `\n✓ 成功 ${results.length}（新增 ${uploaded} · 覆盖 ${reused}）` +
        `  合计 ${formatSize(bytes)}\n`,
    );
    return 0;
  }

  process.stdout.write(`\n✗ 失败 ${failed.length} / 共 ${results.length}\n`);
  for (const r of failed) {
    process.stdout.write(`  · ${r.target.artifactPath}\n    ${r.error ?? '未知错误'}\n`);
  }
  return 1;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fail(message: string): number {
  process.stderr.write(`\n✗ ${message}\n\n用 --help 查看用法\n`);
  return 1;
}

// main 返回退出码，这里统一写进 process.exitCode，**不调 process.exit()**。
//
// 实测踩到的坑：stdout 接到管道时（PowerShell 的 |、CI 的日志采集），
// 写完立刻 process.exit() 会在 libuv 里撞 UV_HANDLE_CLOSING 断言
// （--help 就崩过一次）。改成只设退出码，让 Node 把缓冲区写完再自然退出；
// 脚本判断成败靠的仍是这个数字，语义没变。
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`\n✗ 未预期的错误：${String(err)}\n`);
    process.exitCode = 1;
  },
);
