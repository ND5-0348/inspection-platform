const api = require("../../utils/api");

Page({
  data: { tasks: [], loading: true, error: "" },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const tasks = await api.getTasks();
      this.setData({ tasks });
    } catch (error) { this.setData({ error: error.message || "加载失败" }); }
    finally { this.setData({ loading: false }); }
  },
  openTask(event) { wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${event.currentTarget.dataset.id}` }); }
});
