"use client";

import type { RefundReasonChartProps } from "@/core/protocol/types";
import type { GenUIComponentProps } from "./util";

/**
 * 退款原因分布
 *
 * 用纯 CSS 柱条而不是图表库。理由不是「省一个依赖」那么表面：
 * 图表库通常要求把数据转成它自己的结构，于是「服务端给的数」和「画出来的图」之间
 * 多了一层转换 —— 那一层出了问题，是数据错还是渲染错就说不清了。
 * 这里的映射只有一条：宽度 = value / max。
 *
 * CSS 也能直接吃到 prefers-reduced-motion，图表库的动画得另外关。
 */
export function RefundReasonChart({ props }: GenUIComponentProps<RefundReasonChartProps>) {
  const { data, measure } = props;
  const max = Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="genui">
      <div className="genui-head">
        <span>退款原因分布</span>
        <span className="tag neutral">{measure === "amount" ? "按金额" : "按笔数"}</span>
      </div>

      <div className="genui-body">
        <div className="bars">
          {data.map((d) => (
            <div className="bar-row" key={d.label}>
              <span>{d.label}</span>
              <span className="bar">
                <i style={{ width: `${Math.max((d.value / max) * 100, 3)}%` }} />
              </span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {measure === "amount" ? `¥${d.value.toFixed(0)}` : d.value}
              </span>
            </div>
          ))}
        </div>

        <div className="callout" style={{ marginTop: 12 }}>
          合计 {measure === "amount" ? `¥${total.toFixed(0)}` : `${total} 笔`}。数据由退款服务按你的账号实时聚合，
          不包含其他账号的记录。
        </div>
      </div>
    </div>
  );
}
