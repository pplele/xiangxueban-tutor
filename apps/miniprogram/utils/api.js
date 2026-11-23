const { BASE_URL, DEMO_USER } = require('./config')

let token = ''
let loginPromise = null

function rawRequest(path, { method = 'GET', data, timeout = 60000, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      timeout,
      header: Object.assign(
        { 'Content-Type': 'application/json' },
        auth && token ? { Authorization: 'Bearer ' + token } : {},
      ),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
          return
        }
        const body = res.data && res.data.error ? res.data.error : {}
        const err = new Error(body.message || '请求失败（' + res.statusCode + '）')
        err.statusCode = res.statusCode
        err.code = body.code
        reject(err)
      },
      fail(e) {
        reject(new Error('连不上服务器，请检查电脑服务是否启动、手机与电脑是否同一 Wi-Fi（' + (e.errMsg || '') + '）'))
      },
    })
  })
}

function login() {
  if (loginPromise) return loginPromise
  loginPromise = rawRequest('/api/auth/login', {
    method: 'POST',
    data: DEMO_USER,
    auth: false,
  })
    .then((res) => {
      token = res.accessToken
      loginPromise = null
      return token
    })
    .catch((err) => {
      loginPromise = null
      throw err
    })
  return loginPromise
}

async function request(path, options = {}) {
  if (!token) await login()
  try {
    return await rawRequest(path, options)
  } catch (err) {
    if (err.statusCode === 401) {
      token = ''
      await login()
      return rawRequest(path, options)
    }
    throw err
  }
}

/** 拍照识题：图片 base64 → 题干文本 */
function recognize(imageBase64, subject) {
  return request('/api/capture/ocr', {
    method: 'POST',
    data: { image: imageBase64, subject },
    timeout: 90000,
  })
}

/** 错题查重：指纹精确 + 向量近似 */
function matchWrong(subject, textBody) {
  return request('/api/capture/wrong-match', {
    method: 'POST',
    data: { subject, textBody },
    timeout: 60000,
  })
}

/** 存入错题本：题目 / 解析 / 备注 */
function saveWrong(payload) {
  return request('/api/capture/wrong-save', {
    method: 'POST',
    data: payload,
    timeout: 90000,
  })
}

function createSession(subject, title) {
  return request('/api/chat/sessions', {
    method: 'POST',
    data: { subject, title },
  })
}

/** 非流式问答（小程序不用 SSE） */
function askSync(sessionId, content) {
  return request('/api/chat/ask-sync', {
    method: 'POST',
    data: { sessionId, content },
    timeout: 120000,
  })
}

/** 结束答疑时把整段对话压成备注要点（不写库，可重复调用） */
function summarize(sessionId) {
  return request('/api/chat/summarize', {
    method: 'POST',
    data: { sessionId },
    timeout: 60000,
  })
}

function listQuestions(params) {
  const qs = Object.keys(params || {})
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .map((k) => k + '=' + encodeURIComponent(params[k]))
    .join('&')
  return request('/api/questions' + (qs ? '?' + qs : ''))
}

function updateNote(id, note) {
  return request('/api/questions/' + id + '/note', {
    method: 'PATCH',
    data: { note },
  })
}

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: () => reject(new Error('读取图片失败，请重试')),
    })
  })
}

module.exports = {
  login,
  request,
  recognize,
  matchWrong,
  saveWrong,
  createSession,
  askSync,
  summarize,
  listQuestions,
  updateNote,
  readFileBase64,
}
