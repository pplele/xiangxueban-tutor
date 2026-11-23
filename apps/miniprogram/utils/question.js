/**
 * 题干文本清洗
 *
 * 历史遗留：识题接口早期在 JSON 解析失败时，把模型输出的整段 JSON 当题干返回，
 * 这些脏数据已经进了会话和错题本。这里做一次拆包，让老数据也能正常显示。
 */

/** 看起来像"模型吐出来的那个 JSON" */
function looksLikeJson(text) {
  const t = String(text || '').trim()
  return t.charAt(0) === '{' && /"text"\s*:/.test(t)
}

/**
 * 如果是 JSON 就取出 text 与 options 拼回题面，否则原样返回。
 * @param {string} raw
 * @returns {string}
 */
function unpackQuestion(raw) {
  const text = String(raw == null ? '' : raw)
  if (!looksLikeJson(text)) return text

  const m = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!m) return text
  const stem = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')

  const options = []
  const block = /"options"\s*:\s*\[([\s\S]*?)\]/.exec(text)
  if (block) {
    const re = /"((?:[^"\\]|\\.)*)"/g
    let hit
    while ((hit = re.exec(block[1])) !== null) options.push(hit[1].replace(/\\"/g, '"'))
  }
  return options.length ? `${stem}\n${options.join('\n')}` : stem
}

module.exports = { unpackQuestion, looksLikeJson }
