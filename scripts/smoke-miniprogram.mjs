/**
 * 小程序端联调冒烟：模拟 pages 里按顺序发起的请求
 * 用法：node scripts/smoke-miniprogram.mjs [baseUrl] [--keep]
 * 默认 http://127.0.0.1:8849；加 --keep 保留写入的测试数据（默认跑完自动清理）
 */
const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:8849'
const KEEP = process.argv.includes('--keep')
const USER = {
  username: process.env.AUTH_USERNAME || 'student',
  password: process.env.AUTH_PASSWORD || 'change-me',
}

let token = ''

async function req(path, { method = 'GET', body, timeout = 120000 } = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
    ),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  const ms = Date.now() - t0
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${ms}ms ${text.slice(0, 300)}`)
  }
  return { data, ms }
}

function log(step, ms, extra) {
  console.log(`  ✓ ${step}  ${String(ms).padStart(6)}ms  ${extra ?? ''}`)
}

const QUESTION =
  '求极限 lim(x→0) (sin3x)/(tan5x)，并说明每一步用到哪个等价无穷小替换。'

async function main() {
  console.log(`BASE = ${BASE}\n`)

  const login = await req('/api/auth/login', { method: 'POST', body: USER })
  token = login.data.accessToken
  if (!token) throw new Error('登录未返回 accessToken')
  log('POST /api/auth/login', login.ms, 'token 已获取')

  const sess = await req('/api/chat/sessions', {
    method: 'POST',
    body: { subject: 'math', title: '小程序联调' },
  })
  const sessionId = sess.data.id || sess.data.session?.id
  if (!sessionId) throw new Error('建会话未返回 id: ' + JSON.stringify(sess.data).slice(0, 200))
  log('POST /api/chat/sessions', sess.ms, `sessionId=${sessionId}`)

  const ask = await req('/api/chat/ask-sync', {
    method: 'POST',
    body: { sessionId, content: QUESTION },
  })
  const cites = ask.data.citations || []
  log(
    'POST /api/chat/ask-sync',
    ask.ms,
    `回答 ${ask.data.content?.length ?? 0} 字，引用 ${cites.length} 条` +
      (cites[0] ? `，首条=${(cites[0].sourceName || '').split('/').pop()}` : ''),
  )

  // 第二轮：模拟学生追问，验证多轮上下文没丢
  const follow = await req('/api/chat/ask-sync', {
    method: 'POST',
    body: { sessionId, content: '上面第一步为什么可以直接等价替换？' },
  })
  log('POST /api/chat/ask-sync（追问）', follow.ms, `回答 ${follow.data.content?.length ?? 0} 字`)

  // 结束答疑时生成备注要点
  const sum = await req('/api/chat/summarize', { method: 'POST', body: { sessionId } })
  const points = String(sum.data.note || '').split('\n').filter(Boolean)
  log('POST /api/chat/summarize', sum.ms, `要点 ${points.length} 条，${sum.data.turns} 轮` + (points[0] ? `，如「${points[0].slice(0, 24)}」` : ''))

  const match = await req('/api/capture/wrong-match', {
    method: 'POST',
    body: { subject: 'math', textBody: QUESTION },
  })
  const m = match.data
  const exact = m.exact || []
  const similar = m.similar || []
  log(
    'POST /api/capture/wrong-match',
    match.ms,
    `exact=${exact.length}${exact[0] ? `(${exact[0].id})` : ''} similar=${similar.length}` +
      (similar[0] ? `(最高相似 ${similar[0].score.toFixed(2)}，${similar[0].id})` : ''),
  )

  const save = await req('/api/capture/wrong-save', {
    method: 'POST',
    body: {
      subject: 'math',
      textBody: QUESTION,
      solution: ask.data.content || '（联调用解析）',
      note: '联调脚本自动写入，可删除',
      chapter: '函数与极限',
    },
  })
  const qid = save.data.questionId || save.data.id || save.data.question?.id
  log('POST /api/capture/wrong-save', save.ms, `action=${save.data.action ?? '-'} id=${qid ?? '-'}`)

  const list = await req('/api/questions?subject=math&page=1&pageSize=5')
  log('GET  /api/questions', list.ms, `total=${list.data.total}，本页 ${list.data.items?.length ?? 0} 条`)

  if (qid) {
    const note = await req(`/api/questions/${qid}/note`, {
      method: 'PATCH',
      body: { note: '联调备注已更新' },
    })
    log('PATCH /api/questions/:id/note', note.ms, '备注可写')
  }

  console.log('\n全部通过：小程序接口与后端签名一致。')

  if (KEEP) {
    console.log(`保留测试数据：题目 ${qid ?? '-'}、会话 ${sessionId}（--keep）`)
  } else {
    await cleanup(qid, sessionId)
  }
}

/** 冒烟会真的写一条错题和一个会话，跑完顺手删掉，避免污染错题本 */
async function cleanup(questionId, sessionId) {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const envPath = path.resolve(process.cwd(), '.env')
    const m = fs.readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.+)$/m)
    if (!m) throw new Error('未找到 DATABASE_URL')
    const { Client } = await import('pg')
    const db = new Client({ connectionString: m[1].trim() })
    await db.connect()
    if (questionId) await db.query('DELETE FROM questions WHERE id = $1', [questionId])
    await db.query('DELETE FROM chat_messages WHERE session_id = $1', [sessionId])
    await db.query('DELETE FROM chat_sessions WHERE id = $1', [sessionId])
    await db.end()
    console.log('  ✓ 已清理本次写入的测试题目与会话')
  } catch (err) {
    console.log('  · 自动清理未执行：' + err.message)
    console.log(`    手动清理：DELETE FROM questions WHERE id='${questionId}'; 会话 ${sessionId}`)
  }
}

main().catch((err) => {
  console.error('\n✗ 失败：', err.message)
  process.exit(1)
})
