"use client";

/**
 * 前端组件注册表
 *
 * 与后端 `RENDERABLE_COMPONENT_VERSIONS`（core/protocol/envelope.ts）是同一份信息的
 * 两个视角：后端那份说「协议允许渲染到什么版本」，这份说「**这个前端包里真的有**」。
 *
 * 灰度期间两者必然不一致：后端按新协议下发了 OrderTable@2，而某个用户浏览器里还是
 * 昨天的包，只有 v1。那种情况下的正确行为是降级，不是白屏 —— 这就是闸3 要多查一次
 * 注册表的原因，也是它不能被闸2 替代的原因。
 *
 * 版本清单本身不写在这里，而是从 supported.ts 读 —— 那份数据服务端自测也要用。
 */

import type { ComponentType } from "react";
import type { ComponentName } from "@/core/protocol/types";
import { OrderTable } from "./OrderTable";
import { RefundForm } from "./RefundForm";
import { RefundReasonChart } from "./RefundReasonChart";
import { ResultCard } from "./ResultCard";
import { SUPPORTED_COMPONENT_VERSIONS, makeRegistry } from "./supported";
import type { GenUIComponentProps } from "./util";

interface Registration {
  // 各组件 props 形状不同，注册表统一按最宽的形状持有；真正的类型安全由
  // EnvelopeRenderer 里「先过闸3 再取组件」的顺序保证 —— 走到渲染时 props 已经过 Schema 校验。
  Component: ComponentType<GenUIComponentProps<never>>;
}

const COMPONENTS: Record<ComponentName, Registration> = {
  OrderTable: { Component: OrderTable as unknown as Registration["Component"] },
  RefundForm: { Component: RefundForm as unknown as Registration["Component"] },
  RefundReasonChart: { Component: RefundReasonChart as unknown as Registration["Component"] },
  ResultCard: { Component: ResultCard as unknown as Registration["Component"] },
};

export const frontendRegistry = makeRegistry(SUPPORTED_COMPONENT_VERSIONS);

export function getComponent(component: ComponentName): Registration["Component"] | null {
  return COMPONENTS[component]?.Component ?? null;
}
