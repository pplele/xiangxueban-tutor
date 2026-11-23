const api = require('../../utils/api')
const { linesToNodes } = require('../../utils/md')
const { unpackQuestion } = require('../../utils/question')
const { SUBJECTS, USE_VOICE_PLUGIN } = require('../../utils/config')

/** 降质压缩；失败就退回原图，不阻断识别 */
function compressImage(src, quality) {
  return new Promise((resolve) => {
    wx.compressImage({
      src,
      quality,
      success: (res) => resolve(res.tempFilePath),
      fail: () => resolve(src),
    })
  })
}

Page({
  data: {
    subjects: SUBJECTS,
    subject: 'math',
    imagePath: '',
    text: '',
    previewNodes: [],
    question: '',
    uncertain: [],
    recognizing: false,
    voiceEnabled: USE_VOICE_PLUGIN,
    recording: false,
  },

  onLoad() {
    const app = getApp()
    this.setData({ subject: app.globalData.subject || 'math' })
    if (USE_VOICE_PLUGIN) this.initVoice()
  },

  initVoice() {
    try {
      const plugin = requirePlugin('WechatSI')
      this.plugin = plugin
    } catch (err) {
      this.setData({ voiceEnabled: false })
      console.warn('同声传译插件未启用：' + err.message)
    }
  },

  switchSubject(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ subject: key })
    getApp().globalData.subject = key
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      camera: 'back',
      success: (res) => {
        const file = res.tempFiles[0]
        this.setData({ imagePath: file.tempFilePath, recognizing: true })
        this.recognize(file.tempFilePath)
      },
    })
  },

  async recognize(filePath) {
    try {
      // 后端限制 base64 不超过 2MB；高像素手机压缩后仍可能超，逐级降质一次
      const MAX_B64 = 1.9 * 1024 * 1024
      let src = filePath
      let base64 = await api.readFileBase64(src)
      for (const quality of [60, 35]) {
        if (base64.length <= MAX_B64) break
        src = await compressImage(src, quality)
        base64 = await api.readFileBase64(src)
      }
      if (base64.length > MAX_B64) {
        this.setData({ recognizing: false })
        wx.showToast({ title: '图片太大，靠近题目重拍一张', icon: 'none' })
        return
      }

      const result = await api.recognize(base64, this.data.subject)
      const text = unpackQuestion(result.text || '')
      this.setData({
        text,
        previewNodes: linesToNodes(text),
        uncertain: result.uncertain || [],
        subject: result.subject || this.data.subject,
        recognizing: false,
      })
      if (!text) {
        wx.showToast({ title: '没识别出题目，请重拍', icon: 'none' })
      }
    } catch (err) {
      this.setData({ recognizing: false })
      wx.showModal({ title: '识别失败', content: err.message, showCancel: false })
    }
  },

  onTextInput(e) {
    const text = e.detail.value
    this.setData({ text, previewNodes: linesToNodes(text) })
  },

  onQuestionInput(e) {
    this.setData({ question: e.detail.value })
  },

  startVoice() {
    if (!this.plugin) return
    this.setData({ recording: true })
    this.plugin.startRecord({
      lang: 'zh_CN',
      duration: 30000,
      success: () => {},
      fail: () => this.setData({ recording: false }),
    })
  },

  stopVoice() {
    if (!this.plugin) return
    this.setData({ recording: false })
    this.plugin.stopRecord({
      success: (res) => {
        const said = (res.result || '').trim()
        if (!said) return
        const merged = this.data.question ? this.data.question + '；' + said : said
        this.setData({ question: merged })
      },
      fail: () => wx.showToast({ title: '没听清，再说一次', icon: 'none' }),
    })
  },

  onAsk() {
    const text = this.data.text.trim()
    if (!text) {
      wx.showToast({ title: '先拍照或输入题目', icon: 'none' })
      return
    }
    if (this.data.recognizing) {
      wx.showToast({ title: '还在识别，稍等一下', icon: 'none' })
      return
    }
    const params = ['subject=' + this.data.subject]
    if (this.data.imagePath) params.push('image=' + encodeURIComponent(this.data.imagePath))
    // 题干动辄上千字，编码后远超 navigateTo 的 URL 长度上限，改成内存传递
    getApp().globalData.pendingAsk = {
      subject: this.data.subject,
      text,
      question: this.data.question.trim(),
      imagePath: this.data.imagePath,
    }
    wx.navigateTo({ url: '/pages/chat/chat?' + params.join('&') })
  },

  goWrongbook() {
    wx.navigateTo({ url: '/pages/wrongbook/wrongbook' })
  },
})
