# -*- coding: utf-8 -*-
"""从教育部《高等职业教育专科英语课程标准（2021年版）》PDF 提取附录 3000 词表"""
import json, re
from pypdf import PdfReader

r = PdfReader('kc.pdf')
raw_lines = []
for i in range(22, len(r.pages)):          # 第23页起是词汇表
    t = r.pages[i].extract_text() or ''
    raw_lines.extend(t.split('\n'))

entries = []       # (word, level)  level: base / basic(*) / ext(**)
for ln in raw_lines:
    s = ln.strip()
    if not s:
        continue
    # 单字母分节标题 A B C ... 或页码
    if re.fullmatch(r'[A-Z]', s) or re.fullmatch(r'\d{1,3}', s):
        continue
    # 中文说明行
    if re.search(r'[\u4e00-\u9fff]', s):
        continue
    level = 'base'
    if s.startswith('**'):
        level, s = 'ext', s[2:]
    elif s.startswith('*'):
        level, s = 'basic', s[1:]
    # 只压缩空白，保留短语内部的单词间隔（如 Automatic Teller Machine）
    s = re.sub(r'\s+', ' ', s).strip()
    if not s:
        continue
    # 由英文字母、空格、斜杠、连字符、点、撇号组成
    if not re.fullmatch(r"[A-Za-z][A-Za-z /'\-.&]*", s):
        continue
    entries.append((s, level))

# 拆斜杠并列形式：actor/actress -> actor, actress；a/an -> a, an
# 但 AI/artificial intelligence 这类已在上一步因空格被合并成 AI/artificialintelligence，需特判
words = {}
for s, level in entries:
    parts = s.split('/')
    for p in parts:
        p = p.strip().strip('.').lower()
        if not p or not re.fullmatch(r"[a-z][a-z' \-.]*", p):
            continue
        if p not in words:
            words[p] = level

out = [{'word': w, 'level': lv} for w, lv in sorted(words.items())]
json.dump(out, open('kaogang.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

from collections import Counter
c = Counter(x['level'] for x in out)
print('原始行数', len(entries))
print('拆分后唯一词', len(out))
print('分级:', dict(c))
print('首 10:', [x['word'] for x in out[:10]])
print('末 10:', [x['word'] for x in out[-10:]])
