"use client";

import { FormEvent, useMemo, useState } from "react";

type CheckStatus = "ready" | "review" | "blocked";
type Filter = "all" | CheckStatus;

interface ReleaseCheck {
  id: string;
  title: string;
  detail: string;
  owner: string;
  area: string;
  due: string;
  priority: "P0" | "P1" | "P2";
  status: CheckStatus;
}

const initialChecks: ReleaseCheck[] = [
  { id: "contract", title: "接口契约已冻结", detail: "订单查询 v2 字段与错误码已经完成双端确认", owner: "梁知夏", area: "后端", due: "今天 16:00", priority: "P0", status: "ready" },
  { id: "checkout", title: "支付回归覆盖微信渠道", detail: "等待补充弱网重试场景的浏览器证据", owner: "周予安", area: "质量", due: "今天 18:30", priority: "P0", status: "review" },
  { id: "copy", title: "活动页文案终审", detail: "法务已经确认，待产品负责人完成最终勾选", owner: "陈一禾", area: "产品", due: "明天 10:00", priority: "P1", status: "review" },
  { id: "monitor", title: "核心漏斗监控就绪", detail: "告警接收群尚未绑定值班负责人", owner: "沈嘉木", area: "运维", due: "已逾期 2h", priority: "P0", status: "blocked" },
  { id: "rollback", title: "回滚包完成演练", detail: "rc2 镜像回退到稳定版耗时 3 分 18 秒", owner: "唐北辰", area: "运维", due: "昨天完成", priority: "P1", status: "ready" },
  { id: "support", title: "客服答疑手册发布", detail: "新优惠规则与退款路径已经同步一线团队", owner: "许清和", area: "运营", due: "今天 15:20", priority: "P2", status: "ready" },
];

const statusMeta: Record<CheckStatus, { label: string; short: string }> = {
  ready: { label: "已就绪", short: "就绪" },
  review: { label: "待复核", short: "复核" },
  blocked: { label: "有阻塞", short: "阻塞" },
};

