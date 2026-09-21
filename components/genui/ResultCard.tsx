"use client";

import type { ResultCardProps } from "@/core/protocol/types";
import { resolveParams, type GenUIComponentProps } from "./util";

/**
 * 结果卡片
 *
 * 这张卡片最重要的性质是「它只在服务端真的产生了结果之后才可能出现」——
 * 模型的工具定义里写死了「不用于展示尚未发生的结果」，执行层还有一道：
 * 结果只能从服务端会话的 lastRefundResult 里取，取不到就拒绝出卡。
 * 所以用户看到的每一个字，都是已经发生过的事。
 */

/** detail 的键是服务端定的，展示名归前端 —— 与 OrderTable 的列是同一个分工 */
const DETAIL_LABEL: Record<string, string> = {
  refundId: "退款单号",
  orderNo: "订单号",
  amount: "退款金额",
  expectedArrival: "预计到账",
  duplicated: "提交情况",
  rejectReason: "未通过原因",
};

const HEADLINE: Record<ResultCardProps["status"], { tone: string; mark: string }> = {
  success: { tone: "ok", mark: "✓" },
  fail: { tone: "danger", mark: "!" },
  pending: { tone: "warn", mark: "…" },
};

export function ResultCard({ props, onAction, disabled }: GenUIComponentProps<ResultCardProps>) {
  const { status, title, detail, nextActions = [] } = props;
  const head = HEADLINE[status] ?? HEADLINE.pending;

  return (
    <div className="genui">
      <div className="genui-head">
        <span>
          <span className={`tag ${head.tone}`} style={{ marginRight: 8 }}>
            {head.mark}
          </span>
          {title}
        </span>
      </div>

      <div className="genui-body">
        <div className="result-card">
          {Object.entries(detail).map(([k, v]) => (
            <div className="result-row" key={k}>
              <span style={{ color: "var(--muted)" }}>{DETAIL_LABEL[k] ?? k}</span>
              <b>{String(v ?? "-")}</b>
            </div>
          ))}
        </div>

        {nextActions.length > 0 && (
          <div className="form-actions" style={{ marginTop: 12 }}>
            {nextActions.map((a) => (
              <button
                key={a.action}
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => onAction({ action: a.action, params: resolveParams(a.params, detail) })}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
