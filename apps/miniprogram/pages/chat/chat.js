const api = require('../../utils/api')
const { toNodes, linesToNodes } = require('../../utils/md')
const { unpackQuestion } = require('../../utils/question')

/** 后端 /api/chat/ask-sync 的 content 上限 4000，超了会直接 400 */
const MAX_ASK = 4000
/** 存入错题本时「解析」字段的截断长度，后端上限 8000 */
const MAX_SOLUTION = 3000

/** 学生最常卡住的三种情况，点一下就能继续问，不用自己打字 */
const QUICK_ASKS = [
  {
    label: '还是没懂，讲简单点',
    text: '我还是没听懂。请换一种更简单的讲法，少用公式，尽量用生活里的例子说明。',
  },
  {
    label: '这一步为什么',
    text: '上面那一步为什么可以这样做？请只解释这一步的依据，不要重复整道题。',
  },
  {
    label: '再举个例子',
    text: '请再举一个类似的例子，并说明它和这道题的区别在哪。',
  },
]

function buildAskContent(text, question) {
  if (!question) return text.slice(0, MAX_ASK)
  const q = question.slice(0, 800)
  const budget = Math.max(200, MAX_ASK - q.length - 7)
  return text.slice(0, budget) + '\n\n我的疑问：' + q
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v || '')
  } catch (err) {
    return v || ''
  }
}

/** 片段正文里带【出处：库课X教材 书pN / PDF pM】，把页码抠出来给学生对照纸质书 */
function citesOf(list) {
  const seen = {}
  const out = []
  ;(list || []).forEach((c) => {
    const body = c.content || ''
    const pm = body.match(/书\s*p(\d+)/i) || body.match(/PDF\s*p(\d+)/i)
    const item = {
      source: (c.sourceName || '').split('/').pop().replace(/\.md$/, ''),
      page: pm ? 'p' + pm[1] : '',
      kp: (c.kpCodes || []).join('、'),
    }
    // 同一页同一考点只留一条，否则三条引用可能全指向同一处，看着像刷屏
    const key = item.source + '|' + item.page + '|' + item.kp
    if (seen[key]) return
    seen[key] = true
    out.push(item)
  })
  return out.slice(0, 3)
}