export function ReleaseBoard() {
  const [checks, setChecks] = useState(initialChecks);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showComposer, setShowComposer] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const counts = useMemo(() => ({
    ready: checks.filter((item) => item.status === "ready").length,
    review: checks.filter((item) => item.status === "review").length,
    blocked: checks.filter((item) => item.status === "blocked").length,
  }), [checks]);
  const readiness = Math.round((counts.ready / checks.length) * 100);

  const visibleChecks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return checks.filter((item) => {
      const inFilter = filter === "all" || item.status === filter;
      const inQuery = !needle || [item.title, item.detail, item.owner, item.area]
        .some((value) => value.toLowerCase().includes(needle));
      return inFilter && inQuery;
    });
  }, [checks, filter, query]);

  function toggleReady(id: string) {
    setChecks((current) => current.map((item) => item.id === id
      ? { ...item, status: item.status === "ready" ? "review" : "ready" }
      : item));
  }

  function addCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setChecks((current) => [...current, {
      id: `check-${current.length + 1}`,
      title,
      detail: "新检查项，等待补充验收证据",
      owner: "待指派",
      area: "未分类",
      due: "未设置",
      priority: "P1",
      status: "review",
    }]);
    setNewTitle("");
    setShowComposer(false);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main-board" aria-label="返回发布验收室首页">
          <span className="brand-mark" aria-hidden="true">R</span>
          <span><strong>Release Room</strong><small>发布验收室</small></span>
        </a>
        <div className="topbar-actions">
          <span className="environment-badge"><i /> 非生产沙盒</span>
          <button className="avatar" type="button" aria-label="当前负责人：金海民">金</button>
        </div>
      </header>

      <section className="hero" aria-labelledby="release-title">
        <div className="hero-copy">
          <p className="eyebrow">RELEASE / 24.8.3-RC2</p>
          <h1 id="release-title">今晚，带着证据上线。</h1>
          <p>所有检查项都要有负责人、有结论、有回退路径。距离发布窗口还有 06:42:18。</p>
        </div>
        <div className="readiness-card" aria-label={`当前发布就绪度 ${readiness}%`}>
          <div className="readiness-label"><span>发布就绪度</span><strong>{readiness}%</strong></div>
          <div className="progress-track"><span style={{ width: `${readiness}%` }} /></div>
          <small>{counts.ready} / {checks.length} 项已具备验收证据</small>
        </div>
      </section>

      <section className="metrics" aria-label="发布状态摘要">
        <article className="metric metric-primary"><span className="metric-kicker">全部检查项</span><strong>{checks.length}</strong><small>覆盖 5 个协作领域</small></article>
        <article className="metric"><span className="metric-dot dot-ready" /><strong>{counts.ready}</strong><span>已就绪</span></article>
        <article className="metric"><span className="metric-dot dot-review" /><strong>{counts.review}</strong><span>待复核</span></article>
        <article className="metric metric-danger"><span className="metric-dot dot-blocked" /><strong>{counts.blocked}</strong><span>阻塞发布</span></article>
      </section>

      <div className="workspace" id="main-board">
        <section className="board-panel" aria-labelledby="board-heading">
          <div className="panel-heading">
            <div><p className="section-index">01 / READINESS</p><h2 id="board-heading">发布检查清单</h2></div>
            <button className="add-button" type="button" onClick={() => setShowComposer(true)}><span aria-hidden="true">＋</span> 新增检查项</button>
          </div>

          {showComposer && (
            <form className="composer" onSubmit={addCheck}>
              <label htmlFor="new-check">检查项名称</label>
              <div>
                <input id="new-check" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="例如：确认灰度名单" />
                <button type="submit">加入清单</button>
                <button type="button" className="ghost" onClick={() => setShowComposer(false)}>取消</button>
              </div>
            </form>
          )}

          <div className="toolbar">
            <div className="filters" aria-label="按状态筛选">
              {(["all", "ready", "review", "blocked"] as Filter[]).map((value) => (
                <button key={value} type="button" className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                  {value === "all" ? "全部" : statusMeta[value].short}<span>{value === "all" ? checks.length : counts[value]}</span>
                </button>
              ))}
            </div>
            <label className="search"><span aria-hidden="true">⌕</span><span className="sr-only">搜索检查项</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事项、负责人…" /></label>
          </div>

          <div className="check-list" aria-live="polite">
            {visibleChecks.map((item) => (
              <article className={`check-item status-${item.status}`} key={item.id}>
                <button className="status-toggle" type="button" aria-label={`${item.title}：${statusMeta[item.status].label}，点击切换就绪状态`} aria-pressed={item.status === "ready"} onClick={() => toggleReady(item.id)}>
                  {item.status === "ready" ? "✓" : item.status === "blocked" ? "!" : ""}
                </button>
                <div className="check-main">
                  <div className="check-title-line"><h3>{item.title}</h3><span className={`priority priority-${item.priority.toLowerCase()}`}>{item.priority}</span></div>
                  <p>{item.detail}</p>
                  <div className="check-meta"><span>{item.area}</span><span>负责人 · {item.owner}</span><span className={item.status === "blocked" ? "overdue" : ""}>{item.due}</span></div>
                </div>
                <span className={`status-label label-${item.status}`}>{statusMeta[item.status].label}</span>
              </article>
            ))}
            {visibleChecks.length === 0 && <div className="empty-state"><strong>没有匹配的检查项</strong><span>换个关键词，或查看其他状态。</span></div>}
          </div>
        </section>

        <aside className="side-panel" aria-label="发布决策信息">
          <section className="decision-card">
            <p className="section-index light">02 / DECISION</p>
            <h2>距离“可以发布”<br />还差一件事。</h2>
            <div className="blocker-callout"><span>唯一阻塞</span><strong>绑定漏斗告警值班人</strong><small>负责人 · 沈嘉木</small></div>
            <button type="button" onClick={() => setFilter("blocked")}>只看阻塞项 <span>→</span></button>
          </section>

          <section className="timeline-card">
            <div className="timeline-heading"><div><p className="section-index">03 / WINDOW</p><h2>今晚时间线</h2></div><span>8月30日</span></div>
            <ol className="timeline">
              <li className="done"><time>18:00</time><div><strong>代码冻结</strong><span>已完成 · rc2</span></div></li>
              <li className="current"><time>19:30</time><div><strong>发布评审</strong><span>正在准备证据</span></div></li>
              <li><time>22:00</time><div><strong>灰度 10%</strong><span>观察 30 分钟</span></div></li>
              <li><time>23:30</time><div><strong>全量决策</strong><span>Owner 单人确认</span></div></li>
            </ol>
          </section>
        </aside>
      </div>

      <footer><span>Release Room / 非生产协作试点</span><span>最后同步 · 刚刚</span></footer>
    </main>
  );
}
