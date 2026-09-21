"use client";

/**
 * 护栏面板
 *
 * 它同时展示两边的视角，这是刻意的：
 *
 *   左边一列是**服务端 trace**（correlationId 查回来的），
 *   右边一列是**前端自己数出来的事实**。
 *
 * 分开展示是因为它们可能不一致，而不一致本身就是信息：
 * 服务端说下发了 3 个组件、前端只收到 2 个，那问题在网络或前端解析；
 * 服务端说闸2 全过、前端闸3 却在拦，那就是两边注册表不同步 —— 灰度的典型症状。
 * 合并成一个「状态：正常」的灯，这类差异就永远看不到了。
 */

interface Stats {
  skeletons: number;
  envelopes: number;
  gate3Rejected: number;
}

interface GateState {
  gate1?: { attempts?: number; passed?: boolean; error?: string };
  gate2?: { passed?: boolean; rejected?: string };
  gate3?: { passed?: boolean; rejected?: string };
}

export function GuardPanel({
  stats,
  serverTrace,
  serverState,
}: {
  stats: Stats;
  serverTrace: Record<string, unknown>[];
  serverState: Record<string, unknown>;
}) {
  const turn = serverTrace.find((r) => r.gates);
  const gates = (turn?.gates ?? {}) as GateState;
  const steps = (turn?.trace as { steps?: TraceStepLike[] } | undefined)?.steps ?? [];
  const clientReports = serverTrace.filter((r) => r.kind === "client_telemetry");

  return (
    <section className="panel" style={{ alignSelf: "start" }}>
      <div className="panel-head">
        <h2>护栏观测</h2>
        <span className="tag neutral">{turn ? `${String(turn.totalMs ?? "-")} ms` : "等待请求"}</span>
      </div>

      <div className="gate">
        <div className="gate-head">
          <b>闸1 · 约束解码</b>
          <GateTag passed={gates.gate1?.passed} extra={gates.gate1?.attempts ? `${gates.gate1.attempts} 次` : undefined} />
        </div>
        <p>模型推理侧。工具参数不合 Schema 时把错误回灌重试，最多 3 次。</p>
        {gates.gate1?.error && <p style={{ color: "var(--warn)" }}>{gates.gate1.error}</p>}
      </div>

      <div className="gate">
        <div className="gate-head">
          <b>闸2 · 后端出参</b>
          <GateTag passed={gates.gate2?.passed} />
        </div>
        <p>白名单 + props Schema + 注入检测。拦下就降级为文本，不修补、不重试。</p>
        {gates.gate2?.rejected && <p style={{ color: "var(--warn)" }}>{gates.gate2.rejected}</p>}
      </div>

      <div className="gate">
        <div className="gate-head">
          <b>闸3 · 前端渲染前</b>
          <GateTag passed={gates.gate3?.passed} extra={stats.envelopes > 0 ? `${stats.envelopes} 个信封` : undefined} />
        </div>
        <p>注册表 + 版本 + props 二次校验。跑在浏览器里，结果回传 /api/telemetry。</p>
        {stats.gate3Rejected > 0 && (
          <p style={{ color: "var(--warn)" }}>本会话前端已拦截 {stats.gate3Rejected} 次</p>
        )}
      </div>

      <div className="gate">
        <div className="gate-head">
          <b>本次会话（前端视角）</b>
        </div>
        <p>
          骨架 {stats.skeletons} 个 · 信封 {stats.envelopes} 个 · 回传 {clientReports.length} 条
        </p>
        <p>
          服务端会话副本：lastOrderNo = {String(serverState.lastOrderNo ?? "—")} · 退款结果{" "}
          {serverState.hasRefundResult ? "有" : "无"} · 存活实例 {String(serverState.liveInstanceCount ?? 0)}
        </p>
      </div>

      {steps.length > 0 && (
        <details className="trace-detail">
          <summary>服务端执行 trace（correlationId 查回）</summary>
          <table className="trace-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>步骤</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={i}>
                  <td>
                    <code>{s.name}</code>
                    {s.status !== "ok" && (
                      <span className={`tag ${s.status === "failed" ? "danger" : "warning"}`} style={{ marginLeft: 6 }}>
                        {s.status}
                      </span>
                    )}
                  </td>
                  <td>{s.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {Boolean(turn?.correlationId) && (
        <details className="trace-detail">
          <summary>correlationId</summary>
          <pre>{String(turn?.correlationId)}</pre>
        </details>
      )}
    </section>
  );
}

interface TraceStepLike {
  name: string;
  status: string;
  ms: number;
}

function GateTag({ passed, extra }: { passed?: boolean; extra?: string }) {
  if (passed === undefined) return <span className="tag neutral">未触发</span>;
  return (
    <span className={`tag ${passed ? "ok" : "danger"}`}>
      {passed ? "通过" : "拦截"}
      {extra ? ` · ${extra}` : ""}
    </span>
  );
}
