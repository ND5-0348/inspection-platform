Page({
  data: { name: "抽样员", pending: 0, active: 0 },
  onShow() {
    const api = require("../../utils/api");
    api.getTasks().then((tasks) => {
      const currentUser = getApp().globalData.currentUser;
      this.setData({
        name: currentUser?.name || "抽样员",
        pending: tasks.filter((task) => task.status === "PENDING_ACCEPTANCE").length,
        active: tasks.filter((task) => ["ACCEPTED", "IN_PROGRESS"].includes(task.status)).length
      });
    }).catch(() => {});
  },
  openTasks() { wx.switchTab({ url: "/pages/tasks/tasks" }); }
});
