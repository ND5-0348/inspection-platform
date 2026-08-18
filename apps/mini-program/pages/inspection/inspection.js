const api = require("../../utils/api");

function positionKey(position) { return `P${position.palletNo}-B${position.boxNo}-I${position.itemNo}`; }
function getLocation() { return new Promise((resolve, reject) => wx.getLocation({ type: "wgs84", isHighAccuracy: true, success: resolve, fail: reject })); }
function chooseCameraPhoto() { return new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["camera"], sizeType: ["compressed"], success: resolve, fail: reject })); }
function pad(value) { return String(value).padStart(2, "0"); }
function formatWatermarkTime(iso) { const date = new Date(iso); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; }

function watermarkedPhoto(sourcePath, lines) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: sourcePath,
      success(info) {
        try {
          if (!wx.createOffscreenCanvas) throw new Error("当前微信版本不支持安全图片水印，请升级微信后重试");
          const maxSide = 2400;
          const scale = Math.min(1, maxSide / Math.max(info.width, info.height));
          const width = Math.round(info.width * scale); const height = Math.round(info.height * scale);
          const canvas = wx.createOffscreenCanvas({ type: "2d", width, height });
          const context = canvas.getContext("2d"); const image = canvas.createImage();
          image.onload = () => {
            context.drawImage(image, 0, 0, width, height);
            const fontSize = Math.max(22, Math.round(width * 0.025)); const lineHeight = Math.round(fontSize * 1.45);
            const padding = Math.round(fontSize * 0.8); const panelHeight = lineHeight * lines.length + padding * 2;
            context.fillStyle = "rgba(0, 0, 0, 0.68)"; context.fillRect(0, height - panelHeight, width, panelHeight);
            context.font = `600 ${fontSize}px sans-serif`; context.fillStyle = "#ffffff"; context.textBaseline = "top";
            lines.forEach((line, index) => context.fillText(line, padding, height - panelHeight + padding + index * lineHeight, width - padding * 2));
            wx.canvasToTempFilePath({ canvas, fileType: "jpg", quality: 0.9, success: (result) => resolve(result.tempFilePath), fail: reject });
          };
          image.onerror = reject; image.src = sourcePath;
        } catch (error) { reject(error); }
      },
      fail: reject
    });
  });
}

