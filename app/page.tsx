import { Chat } from "@/components/Chat";

/**
 * 单页演示。
 *
 * 刻意不做路由、不做登录页、不做多标签 —— 这个仓库要证明的是**协议层**，
 * 多一层导航就多一层「他到底想给我看什么」的噪音。
 * 左边栏列出这套设计的几个关键决策，是给第一次打开的人一个入口。
 */

const POINTS = [
  { icon: "①", title: "模型不生成组件", desc: "它调用一个「会返回组件的工具」—— 把选组件降维成 function calling" },
  { icon: "②", title: "三层解耦", desc: "SSE 传输 / 组件契约 / Agent 工具，任一层的改动不牵连另两层" },
  { icon: "③", title: "三道闸", desc: "重试 → 降级 → 不渲染，任何一层都不信任上一层" },
  { icon: "④", title: "服务端单一真相源", desc: "会话状态只在服务端，前端拿到的永远是副本" },
  { icon: "⑤", title: "数据不编造", desc: "props 里的每个值都来自业务系统，模型只传查询意图" },
];

export default function Page() {
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">GUI</span>
          AI 客服
        </div>

        <div className="group">设计要点</div>
        {POINTS.map((p) => (
          <div key={p.title} className="nav" style={{ cursor: "default" }}>
            <span>{p.icon}</span>
            <b style={{ fontSize: 13 }}>{p.title}</b>
            <div style={{ color: "#8491ad", fontSize: 11.5, marginTop: 2, lineHeight: 1.45 }}>{p.desc}</div>
          </div>
        ))}

        <div className="sidebar-note">
          默认走确定性 mock，不需要 API Key。想看真模型：设 <code>LLM_PROVIDER=anthropic</code> 与{" "}
          <code>ANTHROPIC_API_KEY</code>。
        </div>
      </aside>

      <main>
        <header>
          <div className="crumb">
            客服工作台<strong>Generative UI 协议层</strong>
          </div>
          <div className="status">
            <span className="dot" />
            协议 v1.0 · 4 个白名单组件
          </div>
        </header>

        <div className="page">
          <h1>对话即界面</h1>
          <p className="sub">
            模型的回答里嵌着真正能点的组件 —— 表格、表单、图表。它们不是模型画出来的，是模型选出来的。
          </p>
          <Chat />
        </div>
      </main>
    </div>
  );
}
