import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from "react";
import { api, type AuthUser, type Dashboard, type InspectionOrder, type InspectionTask, type SamplerUser } from "./api";
import { LoginPage } from "./LoginPage";
import { EvidenceImage, SamplerPortal } from "./SamplerPortal";

const statusLabel: Record<string, string> = {
  DRAFT: "草稿",
  PENDING_DISPATCH: "待派发",
  DISPATCHED: "已派发",
  IN_PROGRESS: "执行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

const initialForm = {
  orderNo: "",
  customerName: "",
  siteAddress: "",
  productCategory: "电气设备",
  plannedAt: "",
  productCode: "",
  productName: "",
  batchNo: "",
  quantity: 1,
  inspectionType: "集团检测",
  supplierName: "",
  contactName: "",
  contactPhone: "",
  orderLineId: "",
  specification: "-",
  sampleQuantity: 1,
  sourceSampler: "",
  sourceStatus: "待抽样",
  sourceRemarks: "",
};

const initialSamplerForm = {
  employeeNo: "",
  name: "",
  mobile: "",
  department: "检测组",
  qualifications: ["电气设备", "通用产品"],
  initialPassword: "Sampler@123",
};

function AdminPortal({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [orders, setOrders] = useState<InspectionOrder[]>([]);
  const [reviewTasks, setReviewTasks] = useState<InspectionTask[]>([]);
  const [samplers, setSamplers] = useState<SamplerUser[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showSamplerForm, setShowSamplerForm] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<SamplerUser>();
  const [passwordInput, setPasswordInput] = useState("Sampler@123");
  const [deleteTarget, setDeleteTarget] = useState<SamplerUser>();
  const [statusTarget, setStatusTarget] = useState<SamplerUser>();
  const [deleteOrderTarget, setDeleteOrderTarget] = useState<InspectionOrder>();
  const [selectedOrder, setSelectedOrder] = useState<InspectionOrder>();
  const [importBusy, setImportBusy] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [samplerForm, setSamplerForm] = useState(initialSamplerForm);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [nextDashboard, nextOrders, nextTasks, nextUsers] = await Promise.all([api.dashboard(), api.orders(), api.tasks(), api.users()]);
      setDashboard(nextDashboard);
      setOrders(nextOrders);
      setReviewTasks(nextTasks.filter((task) => task.status === "PENDING_REVIEW"));
      setSamplers(nextUsers.filter((nextUser) => nextUser.role === "SAMPLER"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function dispatch(order: InspectionOrder) {
    if (!window.confirm(`确认按规则随机派发检测单 ${order.orderNo}？`)) return;
    try {
      await api.dispatch(order.id);
      setMessage("随机派发成功，系统已保存候选范围和随机结果。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "派发失败");
    }
  }

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    try {
      await api.createOrder({
        orderNo: form.orderNo,
        customerName: form.customerName,
        siteAddress: form.siteAddress,
        productCategory: form.productCategory,
        plannedAt: new Date(form.plannedAt).toISOString(),
        inspectionType: form.inspectionType,
        receivingUnit: form.customerName,
        supplierName: form.supplierName,
        contactName: form.contactName,
        contactPhone: form.contactPhone,
        sourceStatus: form.sourceStatus,
        sourceSampler: form.sourceSampler,
        sourceRemarks: form.sourceRemarks,
        items: [{
          productCode: form.productCode,
          productName: form.productName,
          batchNo: form.orderLineId || form.batchNo,
          quantity: Number(form.sampleQuantity),
          orderLineId: form.orderLineId,
          specification: form.specification,
          sampleQuantity: Number(form.sampleQuantity),
          completedSampleQuantity: 0,
          sourceSampler: form.sourceSampler,
          sourceStatus: form.sourceStatus,
          remark: form.sourceRemarks,
        }],
      });
      setForm(initialForm);
      setShowForm(false);
      setMessage("检测单已创建，当前处于待派发状态。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建失败");
    }
  }

  async function importWeeklyPlan(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportBusy(true);
    try {
      const result = await api.importOrders(file);
      const skipped = result.skippedCount ? `，跳过已存在订单${result.skippedCount}张` : "";
      setMessage(`导入完成：读取${result.sheetCount}个工作表、${result.rowCount}行，创建${result.createdCount}张检测单和${result.itemCount}项物资${skipped}。`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Excel导入失败");
    } finally {
      setImportBusy(false);
      event.target.value = "";
    }
  }

  async function reviewTask(task: InspectionTask, decision: "APPROVE" | "RETURN") {
    const comment = window.prompt(decision === "APPROVE" ? "请输入审核通过意见" : "请输入退回原因", decision === "APPROVE" ? "资料完整，同意通过" : "请补充现场证据");
    if (!comment) return;
    try {
      await api.reviewTask(task.id, decision, comment);
      setMessage(decision === "APPROVE" ? "任务审核通过并已归档。" : "任务已退回抽样员修改。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "审核失败");
    }
  }

  async function createSampler(event: FormEvent) {
    event.preventDefault();
    try {
      await api.createSampler(samplerForm);
      setSamplerForm(initialSamplerForm);
      setShowSamplerForm(false);
      setMessage("抽检员账号已创建，可以使用工号和初始化密码登录。管理员看不到密码明文。");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建抽检员失败");
    }
  }

  async function resetSamplerPassword(event: FormEvent) {
    event.preventDefault();
    if (!passwordTarget) return;
    try {
      const result = await api.resetSamplerPassword(passwordTarget.id, passwordInput);
      setMessage(result.message);
      setPasswordTarget(undefined);
      setPasswordInput("Sampler@123");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "密码初始化失败");
    }
  }

  async function deleteSampler() {
    if (!deleteTarget) return;
    try {
      const result = await api.deleteSampler(deleteTarget.id);
      setMessage(result.message);
      setDeleteTarget(undefined);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除抽检员失败");
      setDeleteTarget(undefined);
    }
  }

  async function changeSamplerStatus() {
    if (!statusTarget) return;
    const status = statusTarget.status === "ON_LEAVE" ? "ACTIVE" : "ON_LEAVE";
    try {
      const result = await api.updateSamplerStatus(statusTarget.id, status);
      setMessage(result.message);
      setStatusTarget(undefined);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "修改抽检员状态失败");
      setStatusTarget(undefined);
    }
  }

  async function deleteOrder() {
    if (!deleteOrderTarget) return;
    try {
      const result = await api.deleteOrder(deleteOrderTarget.id);
      setMessage(result.message);
      setDeleteOrderTarget(undefined);
      setSelectedOrder(undefined);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除检测单失败");
      setDeleteOrderTarget(undefined);
    }
  }

  function toggleQualification(qualification: string) {
    const selected = samplerForm.qualifications.includes(qualification);
    setSamplerForm({
      ...samplerForm,
      qualifications: selected
        ? samplerForm.qualifications.filter((item) => item !== qualification)
        : [...samplerForm.qualifications, qualification],
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">检</span><div><strong>抽检云台</strong><small>INSPECTION OPS</small></div></div>
        <nav aria-label="管理中心导航">
          <button className="nav-item active" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><span>⌂</span>工作台</button>
          <button className="nav-item" onClick={() => document.getElementById("orders-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>▤</span>检测单据</button>
          <button className="nav-item" onClick={() => document.getElementById("orders-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>⇄</span>任务派发</button>
          <button className="nav-item" onClick={() => document.getElementById("review-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>◎</span>审核中心</button>
          <button className="nav-item" onClick={() => document.getElementById("personnel-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}><span>♙</span>人员资质</button>
          <button className="nav-item"><span>◫</span>报告归档</button>
          <button className="nav-item"><span>⚙</span>系统设置</button>
        </nav>
        <div className="sidebar-note"><span className="live-dot" />本机开发环境<small>数据仅用于测试</small></div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div><p className="eyebrow">质量管理中心</p><h1>检测任务工作台</h1></div>
          <div className="operator"><span className="avatar">管</span><div><strong>{user.name}</strong><small>{user.department}</small></div><button className="logout-link" onClick={onLogout}>退出</button></div>
        </header>

        <section className="hero-panel">
          <div><span className="hero-tag">今日调度</span><h2>让每一次抽样都有据可查</h2><p>从候选人员过滤、随机派发到产品抽取，系统完整记录规则版本与操作轨迹。</p></div>
          <div className="hero-actions"><label className={`import-button ${importBusy ? "disabled" : ""}`}>{importBusy ? "正在导入…" : "⇧ 导入周计划"}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={importBusy} onChange={(event) => void importWeeklyPlan(event)} /></label><button className="primary-button" onClick={() => setShowForm(true)}>＋ 新建检测单</button></div>
        </section>

        {message && <div className="notice" role="status">{message}<button onClick={() => setMessage("")} aria-label="关闭提示">×</button></div>}

        <section className="metrics" aria-label="任务指标">
          {[
            ["待派发", dashboard?.pendingDispatch ?? "—", "需要管理员处理", "amber"],
            ["执行中", dashboard?.inProgress ?? "—", "现场人员处理中", "blue"],
            ["待审核", dashboard?.pendingReview ?? "—", "等待质量复核", "purple"],
            ["今日完成", dashboard?.completedToday ?? "—", `在线抽样员 ${dashboard?.activeSamplers ?? "—"} 人`, "green"],
          ].map(([label, value, hint, tone]) => <article className={`metric ${tone}`} key={label}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}
        </section>

        <section className="table-panel anchor-panel" id="orders-panel">
          <div className="panel-heading"><div><h2>近期检测单</h2><p>优先处理待派发和临近计划时间的任务</p></div><button className="text-button" onClick={() => void load()}>刷新数据</button></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>采购订单号</th><th>质检类型</th><th>收货单位 / 供应商</th><th>联系人 / 收货地址</th><th>计划日期</th><th>抽样样品数</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {!busy && orders.length === 0 && <tr><td colSpan={8} className="empty">暂无检测单</td></tr>}
                {orders.map((order) => <tr key={order.id}>
                  <td><strong className="order-no">{order.orderNo}</strong></td>
                  <td>{order.inspectionType ?? order.productCategory}</td>
                  <td><strong>{order.receivingUnit ?? order.customerName}</strong><small className="address">{order.supplierName ?? "—"}</small></td>
                  <td><strong>{order.contactName || "—"} {order.contactPhone || ""}</strong><small className="address">{order.siteAddress}</small></td>
                  <td>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(order.plannedAt))}</td>
                  <td>{order.items.reduce((sum, item) => sum + (item.sampleQuantity ?? item.quantity), 0)}件 / {order.items.length}项</td>
                  <td><span className={`status status-${order.status.toLowerCase()}`}>{statusLabel[order.status] ?? order.status}</span></td>
                  <td><div className="row-actions"><button className="ghost-button" onClick={() => setSelectedOrder(order)}>查看</button>{order.status === "PENDING_DISPATCH" && <><button className="action-button" onClick={() => void dispatch(order)}>随机派发</button><button className="danger-button" onClick={() => setDeleteOrderTarget(order)}>删除</button></>}</div></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>

        <section className="table-panel personnel-panel anchor-panel" id="personnel-panel">
          <div className="panel-heading"><div><h2>抽检员账号管理</h2><p>新增人员、初始化密码；删除操作将停用账号并保留历史任务</p></div><button className="primary-button compact-button" onClick={() => setShowSamplerForm(true)}>＋ 新增抽检员</button></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>工号 / 姓名</th><th>部门</th><th>联系方式</th><th>检测资质</th><th>未完任务</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {samplers.length === 0 && <tr><td colSpan={7} className="empty">暂无抽检员账号</td></tr>}
                {samplers.map((sampler) => <tr key={sampler.id}>
                  <td><strong>{sampler.employeeNo}</strong><small className="address">{sampler.name}</small></td>
                  <td>{sampler.department}</td>
                  <td>{sampler.mobile}</td>
                  <td><div className="qualification-list">{sampler.qualifications.map((item) => <span key={item}>{item}</span>)}</div></td>
                  <td>{sampler.activeTaskCount}</td>
                  <td><span className={`status user-status-${sampler.status.toLowerCase()}`}>{sampler.status === "ACTIVE" ? "启用" : sampler.status === "ON_LEAVE" ? "休假" : "已停用"}</span></td>
                  <td><div className="row-actions"><button className="ghost-button" disabled={sampler.status === "INACTIVE"} onClick={() => setStatusTarget(sampler)}>{sampler.status === "ON_LEAVE" ? "恢复启用" : "设为休假"}</button><button className="ghost-button" disabled={sampler.status === "INACTIVE"} onClick={() => { setPasswordInput("Sampler@123"); setPasswordTarget(sampler); }}>初始化密码</button><button className="danger-button" disabled={sampler.status === "INACTIVE"} onClick={() => setDeleteTarget(sampler)}>删除账号</button></div></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>

        <section className="table-panel review-panel anchor-panel" id="review-panel">
          <div className="panel-heading"><div><h2>审核中心</h2><p>核对三级抽样位置、图片签到、检测结论和证据文件</p></div><span className="review-count">待审核 {reviewTasks.length}</span></div>
          {reviewTasks.length === 0 ? <div className="review-empty">暂无待审核任务</div> : reviewTasks.map((task) => <article className="review-item" key={task.id}>
            <div><strong>{task.taskNo} · {task.order.customerName}</strong><small>{task.assigneeName} · {task.order.siteAddress}</small>{task.evidenceFiles.filter((file) => file.purpose === "CHECK_IN").slice(0, 1).map((file) => <div className="review-checkin-photo" key={file.id}><EvidenceImage evidenceId={file.id} alt={`${task.taskNo}签到照片`} /><span>签到照片</span></div>)}</div>
            <div><div className="review-facts"><span>抽样位置 <b>{task.physicalSample?.sampleCount ?? 0}</b></span><span>检测结论 <b>{task.inspectionResults.length}</b></span><span>样品照片 <b>{task.evidenceFiles.filter((file) => file.purpose === "SAMPLE").length}</b></span><span>图片签到 <b>{task.evidenceFiles.some((file) => file.purpose === "CHECK_IN") ? "已完成" : "缺失"}</b></span></div><div className="review-sample-gallery">{task.evidenceFiles.filter((file) => file.purpose === "SAMPLE").map((file) => <figure key={file.id}><EvidenceImage evidenceId={file.id} alt={`${file.sampleKey}样品照片`} /><figcaption>{file.sampleKey}<small>{file.address || "现场地址"}</small></figcaption></figure>)}</div></div>
            <div className="review-actions"><button className="ghost-button" onClick={() => void reviewTask(task, "RETURN")}>退回修改</button><button className="action-button" onClick={() => void reviewTask(task, "APPROVE")}>审核通过</button></div>
          </article>)}
        </section>
      </main>

      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowForm(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">NEW ORDER</p><h2 id="create-title">新建检测单</h2></div><button onClick={() => setShowForm(false)} aria-label="关闭">×</button></div>
          <form onSubmit={(event) => void createOrder(event)}>
            <div className="form-grid">
              <label>检测单号<input required value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} placeholder="JC-20260814-002" /></label>
              <label>计划检测时间<input required type="datetime-local" value={form.plannedAt} onChange={(e) => setForm({ ...form, plannedAt: e.target.value })} /></label>
              <label>质检类型<select value={form.inspectionType} onChange={(e) => setForm({ ...form, inspectionType: e.target.value })}><option>集团检测</option><option>省采检测</option><option>其他检测</option></select></label>
              <label>调度产品类别<select value={form.productCategory} onChange={(e) => setForm({ ...form, productCategory: e.target.value })}><option>电气设备</option><option>通用产品</option></select></label>
              <label className="full">收货单位<input required value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></label>
              <label className="full">供应商名称<input required value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} /></label>
              <label>联系人<input required value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></label>
              <label>收货人电话<input required value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></label>
              <label className="full">收货地址<input required value={form.siteAddress} onChange={(e) => setForm({ ...form, siteAddress: e.target.value })} /></label>
              <label>物资编码<input required value={form.productCode} onChange={(e) => setForm({ ...form, productCode: e.target.value })} /></label>
              <label>订单行项ID<input required value={form.orderLineId} onChange={(e) => setForm({ ...form, orderLineId: e.target.value })} /></label>
              <label className="full">物资名称<input required value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} /></label>
              <label className="full">规格型号<input required value={form.specification} onChange={(e) => setForm({ ...form, specification: e.target.value })} /></label>
              <label>抽样样品数<input required min="1" type="number" value={form.sampleQuantity} onChange={(e) => setForm({ ...form, sampleQuantity: Number(e.target.value) })} /></label>
              <label>检查状态<input value={form.sourceStatus} onChange={(e) => setForm({ ...form, sourceStatus: e.target.value })} /></label>
              <label>模板抽样人员<input value={form.sourceSampler} onChange={(e) => setForm({ ...form, sourceSampler: e.target.value })} /></label>
              <label className="full">备注<input value={form.sourceRemarks} onChange={(e) => setForm({ ...form, sourceRemarks: e.target.value })} /></label>
            </div>
            <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setShowForm(false)}>取消</button><button type="submit" className="primary-button">保存检测单</button></div>
          </form>
        </section>
      </div>}

      {selectedOrder && <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedOrder(undefined)}>
        <section className="modal order-detail-modal" role="dialog" aria-modal="true" aria-labelledby="order-detail-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">WEEKLY INSPECTION PLAN</p><h2 id="order-detail-title">{selectedOrder.orderNo}</h2></div><button onClick={() => setSelectedOrder(undefined)} aria-label="关闭">×</button></div>
          <div className="source-detail-grid">
            <div><span>质检类型</span><strong>{selectedOrder.inspectionType || "—"}</strong></div><div><span>计划抽检日期</span><strong>{new Date(selectedOrder.plannedAt).toLocaleString("zh-CN")}</strong></div>
            <div className="wide"><span>收货单位</span><strong>{selectedOrder.receivingUnit ?? selectedOrder.customerName}</strong></div><div className="wide"><span>供应商名称</span><strong>{selectedOrder.supplierName || "—"}</strong></div>
            <div><span>联系人</span><strong>{selectedOrder.contactName || "—"}</strong></div><div><span>收货人电话</span><strong>{selectedOrder.contactPhone || "—"}</strong></div>
            <div className="wide"><span>收货地址</span><strong>{selectedOrder.siteAddress}</strong></div><div><span>检查状态</span><strong>{selectedOrder.sourceStatus || "—"}</strong></div>
            <div><span>抽样人员</span><strong>{selectedOrder.sourceSampler || "—"}</strong></div><div className="wide"><span>备注</span><strong>{selectedOrder.sourceRemarks || "—"}</strong></div>
            {selectedOrder.importSource && <div className="wide"><span>导入来源</span><strong>{selectedOrder.importSource}</strong></div>}
          </div>
          <div className="source-items"><h3>物资与抽样明细</h3><div className="table-wrap"><table><thead><tr><th>订单行项ID</th><th>物资编码 / 名称</th><th>规格型号</th><th>抽样样品数</th><th>完成样品数</th><th>抽样人员</th><th>检查状态</th><th>备注</th></tr></thead><tbody>{selectedOrder.items.map((item) => <tr key={item.id}><td>{item.orderLineId ?? item.batchNo}</td><td><strong>{item.productCode}</strong><small className="address">{item.productName}</small></td><td>{item.specification || "—"}</td><td>{item.sampleQuantity ?? item.quantity}</td><td>{item.completedSampleQuantity ?? 0}</td><td>{item.sourceSampler || "—"}</td><td>{item.sourceStatus || "—"}</td><td>{item.remark || "—"}</td></tr>)}</tbody></table></div></div>
        </section>
      </div>}

      {deleteOrderTarget && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteOrderTarget(undefined)}>
        <section className="modal account-action-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-order-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow danger-eyebrow">ORDER DELETION</p><h2 id="delete-order-title">确认删除检测单</h2></div><button onClick={() => setDeleteOrderTarget(undefined)} aria-label="关闭">×</button></div>
          <p className="modal-description">即将永久删除尚未派发的检测单 <strong>{deleteOrderTarget.orderNo}</strong> 及其 {deleteOrderTarget.items.length} 项物资明细。</p>
          <div className="warning-box">删除后列表中将不再显示该检测单。已经派发或产生抽样记录的检测单不允许删除。</div>
          <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setDeleteOrderTarget(undefined)}>取消</button><button type="button" className="danger-confirm-button" onClick={() => void deleteOrder()}>确认删除检测单</button></div>
        </section>
      </div>}

      {showSamplerForm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowSamplerForm(false)}>
        <section className="modal sampler-modal" role="dialog" aria-modal="true" aria-labelledby="sampler-create-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">ACCOUNT MANAGEMENT</p><h2 id="sampler-create-title">新增抽检员账号</h2></div><button onClick={() => setShowSamplerForm(false)} aria-label="关闭">×</button></div>
          <form onSubmit={(event) => void createSampler(event)}>
            <div className="form-grid">
              <label>登录工号<input required pattern="[A-Za-z0-9_-]+" value={samplerForm.employeeNo} onChange={(e) => setSamplerForm({ ...samplerForm, employeeNo: e.target.value.toUpperCase() })} placeholder="S004" /></label>
              <label>姓名<input required value={samplerForm.name} onChange={(e) => setSamplerForm({ ...samplerForm, name: e.target.value })} /></label>
              <label>手机号码<input required value={samplerForm.mobile} onChange={(e) => setSamplerForm({ ...samplerForm, mobile: e.target.value })} /></label>
              <label>所属部门<input required value={samplerForm.department} onChange={(e) => setSamplerForm({ ...samplerForm, department: e.target.value })} /></label>
              <fieldset className="full qualification-field"><legend>检测资质（至少选择一项）</legend><div>{["电气设备", "通用产品"].map((qualification) => <label key={qualification}><input type="checkbox" checked={samplerForm.qualifications.includes(qualification)} onChange={() => toggleQualification(qualification)} />{qualification}</label>)}</div></fieldset>
              <label className="full">初始化密码<input required type="password" minLength={8} value={samplerForm.initialPassword} onChange={(e) => setSamplerForm({ ...samplerForm, initialPassword: e.target.value })} /><small className="field-help">至少8位，同时包含英文字母和数字。密码只在创建时设置，不会在后台显示。</small></label>
            </div>
            <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setShowSamplerForm(false)}>取消</button><button type="submit" className="primary-button" disabled={samplerForm.qualifications.length === 0}>创建账号</button></div>
          </form>
        </section>
      </div>}

      {passwordTarget && <div className="modal-backdrop" role="presentation" onMouseDown={() => setPasswordTarget(undefined)}>
        <section className="modal account-action-modal" role="dialog" aria-modal="true" aria-labelledby="password-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">PASSWORD INITIALIZATION</p><h2 id="password-title">初始化抽检员密码</h2></div><button onClick={() => setPasswordTarget(undefined)} aria-label="关闭">×</button></div>
          <p className="modal-description">账号：<strong>{passwordTarget.employeeNo} · {passwordTarget.name}</strong></p>
          <form onSubmit={(event) => void resetSamplerPassword(event)}>
            <label>新初始化密码<input required autoFocus type="password" minLength={8} value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} /><small className="field-help">至少8位，同时包含英文字母和数字。保存后该账号原有登录状态将失效。</small></label>
            <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setPasswordTarget(undefined)}>取消</button><button type="submit" className="primary-button">确认初始化</button></div>
          </form>
        </section>
      </div>}

      {statusTarget && <div className="modal-backdrop" role="presentation" onMouseDown={() => setStatusTarget(undefined)}>
        <section className="modal account-action-modal" role="alertdialog" aria-modal="true" aria-labelledby="status-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow">SAMPLER STATUS</p><h2 id="status-title">确认修改抽检员状态</h2></div><button onClick={() => setStatusTarget(undefined)} aria-label="关闭">×</button></div>
          <p className="modal-description">抽检员：<strong>{statusTarget.employeeNo} · {statusTarget.name}</strong></p>
          {statusTarget.status === "ON_LEAVE" ? <div className="status-change-box"><strong>休假 → 启用</strong><p>恢复后，该抽检员可以重新登录并参与随机派单。</p></div> : <div className="status-change-box"><strong>启用 → 休假</strong><p>休假后，该抽检员将退出派单候选，当前登录状态也会失效。</p></div>}
          {statusTarget.status === "ACTIVE" && statusTarget.activeTaskCount > 0 && <div className="warning-box">该人员仍有 {statusTarget.activeTaskCount} 个未完成任务，不能设为休假，请先处理任务。</div>}
          <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setStatusTarget(undefined)}>取消</button><button type="button" className="primary-button" disabled={statusTarget.status === "ACTIVE" && statusTarget.activeTaskCount > 0} onClick={() => void changeSamplerStatus()}>{statusTarget.status === "ON_LEAVE" ? "确认恢复启用" : "确认设为休假"}</button></div>
        </section>
      </div>}

      {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
        <section className="modal account-action-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-heading"><div><p className="eyebrow danger-eyebrow">ACCOUNT DEACTIVATION</p><h2 id="delete-title">确认删除抽检员账号</h2></div><button onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></div>
          <p className="modal-description">即将停用 <strong>{deleteTarget.employeeNo} · {deleteTarget.name}</strong>。账号将不能登录或参与派单，历史任务和审计记录仍会保留。</p>
          {deleteTarget.activeTaskCount > 0 && <div className="warning-box">该人员显示有 {deleteTarget.activeTaskCount} 个未完成任务，系统将拒绝删除，请先处理任务。</div>}
          <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setDeleteTarget(undefined)}>取消</button><button type="button" className="danger-confirm-button" disabled={deleteTarget.activeTaskCount > 0} onClick={() => void deleteSampler()}>确认删除账号</button></div>
        </section>
      </div>}
    </div>
  );
}

function App() {
  const [user, setUser] = useState<AuthUser>();
  const [restoring, setRestoring] = useState(api.hasSession());

  useEffect(() => {
    if (!api.hasSession()) return;
    api.me().then(setUser).catch(() => setUser(undefined)).finally(() => setRestoring(false));
  }, []);

  async function logout() {
    await api.logout();
    setUser(undefined);
  }

  if (restoring) return <div className="auth-loading"><span className="brand-mark">检</span><p>正在恢复登录状态…</p></div>;
  if (!user) return <LoginPage onLoggedIn={setUser} />;
  if (user.role === "SAMPLER") return <SamplerPortal user={user} onLogout={() => void logout()} />;
  return <AdminPortal user={user} onLogout={() => void logout()} />;
}

export default App;
