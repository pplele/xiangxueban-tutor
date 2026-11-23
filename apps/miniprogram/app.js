const api = require('./utils/api')

App({
  globalData: {
    subject: 'math',
    lastPaper: null,
    /** 拍照页 → 讲解页的传参载体：题干可能上千字，放 URL 会超长，走内存传递 */
    pendingAsk: null,
  },

  onLaunch() {
    api.login().catch((err) => {
      wx.showToast({ title: err.message, icon: 'none', duration: 3000 })
    })
  },
})
