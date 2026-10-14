import { useState, type FormEvent } from "react";
import type { InspectionOrder, SamplerUser } from "./api";

export function DispatchDialog({ order, samplers, onConfirm, onClose }: {
  order: InspectionOrder;
  samplers: SamplerUser[];
  onConfirm: (candidateIds?: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"ALL" | "SELECTED">("SELECTED");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reason = (person: SamplerUser) => {
    if (person.status === "ON_LEAVE") return "休假中";
    if (person.status !== "ACTIVE") return "已停用";
    if (!person.qualifications.includes(order.productCategory)) return "资质不符";
    if (person.activeTaskCount >= 5) return "任务已满（上限5个）";
    return "";
  };
  const eligible = samplers.filter((person) => !reason(person));
  const selected = eligible.filter((person) => selectedIds.includes(person.id));
  const count = mode === "ALL" ? eligible.length : selected.length;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || count === 0) return;
    setBusy(true);
    setError("");
    try { await onConfirm(mode === "ALL" ? undefined : selected.map((person) => person.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "派发失败，请重试"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="modal dispatch-modal" role="dialog" aria-modal="true" aria-labelledby="dispatch-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-heading"><div><h2 id="dispatch-title">选择人员派发</h2><p>{order.orderNo} · {order.customerName}</p></div><button disabled={busy} onClick={onClose} aria-label="关闭派单窗口">×</button></div>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="dispatch-options">
          <legend>派单范围 · {order.productCategory}</legend>
          <label><input type="radio" name="dispatch-mode" checked={mode === "SELECTED"} onChange={() => setMode("SELECTED")} />选择候选人员</label>
          <label><input type="radio" name="dispatch-mode" checked={mode === "ALL"} onChange={() => setMode("ALL")} />全部符合条件人员随机</label>
        </fieldset>
        <p className="modal-description">选1人：指定派给该人员。选多人：只从所选人员中按工作量权重随机派给1人。休假、停用、资质不符或任务已满的人员不可选。</p>
        <div className="dispatch-candidates" aria-label="抽检员候选名单">
          {samplers.map((person) => {
            const unavailable = reason(person);
            return <label key={person.id} className={`dispatch-person ${unavailable ? "unavailable" : ""}`}>
              <input type="checkbox" aria-label={`选择${person.name}（${person.employeeNo}）`} disabled={busy || mode === "ALL" || !!unavailable}
                checked={mode === "ALL" ? !unavailable : selectedIds.includes(person.id)}
                onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, person.id] : ids.filter((id) => id !== person.id))} />
              <span><strong>{person.name}（{person.employeeNo}）</strong><small>{person.department} · 未完成任务 {person.activeTaskCount}/5 · {person.qualifications.join("、") || "暂无资质"}</small></span>
              <small>{unavailable || "可派发"}</small>
            </label>;
          })}
          {!eligible.length && <p role="status">暂无符合条件人员，请先调整人员状态、资质或处理未完成任务。</p>}
        </div>
        <div className="status-change-box" aria-live="polite">
          {mode === "SELECTED" ? (count === 1 ? `将指定派给：${selected[0]!.name}（${selected[0]!.employeeNo}）` : `已选 ${count} 人${count ? `：${selected.map((person) => person.name).join("、")}；将随机派给其中1人` : "，请至少选择1人"}`) : `将从全部 ${count} 名符合条件人员中随机派给1人`}
        </div>
        {error && <p className="warning-box" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="ghost-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !count}>{busy ? "正在派发…" : mode === "SELECTED" && count === 1 ? "确认指定派发" : "确认随机派发"}</button></div>
      </form>
    </section>
  </div>;
}
