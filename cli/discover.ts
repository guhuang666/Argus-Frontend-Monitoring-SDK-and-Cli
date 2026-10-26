import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 递归找出目录下所有 `*.map`。
 *
 * 三个刻意的选择：
 *   · 只认后缀，不解析内容 —— 判断"这是不是一张 map"没必要把 5MB 的 JSON
 *     读进内存再 JSON.parse 一遍，后缀是构建工具自己写的，可信
 *   · 用 lstatSync 并跳过符号链接 —— 构建产物里偶尔有指向目录的软链，
 *     follow 下去可能绕成死循环，扫描直接挂住
 *   · 只返回文件，不返回目录 —— 调用方拿到的就是"待上传清单"，不需要再判断
 */
export function findSourcemaps(dirAbs: string): string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = lstatSync(full);

      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.map')) found.push(full);
    }
  };

  walk(dirAbs);
  // 排序只为输出稳定：同样的产物，两次运行的清单顺序必须一样，否则没法比 diff
  return found.sort();
}