Page({
  data: {
    id: "", task: null, loading: true, actionBusy: false,
    productIndex: 0, productNames: [], selectedItem: null,
    palletCount: 1, boxesPerPallet: 10, itemsPerBox: 12, sampleCount: 3, candidateTotal: 120,
    resultRows: [], conclusionLabels: ["请选择", "合格", "不合格", "不适用"]
  },
  onLoad(options) { this.setData({ id: options.id }); this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      const task = await api.getTask(this.data.id);
      const sampleFiles = (task.evidenceFiles || []).filter((file) => file.purpose === "SAMPLE");
      await Promise.all(sampleFiles.map(async (file) => {
        try { file.previewUrl = await api.downloadEvidence(file.id); } catch { file.previewUrl = ""; }
      }));
      const existing = new Map((task.inspectionResults || []).map((result) => [result.sampleKey, result]));
      const resultRows = (task.physicalSample?.positions || []).map((position) => {
        const key = positionKey(position); const saved = existing.get(key);
        const valueIndex = saved?.conclusion === "PASS" ? 1 : saved?.conclusion === "FAIL" ? 2 : saved?.conclusion === "NA" ? 3 : 0;
        const photos = sampleFiles.filter((file) => file.sampleKey === key);
        return { ...position, key, valueIndex, note: saved?.note || "", photos, photoCount: photos.length };
      });
      const productNames = task.order.items.map((item) => `${item.productName} · ${item.productCode} · 抽${item.sampleQuantity || item.quantity}件`);
      task.checkInPhoto = (task.evidenceFiles || []).find((file) => file.purpose === "CHECK_IN") || null;
      task.inspectionEvidenceFiles = (task.evidenceFiles || []).filter((file) => file.purpose === "INSPECTION");
      task.samplePhotoCompleteCount = resultRows.filter((row) => row.photoCount > 0).length;
      this.setData({ task, resultRows, productNames, selectedItem: task.order.items[this.data.productIndex] || null, loading: false });
    } catch (error) { wx.showToast({ title: error.message || "加载失败", icon: "none" }); }
  },
  updateNumber(event) {
    const field = event.currentTarget.dataset.field;
    const value = Math.max(1, Number(event.detail.value));
    const next = { [field]: value };
    next.candidateTotal = (field === "palletCount" ? value : this.data.palletCount) * (field === "boxesPerPallet" ? value : this.data.boxesPerPallet) * (field === "itemsPerBox" ? value : this.data.itemsPerBox);
    this.setData(next);
  },
  changeProduct(event) {
    const productIndex = Number(event.detail.value);
    this.setData({ productIndex, selectedItem: this.data.task.order.items[productIndex] });
  },
  async checkIn() {
    this.setData({ actionBusy: true });
    try {
      const media = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["camera"], sizeType: ["compressed"], success: resolve, fail: reject }));
      const location = await new Promise((resolve, reject) => wx.getLocation({ type: "gcj02", isHighAccuracy: true, success: resolve, fail: reject }));
      await api.photoCheckIn(this.data.id, media.tempFiles[0].tempFilePath, { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy || 0, address: this.data.task.order.siteAddress });
      wx.showToast({ title: "图片签到成功" }); await this.load();
    } catch (error) { wx.showToast({ title: error.message || "图片签到失败", icon: "none" }); }
    finally { this.setData({ actionBusy: false }); }
  },
  async drawSample() {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: "确认三级随机抽样", content: `现场候选共${this.data.candidateTotal}件，结果生成后不能重抽。`, success: (res) => resolve(res.confirm) }));
    if (!confirmed) return;
    this.setData({ actionBusy: true });
    try {
      const orderItem = this.data.task.order.items[this.data.productIndex];
      await api.physicalSample(this.data.id, { orderItemId: orderItem.id, palletCount: this.data.palletCount, boxesPerPallet: this.data.boxesPerPallet, itemsPerBox: this.data.itemsPerBox, sampleCount: this.data.sampleCount });
      wx.showToast({ title: "抽样完成" }); await this.load();
    } catch (error) { wx.showToast({ title: error.message || "抽样失败", icon: "none" }); }
    finally { this.setData({ actionBusy: false }); }
  },
  changeConclusion(event) {
    const index = Number(event.currentTarget.dataset.index); const valueIndex = Number(event.detail.value);
    this.setData({ [`resultRows[${index}].valueIndex`]: valueIndex });
  },
  changeNote(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`resultRows[${index}].note`]: event.detail.value });
  },
  async saveResults(showToast = true) {
    const values = ["", "PASS", "FAIL", "NA"];
    const results = this.data.resultRows.filter((row) => row.valueIndex > 0).map((row) => ({ sampleKey: row.key, conclusion: values[row.valueIndex], note: row.note }));
    if (!results.length) throw new Error("请填写检测结论");
    await api.saveInspectionResults(this.data.id, results);
    if (showToast) wx.showToast({ title: "结果已保存" });
    await this.load();
  },
  async saveResultTap() {
    this.setData({ actionBusy: true });
    try { await this.saveResults(true); } catch (error) { wx.showToast({ title: error.message || "保存失败", icon: "none" }); }
    finally { this.setData({ actionBusy: false }); }
  },
  async takePhoto() {
    this.setData({ actionBusy: true });
    try {
      const media = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["camera"], sizeType: ["compressed"], success: resolve, fail: reject }));
      await api.uploadEvidence(this.data.id, media.tempFiles[0].tempFilePath);
      wx.showToast({ title: "照片已上传" }); await this.load();
    } catch (error) { wx.showToast({ title: error.message || "上传失败", icon: "none" }); }
    finally { this.setData({ actionBusy: false }); }
  },
  async takeSamplePhoto(event) {
    const sampleKey = event.currentTarget.dataset.key;
    const row = this.data.resultRows.find((item) => item.key === sampleKey);
    if (!row || row.photoCount >= 5) return wx.showToast({ title: "每个样品最多5张照片", icon: "none" });
    this.setData({ actionBusy: true });
    try {
      const media = await chooseCameraPhoto(); const location = await getLocation(); const capturedAt = new Date().toISOString();
      const resolved = await api.reverseGeocode(location.latitude, location.longitude, this.data.task.order.siteAddress);
      const lines = [
        `任务 ${this.data.task.taskNo} · 样品 ${sampleKey}`,
        resolved.address,
        `WGS84 ${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)} · 精度约 ${Math.round(location.accuracy || 0)}米`,
        `拍摄时间 ${formatWatermarkTime(capturedAt)}`
      ];
      const outputPath = await watermarkedPhoto(media.tempFiles[0].tempFilePath, lines);
      await api.uploadSampleEvidence(this.data.id, outputPath, {
        sampleKey, latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy || 0,
        address: resolved.address, coordinateSystem: "WGS84", mapProvider: resolved.provider, capturedAt,
        watermarkText: lines.join("\n"), watermarkVersion: "MINI_OFFSCREEN_CANVAS_V1"
      });
      wx.showToast({ title: "水印照片已保存" }); await this.load();
    } catch (error) { wx.showToast({ title: error.message || "样品照片失败", icon: "none" }); }
    finally { this.setData({ actionBusy: false }); }
  },
  async submitReview() {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: "提交审核", content: "提交后现场记录将锁定，确认继续？", success: (res) => resolve(res.confirm) }));
    if (!confirmed) return;
    this.setData({ actionBusy: true });
    try { await this.saveResults(false); await api.submitReview(this.data.id); wx.showToast({ title: "已提交审核" }); await this.load(); }
    catch (error) { wx.showToast({ title: error.message || "提交失败", icon: "none" }); }
    finally { this.setData({ actionBusy: false }); }
  }
});
