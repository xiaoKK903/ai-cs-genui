"use client";

import { useState } from "react";
import type { FormField, RefundFormProps } from "@/core/protocol/types";
import type { GenUIComponentProps } from "./util";

/**
 * 退款申请表单
 *
 * 三个设计点，都是为了让「关键操作」这四个字名副其实：
 *
 *   1. **金额字段不可编辑**。不是 disabled 让它看起来灰掉而已 —— 它的值压根不进
 *      表单状态，提交时也不带。用户改不了，模型更改不了，服务端只认订单里的数。
 *   2. **二次确认内联**。不用 window.confirm：弹窗能断言的东西太少，
 *      内联确认区可以被测试、可以被截图、可以在里面说清「退了多少钱、多久到账」。
 *   3. **提交按钮在提交期间禁用**。连点两下的后果是两笔退款申请 —— 即使服务端有幂等，
 *      也不该让用户走到那一步。
 */
export function RefundForm({ props, onAction, disabled }: GenUIComponentProps<RefundFormProps>) {
  const { orderNo, fields, submitAction, confirmRequired } = props;

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      // 只读字段不进 state —— 它们不可编辑，也就没有「值」需要被管理
      if (f.editable !== false && f.value !== undefined) init[f.name] = String(f.value);
    }
    return init;
  });
  const [confirming, setConfirming] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = fields.filter((f) => f.required && f.editable !== false && !values[f.name]?.trim());
  const orderField = fields.find((f) => f.name === "orderNo");
  const amountField = fields.find((f) => f.type === "money");

  function submit() {
    if (missing.length > 0) {
      setError(`请先填写：${missing.map((f) => f.label).join("、")}`);
      return;
    }
    setError(null);

    if (confirmRequired && !confirming) {
      setConfirming(true);
      return;
    }

    setSubmitted(true);
    setConfirming(false);
    // 只读字段的值从 props 取（服务端给的权威值），不从 state 取 ——
    // state 里根本没有它，从根上杜绝了它被改动后提交上去的可能
    onAction({
      action: submitAction,
      params: { orderNo, ...values },
    });
  }

  return (
    <div className="genui">
      <div className="genui-head">
        <span>退款申请</span>
        <span className="tag info">{orderNo}</span>
      </div>

      <div className="genui-body">
        <div className="genui-form">
          {fields.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={values[f.name] ?? ""}
              disabled={disabled || submitted}
              onChange={(v) => {
                setValues((prev) => ({ ...prev, [f.name]: v }));
                setConfirming(false);
                setError(null);
              }}
            />
          ))}

          {error && <div className="callout danger">{error}</div>}

          {confirming && (
            <div className="callout warn">
              确认要对订单 <b>{orderNo}</b> 提交退款申请吗？
              {amountField ? `金额以系统记录为准（${String(amountField.value)}），提交后进入审核。` : ""}
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="primary" disabled={disabled || submitted} onClick={submit}>
              {submitted ? "已提交" : confirming ? "确认提交" : "提交退款申请"}
            </button>
            {confirming && (
              <button type="button" className="secondary" disabled={disabled} onClick={() => setConfirming(false)}>
                再改改
              </button>
            )}
            <span className="typing" style={{ fontSize: 12 }}>
              提交后由系统校验执行，客服不会直接操作你的账户
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  // editable:false —— 只读展示。金额走这条路径，闸2 会强制要求 money 字段必须只读且带 source。
  const readOnly = field.editable === false;

  return (
    <div className="field">
      <label htmlFor={`f_${field.name}`}>
        {field.label}
        {field.required && !readOnly ? " *" : ""}
      </label>

      {readOnly ? (
        <div className="readonly" id={`f_${field.name}`} style={{ padding: "8px 9px", borderRadius: 6 }}>
          <span>{String(field.value ?? "-")}</span>
        </div>
      ) : field.type === "select" ? (
        <select id={`f_${field.name}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">请选择</option>
          {/* 受控枚举：选项只来自 props，不接受任何运行时拼装 */}
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" ? (
        <textarea
          id={`f_${field.name}`}
          rows={2}
          value={value}
          disabled={disabled}
          maxLength={200}
          placeholder="选填，补充说明有助于加快审核"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={`f_${field.name}`}
          value={value}
          disabled={disabled}
          maxLength={64}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {readOnly && field.source && <span style={{ fontSize: 11, color: "var(--muted)" }}>来源：{field.source}</span>}
    </div>
  );
}