Page({
  data: {
    subject: 'math',
    text: '',
    question: '',
    imagePath: '',
    questionNodes: [],
    qCollapsed: false,

    /** 对话流：{ key, role: 'user'|'assistant', text, nodes, cites } */
    messages: [],
    sessionId: '',
    /** 最近一次真正发给后端的内容（气泡可能只是短句），重试用它 */
    lastAsk: '',
    input: '',
    turns: 0,
    loading: true,
    sending: false,
    stageText: '正在检索教材…',

    quickAsks: QUICK_ASKS,
    exact: [],
    similar: [],
    error: '',

    showSave: false,
    solution: '',
    note: '',
    summarizing: false,
    saving: false,
    savedId: '',
  },

  msgSeq: 0,

  onLoad(query) {
    const app = getApp()
    const pending = app.globalData.pendingAsk
    app.globalData.pendingAsk = null // 用完即清，返回再进不重复触发

    const subject = (pending && pending.subject) || query.subject || 'math'
    // 老数据里可能存着识题接口吐的整段 JSON，先拆包再显示
    const text = unpackQuestion(pending ? pending.text : safeDecode(query.text))
    const question = pending ? pending.question : safeDecode(query.question)
    const imagePath = (pending && pending.imagePath) || safeDecode(query.image)

    this.setData({ subject, text, question, imagePath, questionNodes: linesToNodes(text) })

    // 页面栈被恢复（热重载 / 从分享进入）时 pendingAsk 已清空，题目会是空的
    if (!String(text || '').trim()) {
      this.setData({
        loading: false,
        error: '没有拿到题目内容，请返回上一页重新拍照，或直接粘贴题目',
      })
      return
    }

    const content = buildAskContent(text, question)
    this.setData({ lastAsk: content })
    // 气泡只展示学生真正想问的话；题目已经在上面的卡片里，不必整段复述一遍
    this.appendMessage({
      key: this.nextKey(),
      role: 'user',
      text: question ? '我的疑问：' + question : '这道题我不会，帮我讲讲',
    })
    this.runInitial(text, question)
  },

  nextKey() {
    this.msgSeq = (this.msgSeq || 0) + 1
    return 'm' + this.msgSeq
  },

  appendMessage(msg) {
    const messages = this.data.messages.concat([msg])
    this.setData({
      messages,
      turns: messages.filter((m) => m.role === 'user').length,
    })
    this.scrollToBottom()
    return msg
  },

  scrollToBottom() {
    wx.nextTick(() => {
      wx.pageScrollTo({ scrollTop: 200000, duration: 200 })
    })
  },

  /** 首轮：查重 → 建会话（失败要能区分是查重失败还是问答失败，查重不阻断主流程） */
  async runInitial(text, question) {
    this.setData({ loading: true, stageText: '正在查你的错题本…', error: '' })
    try {
      const match = await api
        .matchWrong(this.data.subject, text)
        .catch(() => ({ exact: [], similar: [] }))
      this.setData({
        // 备注里常带 $\frac{...}$，横幅也要渲染，不然学生看到的是源码
        exact: (match.exact || []).map((x) => ({
          ...x,
          note: x.note || '',
          noteNodes: x.note ? toNodes(x.note) : [],
        })),
        similar: (match.similar || []).map((x) => ({
          ...x,
          simText: Math.round((x.score || 0) * 100) + '%',
        })),
      })

      this.setData({ stageText: '正在检索教材并组织讲解…' })
      const session = await api.createSession(this.data.subject, text.slice(0, 24))
      this.setData({ sessionId: session.id })

      const res = await api.askSync(session.id, buildAskContent(text, question))
      this.pushAnswer(res)
    } catch (err) {
      this.setData({ loading: false, error: err.message })
    }
  },

  pushAnswer(res) {
    this.appendMessage({
      key: this.nextKey(),
      role: 'assistant',
      text: res.content || '',
      // 后端返回 Markdown + LaTeX，rich-text 才有排版
      nodes: toNodes(res.content || ''),
      cites: citesOf(res.citations),
    })
    this.setData({
      loading: false,
      sending: false,
      stageText: '正在检索教材…',
      error: '',
    })
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  /** 回车 / 点发送：走同一个入口 */
  sendFollowUp() {
    const text = (this.data.input || '').trim()
    if (!text) return
    this.setData({ input: '' })
    this.sendText(text)
  },

  useQuick(e) {
    const item = QUICK_ASKS[e.currentTarget.dataset.index]
    if (item) this.sendText(item.text)
  },

  async sendText(text, echo = true) {
    if (this.data.loading || this.data.sending) return
    const value = String(text || '').trim()
    if (!value) return

    // 重试时复用上一条气泡，不重复插入
    if (echo) this.appendMessage({ key: this.nextKey(), role: 'user', text: value })
    this.setData({ sending: true, error: '', stageText: '老师正在回答…', lastAsk: value })
    try {
      let sid = this.data.sessionId
      // 首轮失败时没有会话，追问先补建一个，避免直接 404
      if (!sid) {
        const session = await api.createSession(this.data.subject, (this.data.text || '').slice(0, 24))
        sid = session.id
        this.setData({ sessionId: sid })
      }
      const res = await api.askSync(sid, value.slice(0, MAX_ASK))
      this.pushAnswer(res)
    } catch (err) {
      this.setData({ sending: false, error: err.message })
    }
  },

  retry() {
    if (this.data.sending || this.data.loading) return
    if (!this.data.lastAsk) return
    this.setData({ error: '' })
    this.sendText(this.data.lastAsk, false)
  },

  toggleQuestion() {
    this.setData({ qCollapsed: !this.data.qCollapsed })
  },

  /** 讲解是长文本，学生常要粘到笔记里；rich-text 里长按选不全，给个一键复制 */
  copyMsg(e) {
    const key = e.currentTarget.dataset.key
    const msg = this.data.messages.find((m) => m.key === key)
    if (!msg || !msg.text) return
    wx.setClipboardData({
      data: msg.text,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  /** 存入错题本：解析取首轮完整讲解，备注用整段对话的要点总结 */
  openSave() {
    if (this.data.saving || this.data.loading) return
    const firstAnswer = (this.data.messages.find((m) => m.role === 'assistant' && m.text) || {}).text || ''
    const sid = this.data.sessionId

    this.setData({
      showSave: true,
      solution: firstAnswer.slice(0, MAX_SOLUTION),
      note: '',
      summarizing: Boolean(sid),
    })
    if (!sid) return

    api
      .summarize(sid)
      .then((res) => {
        if (!this.data.showSave) {
          this.setData({ summarizing: false })
          return
        }
        // 学生自己已经写了备注就不要覆盖
        this.setData({
          summarizing: false,
          note: this.data.note ? this.data.note : res.note || '',
        })
      })
      .catch(() => this.setData({ summarizing: false }))
  },

  /** 输入栏旁的常驻入口：已存过就直接去错题本，没存过就开保存弹层 */
  onSaveTap() {
    if (this.data.savedId) {
      this.goWrongbook()
      return
    }
    this.openSave()
  },

  closeSave() {
    this.setData({ showSave: false })
  },

  onSolutionInput(e) {
    this.setData({ solution: e.detail.value })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  async confirmSave() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const res = await api.saveWrong({
        subject: this.data.subject,
        textBody: this.data.text,
        solution: this.data.solution,
        note: this.data.note,
        imageUrl: this.data.imagePath,
      })
      this.setData({ saving: false, showSave: false, savedId: res.id })
      wx.showToast({ title: res.action === 'updated' ? '已更新错题' : '已存入错题本', icon: 'success' })
    } catch (err) {
      this.setData({ saving: false })
      wx.showModal({ title: '保存失败', content: err.message, showCancel: false })
    }
  },

  goWrongbook() {
    wx.navigateTo({ url: '/pages/wrongbook/wrongbook' })
  },

  onShareAppMessage() {
    return { title: '拍题问老师', path: '/pages/index/index' }
  },
})
