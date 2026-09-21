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
  // 这个包里 RefundReasonChart.tsx 已经会渲染 v2 的可选字段（有则显示、没有就不显示），
  // 所以清单里必须写 "2" —— 这份清单的意思是「本包**真的能**渲染什么」，不是「本包主推什么」。
  //
  // 写成 ["1"] 的后果很隐蔽：协议层、Schema、工具执行、灰度分桶全都齐了，
  // 灰度开关一打开，闸3 却拿着这份清单把 v2 判为「版本未注册」，
  // 于是**全量用户看到的都是降级文本块** —— 功能没坏，但没人看得到。
  // 真实发布的顺序是「先发前端包，再开灰度」，这份清单就是那个顺序的凭证。
  RefundReasonChart: ["1", "2"],
  ResultCard: ["1"],
};

/**
 * 灰度期「还没升级的旧包」长什么样
 *
 * 不是另一份手写清单，而是从上面**减掉 v2** —— 这样旧包的形状永远跟着当前包走，
 * 加新组件时不会漏改，也就不会出现「测试里的旧包比真实旧包还旧」这种假演练。
 */
export function olderBundleVersions(): Record<ComponentName, string[]> {
  return Object.fromEntries(
    Object.entries(SUPPORTED_COMPONENT_VERSIONS).map(([name, versions]) => [
      name,
      versions.filter((v) => v !== "2"),
    ]),
  ) as Record<ComponentName, string[]>;
}

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
