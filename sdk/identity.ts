/**
 * 用户识别 —— 把事件归到"哪个人"。
 *
 * 三档降级（getter → 6 个自动探测源 → 匿名设备 ID），任何一档抛错都静默降级。
 * 不产事件，只被错误和性能两个域在**事件产生时**调用一次。
 *
 * ⚠️ JWT 源只解码不验签，所以 user.id 是不可信数据：
 *    后端不能拿它做权限判断，只能用于统计。
 */
import { genId } from './common'
import { options } from './config'

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
export const DEFAULT_USER_SOURCES: readonly string[] = [
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
export function resolveUser(): { id: string } | null {
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
