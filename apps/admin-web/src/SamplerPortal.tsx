import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, type AuthUser, type InspectionConclusion, type InspectionTask } from "./api";

const taskStatus: Record<string, string> = {
  PENDING_ACCEPTANCE: "待接单", ACCEPTED: "已接单", IN_PROGRESS: "执行中",
  PENDING_REVIEW: "待审核", COMPLETED: "已完成",
};

type ResultDraft = Record<string, { conclusion: InspectionConclusion | ""; note: string }>;

export function SamplerPortal({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [tasks, setTasks] = useState<InspectionTask[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [sampleForm, setSampleForm] = useState({ orderItemId: "", palletCount: 1, boxesPerPallet: 10, itemsPerBox: 12, sampleCount: 3 });
  const [resultDraft, setResultDraft] = useState<ResultDraft>({});

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const nextTasks = await api.tasks();
      setTasks(nextTasks);
      setSelectedId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const selected = useMemo(() => tasks.find((task) => task.id === selectedId), [tasks, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setSampleForm((current) => ({ ...current, orderItemId: selected.physicalSample?.orderItemId ?? selected.order.items[0]?.id ?? "" }));
    const existing = new Map(selected.inspectionResults.map((result) => [result.sampleKey, result]));
    const nextDraft: ResultDraft = {};
    selected.physicalSample?.positions.forEach((position) => {
      const key = sampleKey(position.palletNo, position.boxNo, position.itemNo);
      const value = existing.get(key);
      nextDraft[key] = { conclusion: value?.conclusion ?? "", note: value?.note ?? "" };
    });
    setResultDraft(nextDraft);
  }, [selectedId, selected?.physicalSample?.createdAt, selected?.inspectionResults.length]);

  const pendingCount = tasks.filter((task) => task.status === "PENDING_ACCEPTANCE").length;
  const activeCount = tasks.filter((task) => ["ACCEPTED", "IN_PROGRESS"].includes(task.status)).length;
  const candidateTotal = sampleForm.palletCount * sampleForm.boxesPerPallet * sampleForm.itemsPerBox;
  const allResultsComplete = selected?.physicalSample?.positions.every((position) => resultDraft[sampleKey(position.palletNo, position.boxNo, position.itemNo)]?.conclusion) ?? false;

  async function runAction(action: () => Promise<unknown>, success: string) {
    setActionBusy(true);
    try { await action(); setMessage(success); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setActionBusy(false); }
  }

  async function photoCheckIn(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!selected || !file) return;
    if (!navigator.geolocation) {
      input.value = "";
      return setMessage("当前浏览器不支持定位，请改用微信小程序完成图片签到。");
    }
    setActionBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => void (async () => {
        try {
          await api.photoCheckIn(selected.id, file, {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            address: selected.order.siteAddress,
          });
          setMessage("图片签到成功，现场照片、定位和时间已经留存。");
          await load();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "图片签到失败");
        } finally {
          setActionBusy(false);
          input.value = "";
        }
      })(),
      () => { input.value = ""; setActionBusy(false); setMessage("未能获取定位，请允许本网站使用位置后重新拍照签到。"); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }

  async function drawPhysicalSample() {
    if (!selected || !window.confirm(`候选共 ${candidateTotal} 件。结果生成后不能重抽，确认包装数量无误？`)) return;
    await runAction(() => api.physicalSample(selected.id, sampleForm), "托盘—箱—件随机抽样完成，结果已经锁定。 ");
  }

  async function uploadEvidence(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!selected || !file) return;
    await runAction(() => api.uploadEvidence(selected.id, file), "现场照片上传成功。 ");
    event.target.value = "";
  }

  async function uploadSamplePhoto(event: ChangeEvent<HTMLInputElement>, samplePositionKey: string) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!selected || !file) return;
    if (!navigator.geolocation) { input.value = ""; return setMessage("当前浏览器不支持定位，无法生成位置水印。"); }
    setActionBusy(true);
    try {
      const position = await currentPosition();
      const capturedAt = new Date().toISOString();
      const resolved = await api.reverseGeocode(position.coords.latitude, position.coords.longitude, selected.order.siteAddress);
      const watermarkLines = [
        `任务 ${selected.taskNo} · 样品 ${samplePositionKey}`,
        resolved.address,
        `WGS84 ${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)} · 精度约 ${Math.round(position.coords.accuracy)} 米`,
        `拍摄时间 ${formatWatermarkTime(capturedAt)}`,
      ];
      const watermarkedFile = await watermarkPhoto(file, watermarkLines, samplePositionKey);
      await api.uploadSampleEvidence(selected.id, watermarkedFile, {
        sampleKey: samplePositionKey,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        address: resolved.address,
        coordinateSystem: resolved.coordinateSystem,
        mapProvider: resolved.provider,
        capturedAt,
        watermarkText: watermarkLines.join("\n"),
        watermarkVersion: "CLIENT_CANVAS_V1",
      });
      setMessage(`${samplePositionKey} 样品照片已加位置水印并保存。`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "样品照片处理失败");
    } finally {
      input.value = "";
      setActionBusy(false);
    }
  }

  async function saveResults() {
    if (!selected?.physicalSample) return;
    const results = Object.entries(resultDraft)
      .filter(([, value]) => value.conclusion)
      .map(([key, value]) => ({ sampleKey: key, conclusion: value.conclusion as InspectionConclusion, note: value.note }));
    if (results.length === 0) return setMessage("请至少填写一项检测结论。 ");
    await runAction(() => api.saveInspectionResults(selected.id, results), "检测结果已经保存。 ");
  }

  const latestReview = selected?.reviewRecords.at(-1);
  const checkInPhoto = selected?.evidenceFiles.find((file) => file.purpose === "CHECK_IN");
  const inspectionEvidence = selected?.evidenceFiles.filter((file) => file.purpose === "INSPECTION") ?? [];
  const sampleEvidence = selected?.evidenceFiles.filter((file) => file.purpose === "SAMPLE") ?? [];
  const samplePhotoCompleteCount = selected?.physicalSample?.positions.filter((position) => sampleEvidence.some((file) => file.sampleKey === sampleKey(position.palletNo, position.boxNo, position.itemNo))).length ?? 0;
  const allSamplePhotosComplete = Boolean(selected?.physicalSample) && samplePhotoCompleteCount === selected?.physicalSample?.positions.length;

  return (
    <div className="sampler-shell">
      <header className="sampler-header">
        <div className="sampler-brand"><span className="brand-mark">检</span><div><strong>抽检云台</strong><small>抽样员网页端</small></div></div>
        <div className="sampler-user"><span className="sampler-avatar">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><small>{user.department} · {user.employeeNo}</small></div><button onClick={onLogout}>退出</button></div>
      </header>

      <main className="sampler-main">
        <section className="sampler-welcome"><div><p className="eyebrow">FIELD WORKSPACE</p><h1>{user.name}，请按现场流程执行任务</h1><p>网页端与小程序共用任务、图片签到、三级抽样、证据和检测结果。</p></div><button className="sampler-refresh" onClick={() => void load()}>刷新任务</button></section>
        {message && <div className="notice" role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}
        <section className="sampler-metrics"><article><span>待接任务</span><strong>{pendingCount}</strong><small>需要确认</small></article><article><span>执行中</span><strong>{activeCount}</strong><small>继续现场操作</small></article><article><span>全部任务</span><strong>{tasks.length}</strong><small>当前账号可见</small></article></section>

        <section className="sampler-workspace">
          <aside className="task-list-panel">
            <div className="mobile-panel-title"><strong>我的任务</strong><span>{busy ? "加载中" : `${tasks.length}项`}</span></div>
            {!busy && tasks.length === 0 && <div className="sampler-empty">暂无分配给你的任务</div>}
            {tasks.map((task) => <button key={task.id} className={`task-list-item ${selectedId === task.id ? "selected" : ""}`} onClick={() => setSelectedId(task.id)}><span className="task-line"><strong>{task.taskNo}</strong><i>{taskStatus[task.status] ?? task.status}</i></span><b>{task.order.receivingUnit ?? task.order.customerName}</b><small>{task.order.supplierName ? `${task.order.supplierName} · ` : ""}{task.order.siteAddress}</small></button>)}
          </aside>

          <section className="task-detail-panel">
            {!selected && <div className="sampler-empty">请从左侧选择任务</div>}
            {selected && <>
              <div className="task-detail-head"><div><p className="eyebrow">{selected.taskNo} · {selected.order.orderNo}</p><h2>{selected.order.receivingUnit ?? selected.order.customerName}</h2><span className={`sampler-status ${selected.status.toLowerCase()}`}>{taskStatus[selected.status] ?? selected.status}</span></div><div className="plan-date"><span>计划检测</span><strong>{formatDate(selected.order.plannedAt)}</strong></div></div>
              <div className="task-facts"><div><span>质检类型</span><strong>{selected.order.inspectionType || selected.order.productCategory}</strong></div><div><span>供应商</span><strong>{selected.order.supplierName || "—"}</strong></div><div><span>物资明细</span><strong>{selected.order.items.length} 项 / {selected.order.items.reduce((sum, item) => sum + (item.sampleQuantity ?? item.quantity), 0)} 件</strong></div><div><span>联系人</span><strong>{selected.order.contactName || "—"} {selected.order.contactPhone || ""}</strong></div><div><span>收货地址</span><strong>{selected.order.siteAddress}</strong></div><div><span>模板状态 / 人员</span><strong>{selected.order.sourceStatus || "—"} / {selected.order.sourceSampler || "—"}</strong></div></div>

              <section className="source-plan-card"><div className="section-heading"><div><p className="eyebrow">SOURCE WEEKLY PLAN</p><h3>质检周计划物资明细</h3></div>{selected.order.importSource && <span>{selected.order.importSource}</span>}</div><div className="table-wrap"><table><thead><tr><th>订单行项ID</th><th>物资编码 / 名称</th><th>规格型号</th><th>计划样品</th><th>完成样品</th><th>抽样人员</th><th>检查状态</th><th>备注</th></tr></thead><tbody>{selected.order.items.map((item) => <tr key={item.id}><td>{item.orderLineId ?? item.batchNo}</td><td><strong>{item.productCode}</strong><small className="address">{item.productName}</small></td><td>{item.specification || "—"}</td><td>{item.sampleQuantity ?? item.quantity}</td><td>{item.completedSampleQuantity ?? 0}</td><td>{item.sourceSampler || "—"}</td><td>{item.sourceStatus || "—"}</td><td>{item.remark || "—"}</td></tr>)}</tbody></table></div></section>

              {latestReview?.decision === "RETURN" && <div className="return-notice"><strong>审核退回：{latestReview.comment}</strong><span>{latestReview.reviewerName} · {formatDate(latestReview.reviewedAt)}</span></div>}

              {selected.status === "PENDING_ACCEPTANCE" && <WorkflowCard step="01" title="确认接单" text="接单后才能进行现场图片签到和随机抽样。"><button disabled={actionBusy} className="primary-button" onClick={() => void runAction(() => api.acceptTask(selected.id), "接单成功，请拍摄现场照片完成签到。")}>确认接单</button></WorkflowCard>}

              {["ACCEPTED", "IN_PROGRESS"].includes(selected.status) && !checkInPhoto && <WorkflowCard step="02" title={selected.checkIn ? "补拍签到照片" : "现场图片签到"} text="使用手机现场拍照，系统会同时获取定位并保存照片、坐标、精度和签到时间。"><label className={`primary-button photo-checkin-button ${actionBusy ? "disabled" : ""}`}>{actionBusy ? "正在提交…" : selected.checkIn ? "补拍签到照片" : "拍照并签到"}<input disabled={actionBusy} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void photoCheckIn(event)} /></label></WorkflowCard>}
              {selected.checkIn && checkInPhoto && <div className="photo-checkin-strip"><EvidenceImage evidenceId={checkInPhoto.id} alt="现场签到照片" /><div><span>✓ 图片签到已完成</span><strong>{selected.checkIn.latitude.toFixed(5)}, {selected.checkIn.longitude.toFixed(5)}</strong><small>{checkInPhoto.fileName} · 精度约 {Math.round(selected.checkIn.accuracy)} 米 · {formatDate(selected.checkIn.checkedAt)}</small></div></div>}
              {selected.checkIn && !checkInPhoto && !["ACCEPTED", "IN_PROGRESS"].includes(selected.status) && <div className="completion-strip legacy"><span>历史定位签到</span><strong>{selected.checkIn.latitude.toFixed(5)}, {selected.checkIn.longitude.toFixed(5)}</strong><small>该历史任务未采集签到照片 · {formatDate(selected.checkIn.checkedAt)}</small></div>}

              {selected.checkIn && !selected.physicalSample && ["ACCEPTED", "IN_PROGRESS"].includes(selected.status) && <section className="physical-sample-card">
                <div className="section-heading"><div><p className="eyebrow">HIERARCHICAL RANDOM SAMPLING</p><h3>托盘—箱—件三级随机抽样</h3></div><span>候选 {candidateTotal.toLocaleString()} 件</span></div>
                <p className="section-note">选择产品批次并输入现场包装结构。单托盘货物的托盘数填写1。</p>
                <div className="sample-grid">
                  <label className="wide">物资与订单行项<select value={sampleForm.orderItemId} onChange={(event) => setSampleForm({ ...sampleForm, orderItemId: event.target.value })}>{selected.order.items.map((item) => <option key={item.id} value={item.id}>{item.productCode} · {item.productName} · 行项{item.orderLineId ?? item.batchNo} · 计划{item.sampleQuantity ?? item.quantity}件</option>)}</select></label>
                  <NumberField label="托盘数" value={sampleForm.palletCount} onChange={(value) => setSampleForm({ ...sampleForm, palletCount: value })} />
                  <NumberField label="每托盘箱数" value={sampleForm.boxesPerPallet} onChange={(value) => setSampleForm({ ...sampleForm, boxesPerPallet: value })} />
                  <NumberField label="每箱件数" value={sampleForm.itemsPerBox} onChange={(value) => setSampleForm({ ...sampleForm, itemsPerBox: value })} />
                  <NumberField label="抽取件数" value={sampleForm.sampleCount} onChange={(value) => setSampleForm({ ...sampleForm, sampleCount: value })} />
                </div>
                <button disabled={actionBusy || candidateTotal < sampleForm.sampleCount} className="primary-button" onClick={() => void drawPhysicalSample()}>生成随机位置</button>
              </section>}

              {selected.physicalSample && <section className="physical-result">
                <div className="result-heading"><div><p className="eyebrow">LOCKED SAMPLE RESULT</p><h3>{selected.physicalSample.productName} · {selected.physicalSample.batchNo}</h3></div><span>规则 {selected.physicalSample.ruleVersion}</span></div>
                <p className="result-summary">{selected.physicalSample.palletCount}托 × {selected.physicalSample.boxesPerPallet}箱 × {selected.physicalSample.itemsPerBox}件，共{selected.physicalSample.candidateTotal}件，随机抽取{selected.physicalSample.sampleCount}件。</p>
                <div className="position-grid">{selected.physicalSample.positions.map((position) => <article key={position.sequence}><i>{String(position.sequence).padStart(2, "0")}</i><strong>第 {position.palletNo} 托盘</strong><span>第 {position.boxNo} 箱 · 第 {position.itemNo} 件</span></article>)}</div>
              </section>}

              {selected.physicalSample && ["IN_PROGRESS", "ACCEPTED"].includes(selected.status) && <section className="field-records">
                <div className="section-heading"><div><p className="eyebrow">FIELD RECORDS</p><h3>逐样品照片与检测结论</h3><p className="section-note">每个随机位置至少拍摄1张照片；系统将位置、坐标、地址和时间写入图片水印。已完成 {samplePhotoCompleteCount}/{selected.physicalSample.positions.length}。</p></div><label className="upload-button">补充现场全景<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadEvidence(event)} /></label></div>
                {inspectionEvidence.length > 0 && <div className="evidence-list">{inspectionEvidence.map((file) => <article key={file.id}><strong>{file.fileName}</strong><small>补充现场照片 · {formatSize(file.size)} · SHA256 {file.sha256.slice(0, 12)}…</small></article>)}</div>}
                <div className="result-form">{selected.physicalSample.positions.map((position) => {
                  const key = sampleKey(position.palletNo, position.boxNo, position.itemNo); const draft = resultDraft[key] ?? { conclusion: "", note: "" }; const photos = sampleEvidence.filter((file) => file.sampleKey === key);
                  return <article key={key}><div><strong>第{position.palletNo}托盘 / 第{position.boxNo}箱 / 第{position.itemNo}件</strong><small>{key}</small></div><select aria-label={`${key}检测结论`} value={draft.conclusion} onChange={(event) => setResultDraft({ ...resultDraft, [key]: { ...draft, conclusion: event.target.value as InspectionConclusion } })}><option value="">选择结论</option><option value="PASS">合格</option><option value="FAIL">不合格</option><option value="NA">不适用</option></select><input aria-label={`${key}备注`} value={draft.note} onChange={(event) => setResultDraft({ ...resultDraft, [key]: { ...draft, note: event.target.value } })} placeholder="备注（可选）" /><div className="sample-photo-record"><div className="sample-photo-thumbs">{photos.map((photo) => <EvidenceImage key={photo.id} evidenceId={photo.id} alt={`${key}样品照片`} />)}</div><label className={`sample-photo-button ${actionBusy || photos.length >= 5 ? "disabled" : ""}`}>{photos.length ? `继续拍照 ${photos.length}/5` : "拍照留证"}<input aria-label={`${key}样品照片`} disabled={actionBusy || photos.length >= 5} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void uploadSamplePhoto(event, key)} /></label>{photos[0]?.address && <small>{photos[0].address} · {photos[0].mapProvider}</small>}</div></article>})}</div>
                <div className="record-actions"><button className="ghost-button" disabled={actionBusy} onClick={() => void saveResults()}>保存检测结果</button><button className="primary-button" disabled={actionBusy || !allResultsComplete || !allSamplePhotosComplete || !checkInPhoto} onClick={() => void runAction(() => api.submitReview(selected.id), "任务已提交管理员审核。")}>提交审核</button></div>
              </section>}

              {selected.status === "PENDING_REVIEW" && <div className="waiting-review"><strong>任务已提交审核</strong><p>检测结果、三级抽样位置、图片签到和检测照片均已锁定，等待管理员处理。</p></div>}
              {selected.status === "COMPLETED" && <div className="waiting-review completed"><strong>任务审核完成</strong><p>所有记录已归档，可以在历史任务中继续查看。</p></div>}
            </>}
          </section>
        </section>
      </main>
    </div>
  );
}

