/**
 * 前端包实际注册的组件版本
 *
 * 这个文件是**纯数据**，不引任何 React —— 有两个地方要读它：
 *
 *   1. 浏览器里的注册表（registry.ts），闸3 用它判断能不能渲染；
 *   2. 服务端自测（scripts/selftest.ts），node 里跑不了 .tsx，
 *      但它照样需要知道「前端到底认哪些版本」才能验证闸3。
 *
 * 一开始这两个地方各写一份，改版本号时漏掉一边的后果很隐蔽：
 * 自测全绿，线上白屏。抽出来的成本是一个文件，收益是版本号只有一处定义。
 *
 * 数组而不是单值：v1/v2 并存是文档 R1 的对策 —— 灰度期内老用户还在用旧包，
 * 两个版本都要能渲染，不能一升级就把在途会话打断。
 */

import type { ComponentRegistry } from "../../core/guardrails/gates";
import type { ComponentName } from "../../core/protocol/types";
import { COMPONENT_NAMES } from "../../core/protocol/schema";

export const SUPPORTED_COMPONENT_VERSIONS: Record<ComponentName, string[]> = {
  OrderTable: ["1"],
  RefundForm: ["1"],
  RefundReasonChart: ["1"],
  ResultCard: ["1"],
};

/** 按给定的版本表造一个注册表。前端与自测各传各的表，逻辑只有这一份。 */
export function makeRegistry(
  versions: Record<ComponentName, string[]>,
): ComponentRegistry {
  return {
    has(component, version) {
      return versions[component]?.includes(version) ?? false;
    },
    list() {
      return COMPONENT_NAMES.flatMap((name) => (versions[name] ?? []).map((v) => `${name}@${v}`));
    },
  };
}
