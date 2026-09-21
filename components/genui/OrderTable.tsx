"use client";

import type { OrderTableProps } from "@/core/protocol/types";
import { formatDateTime, isActionVisible, resolveParams, statusTone, type GenUIComponentProps } from "./util";

/**
 * 订单表格
 *
 * 渲染完全由 props 驱动：列是服务端给的（受控枚举），行是业务 API 回填的。
 * 组件里没有一处「如果字段叫 xxx 就显示成 yyy」的业务判断 —— 有的话，
 * 新增一个字段就要改前端发版，协议层的解耦就白做了。
 *
 * 唯一的例外是标题。契约里没有 title 字段（也不该有：标题是渲染细节，不是数据），
 * 所以「我的订单」这几个字写在这里。
 */
export function OrderTable({ props, onAction, disabled }: GenUIComponentProps<OrderTableProps>) {
  const { columns, rows, rowActions = [], pagination } = props;
  const hasActions = rowActions.length > 0;

  return (
    <div className="genui">
      <div className="genui-head">
        <span>我的订单</span>
        {pagination && (
          <span className={`tag ${pagination.total > pagination.pageSize ? "info" : "neutral"}`}>
            共 {pagination.total} 笔
            {pagination.total > pagination.pageSize ? `，展示前 ${pagination.pageSize} 笔` : ""}
          </span>
        )}
      </div>

      <div className="genui-body" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} style={col.type === "money" ? { textAlign: "right" } : undefined}>
                  {col.title}
                </th>
              ))}
              {hasActions && <th style={{ width: 96 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={String(row.id ?? i)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={col.type === "money" ? { textAlign: "right", fontVariantNumeric: "tabular-nums" } : undefined}
                  >
                    {renderCell(col.type, row[col.key])}
                  </td>
                ))}
                {hasActions && (
                  <td style={{ textAlign: "right" }}>
                    {rowActions
                      .filter((ra) => isActionVisible(ra.action, row))
                      .map((ra) => (
                        <button
                          key={ra.action}
                          type="button"
                          className="secondary"
                          disabled={disabled}
                          style={{ padding: "4px 9px", fontSize: 12 }}
                          onClick={() => onAction({ action: ra.action, params: resolveParams(ra.params, row) })}
                        >
                          {ra.label}
                        </button>
                      ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderCell(type: string | undefined, value: unknown) {
  switch (type) {
    case "tag":
      return <span className={`tag ${statusTone(value)}`}>{String(value ?? "-")}</span>;
    case "datetime":
      return formatDateTime(value);
    case "money":
      return <b>{String(value ?? "-")}</b>;
    default:
      return String(value ?? "-");
  }
}
