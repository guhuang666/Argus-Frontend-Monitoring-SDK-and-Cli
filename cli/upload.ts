import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** 一条待上传记录：本地哪个文件、对应站点上哪个路径、多大 */
export interface UploadTarget {
  mapAbs: string;
  artifactPath: string;
  size: number;
}

export interface UploadResult {
  target: UploadTarget;
  ok: boolean;
  /** 服务端表示"这个 (release, artifact_path) 之前就有了，本次是覆盖" */
  reused?: boolean;
  error?: string;
}

/**
 * 上传一张 map。
 *
 * 用 Node 内置的 FormData / Blob / fetch，**不装 form-data、axios、undici 任何一个** ——
 * 这个工具总共两百行，为一次 multipart 请求装三个包不划算。
 *
 * 重试策略只有一条：**5xx 和网络错误重试一次，4xx 永不重试**。
 * 4xx 是参数错（路径不合法、release 超长、token 不对），重试一万次结果都一样，
 * 只会把一次错误变成几十次错误。
 */
export async function uploadOne(opts: {
  endpoint: string;
  secret: string;
  release: string;
  target: UploadTarget;
}): Promise<UploadResult> {
  const { target } = opts;
  // 地址里不带项目 id：私钥本身就标识了项目，服务端反查。
  // 少一个参数就少一种"两个值配错"的失败模式 —— 调用方没有机会说错项目。
  const url = `${opts.endpoint.replace(/\/+$/, '')}/api/v1/sourcemaps`;

  // 读一次，两个字段共用：重试时不必再读盘
  const content = readFileSync(target.mapAbs);

  const send = (): Promise<Response> => {
    // 每次重试都要新的 FormData：部分 fetch 实现对已消费的 body 会报错，
    // 多建一个对象的成本远小于"重试永远失败"的排查成本
    const form = new FormData();
    form.append('release', opts.release);
    form.append('artifact_path', target.artifactPath);
    form.append('file', new Blob([content]), basename(target.mapAbs));

    return fetch(url, {
      method: 'POST',
      // 私钥走 Authorization，与 SDK 的公钥（X-Argus-Key）在形式上就区分开 ——
      // 两者能力完全不同，混用同一个头会让"我到底传的是哪把钥匙"变得靠猜
      headers: { authorization: `Bearer ${opts.secret}` },
      body: form,
    });
  };

  try {
    let res = await send();
    if (res.status >= 500) {
      res = await send();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { target, ok: false, error: `HTTP ${res.status} ${truncate(text, 120)}`.trim() };
    }

    const body = (await res.json().catch(() => ({}))) as { reused?: boolean };
    return { target, ok: true, reused: body.reused };
  } catch (err) {
    // fetch 抛错通常是没有对端（ECONNREFUSED）、DNS 失败、超时
    return { target, ok: false, error: String(err) };
  }
}

/**
 * 并发上传。
 *
 * 用最土的"切片 + Promise.all"，不引 p-limit：并发数固定、任务数固定
 * （几十个），一个 10 行的池子和一个依赖没区别，而依赖要占一行 package.json。
 *
 * 并发给 4 而不是 32：瓶颈在服务端写盘和 Postgres 的 upsert，
 * 打太高只是把队列堆在对方进程里。
 */
export async function uploadAll(opts: {
  endpoint: string;
  secret: string;
  release: string;
  targets: UploadTarget[];
  concurrency: number;
  onResult?: (result: UploadResult) => void;
}): Promise<UploadResult[]> {
  const results: UploadResult[] = [];

  for (let i = 0; i < opts.targets.length; i += opts.concurrency) {
    const batch = opts.targets.slice(i, i + opts.concurrency);
    const settled = await Promise.all(
      batch.map((target) =>
        uploadOne({
          endpoint: opts.endpoint,
          secret: opts.secret,
          release: opts.release,
          target,
        }),
      ),
    );

    for (const result of settled) {
      results.push(result);
      opts.onResult?.(result);
    }
  }

  return results;
}

function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`;
}
