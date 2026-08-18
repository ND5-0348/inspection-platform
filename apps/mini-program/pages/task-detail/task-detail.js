const api = require("../../utils/api");

Page({
  data: { id: "", task: null, order: null, loading: true },
  onLoad(options) { this.setData({ id: options.id }); },
  onShow() { if (this.data.id) this.load(); },
  async load() {
    try {
      const detail = await api.getTask(this.data.id);
      const sampleTotal = detail.order.items.reduce((total, item) => total + Number(item.sampleQuantity || item.quantity || 0), 0);
      this.setData({ task: detail, order: detail.order, sampleTotal, loading: false });
    } catch (error) { wx.showToast({ title: error.message || "加载失败", icon: "none" }); }
  },
  async accept() {
    try { await api.acceptTask(this.data.id); wx.showToast({ title: "接单成功" }); await this.load(); }
    catch (error) { wx.showToast({ title: error.message || "接单失败", icon: "none" }); }
  },
  startSample() { wx.navigateTo({ url: `/pages/inspection/inspection?id=${this.data.id}` }); }
});
