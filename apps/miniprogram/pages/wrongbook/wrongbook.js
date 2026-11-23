const api = require('../../utils/api')
const { toNodes, linesToNodes } = require('../../utils/md')
const { unpackQuestion } = require('../../utils/question')
const { SUBJECTS } = require('../../utils/config')

// 列表卡片里的题干：小一号字、行距收紧，靠外层 max-height 截断（rich-text 不认 line-clamp）
const LIST_STEM = { fontSize: 14, lineHeight: 1.7, gap: 0 }
const LIST_NOTE = { fontSize: 13, lineHeight: 1.72, gap: 4 }

Page({
  data: {
    subjects: SUBJECTS,
    subject: 'math',
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: true,
    error: '',
    editing: null,
    noteDraft: '',
    noteEditing: false,
    noteNodes: [],
    solutionNodes: [],
    stemNodes: [],
    saving: false,
  },

  onLoad() {
    const app = getApp()
    this.setData({ subject: app.globalData.subject || 'math' })
  },

  onShow() {
    this.load(1)
  },

  onPullDownRefresh() {
    this.load(1).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.items.length >= this.data.total) return
    this.load(this.data.page + 1)
  },

  switchSubject(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ subject: key })
    this.load(1)
  },

  async load(page) {
    this.setData({ loading: page === 1, error: page === 1 ? '' : this.data.error })
    try {
      const res = await api.listQuestions({
        subject: this.data.subject,
        status: '待复习',
        page,
        pageSize: this.data.pageSize,
      })
      const incoming = (res.items || []).map((q) => {
        const stem = unpackQuestion(q.textBody || '')
        const note = q.note || ''
        return {
          id: q.id,
          title: q.title || '',
          stem,
          // 列表直接用 rich-text 渲染：分式、根号、上下标才和详情、课本一致
          stemNodes: linesToNodes(stem, LIST_STEM),
          noteNodes: note ? toNodes(note, LIST_NOTE) : [],
          chapter: q.chapter || '未归类',
          kp: (q.kpCodes || []).join('、') || '未标注',
          note,
          solution: q.solution || '',
          status: q.status,
          source: q.source,
        }
      })
      this.setData({
        items: page === 1 ? incoming : this.data.items.concat(incoming),
        total: res.total || 0,
        page,
        loading: false,
      })
    } catch (err) {
      this.setData({ loading: false, error: err.message })
    }
  },

  openNote(e) {
    // dataset 传对象在低版本基础库会被序列化成字符串，这里只传 id 再回查
    const id = e.currentTarget.dataset.id
    const item = this.data.items.find((q) => q.id === id)
    if (!item) return
    this.setData({
      editing: item,
      noteDraft: item.note || '',
      // 备注默认渲染成富文本给人看，点「编辑备注」才露出 LaTeX 源码
      // 详情的字号比列表大，列表那份 noteNodes 不能复用
      noteNodes: item.note ? toNodes(item.note) : [],
      noteEditing: false,
      // 详情里的题干和解析都走 rich-text，公式才不是源码
      stemNodes: linesToNodes(item.stem),
      solutionNodes: toNodes(item.solution || ''),
    })
  },

  startEditNote() {
    if (this.data.saving) return
    this.setData({ noteEditing: true })
  },

  closeNote() {
    this.setData({
      editing: null,
      noteEditing: false,
      noteDraft: '',
      noteNodes: [],
      solutionNodes: [],
      stemNodes: [],
    })
  },

  onNoteInput(e) {
    this.setData({ noteDraft: e.detail.value })
  },

  async saveNote() {
    if (this.data.saving || !this.data.editing) return
    this.setData({ saving: true })
    try {
      const note = this.data.noteDraft
      await api.updateNote(this.data.editing.id, note)
      const listNoteNodes = note ? toNodes(note, LIST_NOTE) : []
      const items = this.data.items.map((q) =>
        q.id === this.data.editing.id
          ? Object.assign({}, q, { note, noteNodes: listNoteNodes })
          : q,
      )
      this.setData({
        items,
        editing: Object.assign({}, this.data.editing, { note }),
        noteNodes: note ? toNodes(note) : [],
        noteEditing: false,
        saving: false,
      })
      wx.showToast({ title: '备注已保存', icon: 'success' })
    } catch (err) {
      this.setData({ saving: false })
      wx.showModal({ title: '保存失败', content: err.message, showCancel: false })
    }
  },

  goCapture() {
    // 拍照页通常在栈底：能回退就回退，避免 index→chat→wrongbook→index 越压越深
    const pages = getCurrentPages()
    const idx = pages.findIndex((p) => p.route === 'pages/index/index')
    if (idx >= 0 && idx < pages.length - 1) {
      wx.navigateBack({ delta: pages.length - 1 - idx })
    } else {
      wx.redirectTo({ url: '/pages/index/index' })
    }
  },
})
