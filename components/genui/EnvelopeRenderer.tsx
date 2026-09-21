"use client";

import { useEffect, useMemo } from "react";
import { gate3CheckEnvelope } from "@/core/guardrails/gates";
import type { GenUIEnvelope } from "@/core/protocol/types";
import { frontendRegistry, getComponent } from "./registry";
import type { ActionPayload } from "./util";

/**
 * 信封 → DOM 的唯一通道
 *
 * 闸3 就在这里。整个应用里没有第二处直接渲染服务端信封的代码 ——
 * 这是有意收窄的：只要「渲染信封」这件事只有一个入口，那道校验就不可能被绕过。
 *
 * 校验不通过时**不抛异常、不返回 null**。返回 null 的后果是用户看到一小片空白，
 * 不知道是没查到还是坏了。这里渲染一个明确的降级块，并且把原因折叠在里面 ——
 * 用户看到的是「这句话没能用卡片展示」，工程师展开就能看到是哪一条校验挂了。
 */
export function EnvelopeRenderer({
  envelope,
  onAction,
  disabled,
  onGate3Result,
}: {
  envelope: GenUIEnvelope;
  onAction: (payload: ActionPayload) => void;
  disabled?: boolean;
  /** 把闸3 的结果告诉上层（面板统计用）。传回调而不是让上层自己判断，是为了只有一个判定点。 */
  onGate3Result?: (passed: boolean, reason?: string) => void;
}) {
  const checked = useMemo(() => gate3CheckEnvelope(envelope, frontendRegistry), [envelope]);

  // 闸3 的拦截要上报。服务端 trace 里记不到它 —— 它发生在浏览器里，
  // 不报回来，这一层就是黑盒，出了问题只能靠用户描述。
  useEffect(() => {
    onGate3Result?.(checked.passed, checked.passed ? undefined : checked.reason);
    if (checked.passed) return;
    void fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "gate3_rejected",
        correlationId: envelope?.correlationId,
        component: envelope?.component,
        componentVersion: envelope?.componentVersion,
        instanceId: envelope?.instanceId,
        reason: checked.reason,
      }),
      keepalive: true,
    }).catch(() => {});
  }, [checked, envelope, onGate3Result]);

  if (!checked.passed) {
    return (
      <div className="callout warn">
        这段内容暂时没法用卡片展示，已经按文字形式给你了。
        <details className="trace-detail">
          <summary>技术细节</summary>
          <pre>{`闸3 拦截：${checked.reason}`}</pre>
        </details>
      </div>
    );
  }

  const Component = getComponent(checked.envelope.component);
  if (!Component) {
    // 走到这里说明注册表的 has() 和 getComponent() 不一致 —— 注册表自身的 bug。
    // 与校验失败分开报，因为排查方向完全不同。
    return <div className="callout danger">组件注册表不一致：{checked.envelope.component}</div>;
  }

  return (
    <Component
      props={checked.envelope.props as never}
      onAction={onAction}
      disabled={disabled}
    />
  );
}
