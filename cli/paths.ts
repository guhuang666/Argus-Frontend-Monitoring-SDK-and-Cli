import { relative, sep } from 'node:path';

/**
 * 磁盘路径 → 站点路径。**整个 M3 最关键的十几行代码。**
 *
 * 例：
 *   mapAbs  = E:\Argus\dashboard\dist\assets\index-CiM-gKBb.js.map
 *   dirAbs  = E:\Argus\dashboard\dist
 *   urlPrefix = /
 *   → /assets/index-CiM-gKBb.js
 *
 * 为什么存"产物路径"而不是 map 自己的路径：浏览器堆栈里出现的是那个 `.js`，
 * Worker 拿到 `/assets/index-CiM-gKBb.js` 来查表，表里就必须是同一个字符串。
 *
 * ── 三条不许存 ────────────────────────────────────────────────────────
 *   · 不带 origin：同一份产物可能被 localhost / CDN / 预发域名加载，
 *     带 origin 会让同一条记录分裂成多条，Worker 永远匹配不上
 *   · 不带 query：`?v=2` 是版本化参数，不属于文件身份
 *   · 不带 :line:col：那是堆栈里的位置，不是文件路径
 *
 * ── 这条规则一共出现三次 ──────────────────────────────────────────────
 *   CLI（这里）算出来 → 服务端校验 → Worker 从堆栈里算出来去查表。
 *   三份实现不一致 = "明明传了 map 却匹配不上"，而且**不会报错**。
 *   改这里必须同步改另外两处，并确保两边对下面这 5 个输入给出同一结果：
 *     /a/b.js  ·  a/b.js  ·  C:\x\a.js  ·  http://h/a/b.js?v=1  ·  /a/b.js:12:3
 */
export function toArtifactPath(mapAbs: string, dirAbs: string, urlPrefix = '/'): string {
  // Windows 上 relative() 返回反斜杠（assets\index.js.map），不转换的话
  // 拼出来就是 \assets\index.js —— 这条最容易漏，也最难排查
  const rel = relative(dirAbs, mapAbs).split(sep).join('/');

  // index.js.map → index.js：表里存的是**产物**，不是 map 自己
  const artifactRel = rel.replace(/\.map$/, '');

  // 前缀来自 Vite 的 base 配置（base: '/app/' 时产物部署在 /app/assets/…）。
  // 先统一去掉尾部斜杠，再用一个 / 拼，避免出现 //assets
  const prefix = urlPrefix.replace(/\/+$/, '');

  return `${prefix}/${artifactRel}`;
}

/**
 * 与后端 sourcemaps.service 的校验规则保持一致。
 *
 * 为什么 CLI 侧也要校验一遍：路径是本地算出来的，发送前自查能立刻指出
 * "是这个文件的问题"，而不是等服务器回一个 400 再去猜。返回 null 表示合法。
 */
export function validateArtifactPath(artifactPath: string): string | null {
  if (!artifactPath.startsWith('/')) return '必须以 / 开头';
  if (artifactPath.length > 500) return '超过 500 字符（列宽限制）';
  if (artifactPath.includes('//')) return '含连续斜杠';
  if (artifactPath.includes('..')) return '含 ..（疑似路径穿越）';
  if (artifactPath.includes('\\')) return '含反斜杠';
  if (/[?#]/.test(artifactPath)) return '含 query 或 hash';
  if (/:\d+:\d+$/.test(artifactPath)) return '含 :行:列（这应该是堆栈位置，不是文件路径）';
  return null;
}
