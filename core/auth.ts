/**
 * 登录态解析
 *
 * 这个文件只有一条规则，但它是整个系统里最重要的一条：
 *
 *   **userId 只能来自服务端可信渠道，永远不从请求体里读。**
 *
 * 请求体是客户端完全可控的。一旦代码里出现 `body.userId`，模型能不能越权就变成了
 * 「攻击者愿不愿意试一下」的问题 —— 而这道题的所有其他防线（工具入参白名单、
 * 组件 action 白名单）都拦不住它，因为那些防的是「模型乱来」，防不了「用户冒充别人」。
 *
 * 演示环境从 cookie 读；接真实系统时，这个函数整体换成 session / JWT 校验的结果即可 ——
 * 调用方拿到的仍然是「一个字符串」，不需要知道它是怎么来的。
 */

import { DEMO_SESSION_USER_ID } from "./data/mock-db";

const UID_COOKIE = "cs_uid";

/**
 * 解析当前请求的登录用户。
 *
 * 反过来读这段代码可以确认一件事：**没有任何入参能让它返回别的用户**。
 * request 里除了 header 什么都不看，body 根本不传进来。
 */
export function resolveUserId(request: Request): string {
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const match = new RegExp(`(?:^|;\\s*)${UID_COOKIE}=([^;]+)`).exec(cookie);
    if (match) {
      const uid = decodeURIComponent(match[1]).trim();
      // 演示环境只认这一个账号；真实环境这里应该是「查会话表，查不到就 401」
      if (uid === DEMO_SESSION_USER_ID) return uid;
    }
  }
  return DEMO_SESSION_USER_ID;
}

const SESSION_COOKIE = "cs_sid";

/**
 * 会话 ID 与身份是两回事：它是客户端可生成的随机串，只用来定位会话，
 * 换个说法就是「客户端说自己是哪次对话」，而不是「客户端说自己是哪个人」。
 * 所以它可以来自 body，userId 不可以。
 */
export function resolveSessionId(request: Request, body: { sessionId?: unknown }): string {
  if (typeof body.sessionId === "string" && body.sessionId.trim().length > 0) {
    return body.sessionId.trim().slice(0, 64);
  }
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
    if (match) return decodeURIComponent(match[1]).trim().slice(0, 64);
  }
  return `sess_${Math.random().toString(36).slice(2, 10)}`;
}