export function EvidenceImage({ evidenceId, alt }: { evidenceId: string; alt: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let objectUrl = "";
    let active = true;
    void api.evidenceBlob(evidenceId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(() => setSource(""));
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [evidenceId]);
  return source ? <img src={source} alt={alt} /> : <div className="photo-placeholder" aria-label={`${alt}加载中`}>图片</div>;
}

function WorkflowCard({ step, title, text, children }: { step: string; title: string; text: string; children: React.ReactNode }) {
  return <div className="task-action-card"><i className="workflow-step">{step}</i><div><strong>{title}</strong><p>{text}</p></div>{children}</div>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" min="1" value={value} onChange={(event) => onChange(Math.max(1, Number(event.target.value)))} /></label>;
}

function sampleKey(palletNo: number, boxNo: number, itemNo: number) { return `P${palletNo}-B${boxNo}-I${itemNo}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatSize(size: number) { return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function formatWatermarkTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, () => reject(new Error("未能获取定位，请允许本网站使用位置后重新拍照。")), { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }));
}

async function watermarkPhoto(file: File, lines: string[], samplePositionKey: string): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); throw new Error("浏览器无法生成图片水印"); }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const fontSize = Math.max(18, Math.round(width / 48));
  const lineHeight = Math.round(fontSize * 1.5);
  const padding = Math.max(16, Math.round(fontSize * .8));
  const panelHeight = lineHeight * lines.length + padding * 2;
  const panelTop = Math.max(0, height - panelHeight);
  const gradient = context.createLinearGradient(0, panelTop, 0, height);
  gradient.addColorStop(0, "rgba(0, 28, 31, .54)"); gradient.addColorStop(1, "rgba(0, 28, 31, .88)");
  context.fillStyle = gradient; context.fillRect(0, panelTop, width, panelHeight);
  context.fillStyle = "#ffffff"; context.font = `600 ${fontSize}px sans-serif`; context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(line, padding, panelTop + padding + index * lineHeight, width - padding * 2));
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片水印生成失败")), "image/jpeg", .9));
  return new File([blob], `${samplePositionKey}-${Date.now()}-watermarked.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}
