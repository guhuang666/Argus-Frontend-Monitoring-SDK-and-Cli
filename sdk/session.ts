/**
 * 会话（M5 / FR-1.23）—— 只产出一个 session_id。
 *
 * 规则只有一条：距上次活动超过 30 分钟就算新会话，否则续期。
 * 判定和写入必须在同一个函数里，否则会造出"离开 40 分钟回来仍被续进旧会话"的漏洞。
 */
import { genId, throttle } from './common';

const SESSION_KEY = 'argus_session';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_TOUCH_THROTTLE_MS = 30_000;

interface SessionRecord {
  id: string;
  lastActivity: number;
}

/**
 * 当前会话：没存过 / 空闲超过 30 分钟 → 新建，否则续期。
 *
 * 唯一的 try/catch 只包存储：私密模式下 localStorage 会直接抛，
 * 而这个函数是从点击监听里调用的 —— 抛出去就是 SDK 把宿主页面弄崩。
 * 存储不可用时退化成"一次性会话"，事件照样能上报。
 */
export function currentSession(): SessionRecord {
  const now = Date.now();
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as SessionRecord | null;
    const session =
      saved === null || now - saved.lastActivity > SESSION_IDLE_MS
        ? { id: genId(), lastActivity: now }
        : { ...saved, lastActivity: now };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  } catch {
    return { id: genId(), lastActivity: now };
  }
}

/** 有活动就续期。hidden 时用户不在页面上，不算活动 */
export function touchSession(): void {
  if (document.visibilityState !== 'visible') return;
  currentSession();
}

/** 挂活动信号：三个事件共用一个节流器，避免一次操作写两次存储 */
export function installSessionTracking(): void {
  const onActivity = throttle(touchSession, SESSION_TOUCH_THROTTLE_MS);
  for (const type of ['click', 'keydown', 'scroll'] as const) {
    // passive 必须给：滚动监听不加它，浏览器要等回调跑完才滚，长列表页面会掉帧
    window.addEventListener(type, onActivity);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touchSession();
  });
}
