# 单词表构建流程（从扫描 PDF 到入库）

数据源：`F:\kukebook\送分笔记 英语阅读.pdf`（66 页、2-up 拼版扫描件，无文字层，只能走 OCR）。

## 四步

```bash
# 1. 抽取每个书页并切左右两栏（输出 F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/pages/sXXX-L1.jpg 等 256 张）
python scripts/vocab/_vocab_extract.py

# 2. 逐栏视觉模型识别（可断点续跑：已有 json 会跳过；输出 F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/ocr/）
npx tsx scripts/vocab/_vocab_ocr.ts

# 2.5 修正解析缺陷后重解 raw（不重新调模型，改了 parse 规则才需要跑）
npx tsx scripts/vocab/_vocab_reparse.ts

# 3. 合并：按页脚页码排序、页内去重、清洗音标/释义（输出 F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/vocab.json）
npx tsx scripts/vocab/_vocab_build.ts

# 4. 入库（按 lower(word) 幂等 upsert，可重复跑）
npx tsx scripts/vocab/_vocab_import.ts
```

## 关键坑（都踩过）

1. **PDF 里有成对的重复扫描页**。256 张栏图里有一半是镜像副本：`s(n)` 与 `s(69-n)` 像素完全一致
   （如 s003=s066、s004=s065、s034=s035）。**这是正常的**，不是切图错误——
   全书 62 页，66 个 PDF 页里约 33 页是另一份副本。去重交给第 3 步，别手工删图。
   判断两张图是否同一张：`md5sum s003-R2.jpg s066-R2.jpg`。
2. **一纸左右两侧的页码可以相差很远**（s008 的左页是第 4 页、右页是第 57 页），
   这是印张拼版方式决定的，所以第 3 步必须按页脚页码排序，不能按纸序。
3. **模型会漏读页码数字**：58 读成 5、57 读成 7。同一纸侧两栏页码不一致就说明漏读了，
   表现为 `_vocab_build.ts` 报「缺页码」。修法：把小的那个改成大的（十位/个位对得上就是漏读）。
4. **`word | [ipa] | 释义` 三段的 raw 会让释义残留开头的竖线**，`_vocab_ocr.ts` 的 parse
   已加 `rest.replace(/^[\s|｜]+/, '')`；历史 json 用 `_vocab_reparse.ts` 重解即可（不花钱）。
5. 视觉模型单次输出上限 2048 tokens，所以按「栏」切图，一栏约 20~25 条，正好放得下。
   **免费档 `glm-4v-flash` 不能用**：max_tokens 硬上限 1024，一栏必被截断；且不守 `|` 格式。
6. 免费文本档 `glm-4-flash` 支持 function calling，可作为主通道欠费时的兜底（见 `.env` 的 `LLM_FALLBACK_*`）。

## 当前状态

- 库内 **3636 条** = **单词 3035**（与考纲 3040 词 100% 对应）+ **短语 601**。
- 考纲 3000 词本身不含短语，但固定搭配在词汇语法选择、完形填空里高频，所以短语单独保留在库里：
  默认不参与测试（页面「连短语一起测」开关默认关），勾上才加进本轮。
- **超纲的单词已清理**（曾达 4835 条）。完整备份表：`vocab_words_bak_20261117`。
  清理时注意 `insight`（名词）与 `in sight`（短语）去空格后同形，靠去空格比对会漏删后者。
- 短语从备份恢复时做了两道清洗（规则见下），601 条均为可用条目。

## 对齐考纲（补齐缺词的正确做法）

湖南专升本英语考纲原文：**"掌握《高等职业教育专科英语课程标准：2021年版》所收词汇 3000 个"**。
2024/2025/2026 三年考纲一致，2027 沿用。

> 注意：网上常说的「4500 词」是**大学英语四级**的要求，不是专升本。专升本 3000 词即可。

两步：

```bash
# 1. 下载教育部官方课程标准 PDF（附录即 3000 词表，有文字层，不必 OCR）
curl -sL -o F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/kc.pdf \
  "https://www.moe.gov.cn/srcsite/A07/moe_737/s3876_qt/202104/W020210409562365459062.pdf"

# 2. 提取词表 → 与库比对 → 抓音标释义 → 增量入库
python F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/extract.py        # 输出 kaogang.json（约 3040 词，含 base/basic/ext 分级）
npx tsx scripts/vocab/_vocab_compare_kaogang.ts   # 输出 miss.json（库中缺失的考纲词）
npx tsx scripts/vocab/_vocab_fetch_dict.ts F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/miss.json F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/fetched.json
npx tsx scripts/vocab/_vocab_import.ts F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/fetched.json --append
```

### 抓取词典的要点（`_vocab_fetch_dict.ts`）

- 数据源：有道 `dict.youdao.com/jsonapi?q=词`，**无需 key**，返回真人词典数据。
  音标取 `ec.word[0].usphone`，释义取 `ec.word[0].trs[i].tr[0].l.i[0]`。
- 并发 4 + 每请求 250ms 间隔，1018 词约 80 秒，未触发限流；失败自动重试 3 次。
- 释义要清洗：丢掉 `【名】（英）埃布尔` 这类人名条目，每个词性只留 2 个义项、压到 70 字内。
- 缩写容易取错义项（`ai` 会返回「三趾树懒」），缩写条目需人工核对。
- 可断点续跑：已抓到的词按 word 去重跳过。

### 提取词表的坑

- PDF 里 `AI/artificial intelligence`、`ATM/Automatic Teller Machine` 会被**断成两行**，
  `personal computer` 还会粘成 `co mputer`。这几条按缩写形式（ai / atm / pc / pe / iot）入库更实用。
- 斜杠并列形式要拆开：`actor/actress` → actor + actress，`a/an` → a + an。

### 短语从备份恢复时的清洗

书本 OCR 来的短语有两类脏数据，恢复前必须处理（否则卡片和弹窗都会显示异常）：

1. **`-｜` 前缀**：144 条的释义写成 `-｜考虑到，顾及`，用 `^[-—–]\s*[｜|]\s*` 去掉。
2. **例句混入**：`My shoes are worn out | 我的鞋子穿破了。` 这类整句被当成词条。
   判定规则：**首字母大写 且 4 词以上**（`Summer Palace` 只有 2 词，不会被误杀）。
   633 条里剔掉 31 条，剩 602 条。
3. **单词被误判成短语**：`behaviour (u)` 带不可数标记，因含空格被当成 phrase。改回 word。
4. 另有 5 条与考纲词重复，插入时跳过。

