const api = require("../../utils/api");

Page({
  data: { id: "", detail: null, count: 1, result: [], drawing: false },
  onLoad(options) { this.setData({ id: options.id }); this.load(); },
  async load() { try { this.setData({ detail: await api.getTask(this.data.id) }); } catch (error) { wx.showToast({ title: error.message, icon: "none" }); } },
  changeCount(event) { this.setData({ count: Number(event.detail.value) }); },
  async draw() {
    const confirmed = await new Promise((resolve) => wx.showModal({ title: "确认开始随机抽样", content: "结果生成后不可重复抽取，请确认现场产品清单已经核对无误。", success: (res) => resolve(res.confirm) }));
    if (!confirmed) return;
    this.setData({ drawing: true });
    try {
      const response = await api.sampleTask(this.data.id, this.data.count);
      this.setData({ result: response.selectedItems });
    } catch (error) { wx.showToast({ title: error.message || "抽样失败", icon: "none" }); }
    finally { this.setData({ drawing: false }); }
  }
});

