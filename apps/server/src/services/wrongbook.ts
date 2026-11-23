import type { QuestionCard } from '@tutor/shared';
import { fingerprint as makeFingerprint, sha256Hex } from '../lib/crypto';
import { formatDate } from '../lib/text';
import { badRequest } from '../lib/errors';
import { logger } from '../lib/logger';
import * as questionRepo from '../repos/questions';
import * as variantRepo from '../repos/variants';
import * as attemptRepo from '../repos/attempts';
import { listWhitelist } from '../repos/meta';

/** 解析后的单张错题卡：字段兼容 JSON/Markdown 两种来源 */
export interface ImportCard {
  id?: string;
  subject?: string;
  chapter?: string;
  kpCodes: string[];
  kpLevels?: string[];
  questionType: string;
  title?: string;
  textBody: string;
  options?: string[] | null;
  answer?: string | null;
  solution?: string | null;
  note?: string | null;
  tags?: string[];
  no?: string;
  fingerprint?: string;
  status?: string;
  source?: string;
  schemaVersion?: number;
  createdAt?: string | null;
  meta?: Record<string, unknown>;
  variantSets?: {
    setId: string;
    createdAt?: string | null;
    items: {
      level: string;
      stem: string;
      answer: string;
      solution: string;
      kpCodes: string[];
      targetTrap?: string | null;
    }[];
  }[];
  attempts?: { answer?: string | null; verdict?: string | null; source?: string; at?: string | null }[];
}

/** 导入统计：成功、跳过、失败、警告 */
export interface ImportResult {
  imported: { id: string; action: 'created' | 'updated'; text: string }[];
  skipped: { id?: string; reason: string; text: string }[];
  errors: { text: string; reason: string }[];
  warnings: string[];
}

/** 导入字段别名表：兼容下划线/驼峰/中文等多种列名 */
const FIELD_ALIASES = {
  textBody: [
    'text_body', 'textBody', 'text_latex', 'textLatex', 'question', 'stem',
    '题目', '题干', '原题', '原句', '英文原题',
  ],
  passage: ['passage', '原文', '材料', '阅读材料'],
  chapter: ['chapter', '章节'],
  kpCodes: ['kp_codes', 'kpCodes', '考点', '考点编号'],
  questionType: ['question_type', 'questionType', '类型', '题型'],
  answer: ['answer', '答案'],
  solution: ['solution', 'analysis', '解析'],
  note: ['note', 'remark', '备注', '错因'],
  title: ['title', '标题'],
  options: ['options', '选项'],
} as const;

/**
 * 按科目取「没有显式题型时」的默认题型：有选项一律选择题；
 * 无选项时英语=翻译题（英语错题只有选择题与翻译题两种）、数学=计算题、计算机=填空题。
 * @param subject 科目代码
 * @param hasOptions 是否带选项
 * @returns 默认题型
 */
function defaultQuestionType(subject: string, hasOptions: boolean): string {
  if (hasOptions) return '选择题';
  if (subject === 'english') return '翻译题';
  return subject === 'math' ? '计算题' : '填空题';
}

/**
 * 入库前统一题型：英语只允许「选择题 / 翻译题」，AI 误写填空题、写作题时按有无选项纠正；
 * 其它科目保留原值，缺失时按 defaultQuestionType 兜底。
 * @param subject 科目代码
 * @param type 原始题型
 * @param hasOptions 是否带选项
 * @returns 规范化后的题型
 */
function normalizeQuestionType(subject: string, type: string, hasOptions: boolean): string {
  const value = (type ?? '').trim();
  if (subject === 'english') {
    return value === '选择题' || value === '翻译题' ? value : defaultQuestionType(subject, hasOptions);
  }
  return value || defaultQuestionType(subject, hasOptions);
}

/**
 * 把阅读材料折进题干：按引用块（> 前缀）放在最前面，前端渲染成引用样式，
 * 与题目本身分得开，同时保证指纹、搜索、答疑上下文都能带上材料。
 * @param passage 原文/材料（英语阅读、完形用，可多段）
 * @param question 题目正文
 * @returns 合并后的题干
 */
function foldPassage(passage: string | undefined, question: string): string {
  const text = (passage ?? '').trim();
  if (!text) return question;
  const quoted = text
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
  return `${quoted}\n\n${question}`;
}

/** 按别名顺序取第一个非空值 */
function pick(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') return raw[key];
  }
  return undefined;
}

/** 任意值转字符串（null/undefined 视为空） */
function asString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/** 任意值转字符串数组：数组逐项转字符串，字符串按分隔符切分 */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim().length > 0);
  if (typeof v === 'string') {
    return v
      .split(/[,，、;；\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

/** 把一条 JSON 记录按字段别名规整为 ImportCard，并透传变式组与作答历史 */
function normalizeJsonCard(raw: Record<string, unknown>, defaultSubject: string): ImportCard {
  const textBody = asString(pick(raw, FIELD_ALIASES.textBody)).trim();
  const optionsRaw = pick(raw, FIELD_ALIASES.options);
  let options: string[] | null = null;
  if (Array.isArray(optionsRaw)) {
    options = optionsRaw.map((o) => asString(o));
  } else if (typeof optionsRaw === 'string' && optionsRaw.trim()) {
    options = parseOptions(optionsRaw);
  }
  const kpCodes = asStringArray(pick(raw, FIELD_ALIASES.kpCodes));
  const rawTextBody = asString(pick(raw, FIELD_ALIASES.textBody)).trim();
  const passage = asString(pick(raw, FIELD_ALIASES.passage));
  return {
    id: raw.id !== undefined ? asString(raw.id) : undefined,
    subject: raw.subject !== undefined ? asString(raw.subject) : defaultSubject,
    chapter: asString(pick(raw, FIELD_ALIASES.chapter)),
    kpCodes,
    kpLevels: asStringArray(raw.kp_levels ?? raw.kpLevels),
    questionType:
      asString(pick(raw, FIELD_ALIASES.questionType)) ||
      defaultQuestionType(defaultSubject, !!options),
    title: asString(pick(raw, FIELD_ALIASES.title)),
    textBody: foldPassage(passage, rawTextBody),
    options,
    answer: asString(pick(raw, FIELD_ALIASES.answer)),
    solution: asString(pick(raw, FIELD_ALIASES.solution)),
    note: asString(pick(raw, FIELD_ALIASES.note)),
    tags: asStringArray(raw.tags),
    no: asString(raw.no),
    fingerprint: raw.fingerprint !== undefined ? asString(raw.fingerprint) : undefined,
    status: raw.status !== undefined ? asString(raw.status) : undefined,
    source: raw.source !== undefined ? asString(raw.source) : undefined,
    schemaVersion: typeof raw.schema_version === 'number' ? raw.schema_version : undefined,
    createdAt: raw.created_at ? asString(raw.created_at) : null,
    meta: {
      ...(raw.chapter_confirm !== undefined ? { chapter_confirm: raw.chapter_confirm } : {}),
      ...(raw.chapter_auto_guess !== undefined ? { chapter_auto_guess: raw.chapter_auto_guess } : {}),
      ...(raw.active_chapter !== undefined ? { active_chapter: raw.active_chapter } : {}),
      ...(raw.dup_forced !== undefined ? { dup_forced: raw.dup_forced } : {}),
      ...(typeof raw.meta === 'object' && raw.meta ? (raw.meta as Record<string, unknown>) : {}),
    },
    variantSets: Array.isArray(raw.variant_sets)
      ? (raw.variant_sets as any[]).map((set) => ({
          setId: asString(set.set_id ?? set.setId ?? 'V1'),
          createdAt: set.created_at ? asString(set.created_at) : null,
          items: Array.isArray(set.items)
            ? set.items.map((item: any) => ({
                level: asString(item.level),
                stem: asString(item.stem),
                answer: asString(item.answer),
                solution: asString(item.solution),
                kpCodes: asStringArray(item.kp_codes ?? item.kpCodes),
                targetTrap: item.target_trap ? asString(item.target_trap) : null,
              }))
            : [],
        }))
      : undefined,
    attempts: Array.isArray(raw.attempts)
      ? (raw.attempts as any[]).map((a) => ({
          answer: a.answer ? asString(a.answer) : null,
          verdict: a.verdict ? asString(a.verdict) : null,
          source: a.source ? asString(a.source) : 'practice',
          at: a.at ? asString(a.at) : null,
        }))
      : undefined,
  };
}

/**
 * 解析选项文本：优先按 A./B. 等字母标记切分，不足 2 项则按多空格或换行切分。
 * @param text 选项原文
 * @returns 选项数组
 */
export function parseOptions(text: string): string[] {
  const cleaned = text.replace(/\r?\n/g, ' ').trim();
  const matches = [...cleaned.matchAll(/(?:^|\s)([A-F])[.、．)]\s*/g)];
  if (matches.length < 2) {
    return cleaned
      .split(/\s{2,}|\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const out: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? cleaned.length : cleaned.length;
    out.push(cleaned.slice(start, end).trim());
  }
  return out;
}

/**
 * 解析 Markdown 错题集（支持「### 错题 001：标题」+「**题目**：」格式）。
 * @param content Markdown 原文
 * @param defaultSubject 默认科目
 * @returns 错题卡数组
 */
export function parseMarkdown(content: string, defaultSubject: string): ImportCard[] {
  const cards: ImportCard[] = [];
  const sectionRe = /^###\s*(?:错题\s*)?(\d+)?[：:.、\s]*(.*)$/gm;
  const starts: { index: number; no: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(content)) !== null) {
    starts.push({ index: m.index, no: m[1] ?? '', title: (m[2] ?? '').trim() });
  }

  // 「【已整理断点」是学生粘进来的分批标记（AI 会话里防止重复统计用的），字段到此终止、整行丢弃
  const fieldRe =
    /^[ \t]*(?:[*\-+]\s*)?\*\*(题目|题干|原题|原句|原文|材料|阅读材料|解析|答案|备注|错因|选项|考点|章节|类型|题型|标题)\*\*[：:]\s*([\s\S]*?)(?=^[ \t]*(?:[*\-+]\s*)?\*\*(?:题目|题干|原题|原句|原文|材料|阅读材料|解析|答案|备注|错因|选项|考点|章节|类型|题型|标题)\*\*[：:]|^###\s|^【已整理|(?![\s\S]))/gm;

  const blocks = starts.length > 0
    ? starts.map((s, i) => ({
        no: s.no,
        title: s.title,
        text: content.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : content.length),
      }))
    : [{ no: '', title: '', text: content }];

  for (const block of blocks) {
    const fields: Record<string, string> = {};
    fieldRe.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(block.text)) !== null) {
      fields[fm[1]] = (fm[2] ?? '').trim().replace(/\n{2,}/g, '\n');
    }
    const questionText = (fields['题目'] || fields['题干'] || fields['原题'] || fields['原句'] || '').trim();
    if (!questionText) continue;
    const optionsText = fields['选项'] ?? '';
    const options = optionsText ? parseOptions(optionsText) : null;
    // 容忍模型写成「E1.9 定语从句」「3.1（罗尔定理）」这类带名称/括号的写法：截出编号再校验
    const kpCodes = asStringArray(fields['考点'] ?? '')
      .map((c) => /^([A-Za-z]?\d+(?:\.\d+)+)/.exec(c.trim())?.[1] ?? c.trim())
      .filter((c) => /^[A-Za-z]?\d+(?:\.\d+)+$/.test(c));
    const passage = fields['原文'] ?? fields['材料'] ?? fields['阅读材料'] ?? '';
    const questionType =
      (fields['类型'] || fields['题型'] || defaultQuestionType(defaultSubject, !!options))
        .split('\n')[0]
        .trim()
        .slice(0, 20);
    cards.push({
      subject: defaultSubject,
      chapter: fields['章节'] ?? '',
      kpCodes,
      questionType,
      title: fields['标题'] || block.title || '',
      textBody: foldPassage(passage, questionText),
      options,
      answer: fields['答案'] ?? '',
      solution: fields['解析'] ?? '',
      note: fields['备注'] ?? fields['错因'] ?? '',
      no: block.no,
      tags: [],
      source: 'md',
    });
  }
  return cards;
}

/**
 * 按内容格式自动选择解析器：JSON（对象/数组/questions/items/cards）走 JSON 规整，否则走 Markdown。
 * @param content 导入原文
 * @param defaultSubject 默认科目
 * @returns 错题卡数组
 */
export function parseImportContent(content: string, defaultSubject: string): ImportCard[] {
  const text = content.trim();
  if (!text) throw badRequest('导入内容不能为空');
  if (text.startsWith('{') || text.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw badRequest(`JSON 解析失败：${(err as Error).message}`);
    }
    let list: unknown[] = [];
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.questions)) list = obj.questions;
      else if (Array.isArray(obj.items)) list = obj.items;
      else if (Array.isArray(obj.cards)) list = obj.cards;
      else list = [obj];
    }
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => normalizeJsonCard(x, defaultSubject));
  }
  return parseMarkdown(text, defaultSubject);
}

/** 导入选项：科目、是否覆盖、来源、是否迁移关系、是否允许同指纹不同 id 共存 */
export interface ImportOptions {
  subject: string;
  force?: boolean;
  source?: string;
  migrateRelations?: boolean;
  /** 迁移源数据时使用：允许相同指纹但不同 id 的卡片同时存在（源数据真实重复） */
  allowDuplicateFingerprint?: boolean;
}

/**
 * 批量入库：逐卡校验考点白名单、按指纹判重（force 可覆盖、allowDuplicateFingerprint 可保留源重复），
 * 新建题在 migrateRelations 时连带迁移变式组与作答历史。单卡失败不影响其余卡。
 * @param cards 错题卡数组
 * @param options 导入选项
 * @returns 成功/跳过/失败/警告统计
 */
export async function importCards(cards: ImportCard[], options: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [], errors: [], warnings: [] };
  const whitelist = await listWhitelist(options.subject);
  const kpMap = new Map(whitelist.map((w) => [w.kp_code, w]));
  const allSubjects = new Set(['math', 'english', 'cs']);
  const today = formatDate(new Date());

  for (const card of cards) {
    try {
      const subject = card.subject && allSubjects.has(card.subject) ? card.subject : options.subject;
      const subjectWhitelist = subject === options.subject ? whitelist : await listWhitelist(subject);
      const subjectKpMap = new Map(subjectWhitelist.map((w) => [w.kp_code, w]));

      const textBody = (card.textBody ?? '').trim();
      if (!textBody) {
        result.errors.push({ text: '', reason: '题目正文为空' });
        continue;
      }
      const kpCodes = card.kpCodes.filter((c) => subjectKpMap.has(c));
      const invalidKp = card.kpCodes.filter((c) => !subjectKpMap.has(c));
      if (invalidKp.length > 0) {
        result.warnings.push(`考点 ${invalidKp.join('、')} 不在 ${subject} 考纲白名单中，已忽略`);
      }
      const kpLevels =
        card.kpLevels && card.kpLevels.length > 0
          ? card.kpLevels
          : kpCodes.map((c) => subjectKpMap.get(c)?.level ?? '');
      const chapter =
        card.chapter ||
        (kpCodes[0] ? subjectKpMap.get(kpCodes[0])?.chapter ?? '' : '') ||
        '导入错题';
      const fp = card.fingerprint || makeFingerprint(textBody);
      const existing = await questionRepo.findByFingerprint(subject, fp);

      const payload: questionRepo.InsertQuestionInput = {
        id: '',
        subject,
        chapter,
        kpCodes,
        kpLevels,
        questionType: normalizeQuestionType(subject, card.questionType, (card.options ?? []).length > 0),
        title: card.title ?? '',
        textBody,
        options: card.options ?? null,
        answer: card.answer ?? null,
        solution: card.solution ?? null,
        note: card.note ?? null,
        tags: card.tags ?? [],
        no: card.no ?? '',
        fingerprint: fp,
        status: card.status || '待变式',
        source: card.source || options.source || 'import',
        schemaVersion: card.schemaVersion ?? 3,
        meta: card.meta ?? {},
        createdAt: card.createdAt ?? null,
      };

      let questionId: string;
      let action: 'created' | 'updated';

      const duplicateButDifferentId =
        existing && options.allowDuplicateFingerprint && card.id && existing.id !== card.id;

      if (existing && !duplicateButDifferentId) {
        if (!options.force) {
          result.skipped.push({
            id: existing.id,
            reason: `该题已于 ${existing.created_at.toISOString().slice(0, 16).replace('T', ' ')} 录入`,
            text: textBody,
          });
          continue;
        }
        await questionRepo.updateQuestionContent(existing.id, payload);
        questionId = existing.id;
        action = 'updated';
      } else {
        let id = card.id?.trim();
        if (id) {
          const collision = await questionRepo.getQuestionRow(id);
          if (collision) {
            if (!options.force) {
              result.skipped.push({ id, reason: '题目 ID 已存在且指纹不同', text: textBody });
              continue;
            }
            await questionRepo.updateQuestionContent(id, payload);
            questionId = id;
            action = 'updated';
          } else {
            payload.id = id;
            const row = await questionRepo.insertQuestion(payload);
            questionId = row.id;
            action = 'created';
          }
        } else {
          const prefix = `Q-${today.replace(/-/g, '')}-`;
          id = await questionRepo.nextQuestionId(prefix);
          payload.id = id;
          const row = await questionRepo.insertQuestion(payload);
          questionId = row.id;
          action = 'created';
        }
      }

      if (options.migrateRelations && action === 'created') {
        for (const set of card.variantSets ?? []) {
          if (!set.items || set.items.length === 0) continue;
          const items = set.items
            .filter((it) => it.stem && it.answer && it.solution)
            .map((it) => ({
              level: it.level || 'L1',
              stem: it.stem,
              answer: it.answer,
              solution: it.solution,
              kpCodes: it.kpCodes.length > 0 ? it.kpCodes.filter((c) => subjectKpMap.has(c)) : kpCodes,
              targetTrap: it.targetTrap ?? null,
              createdAt: set.createdAt ?? null,
            }));
          if (items.length > 0) {
            await variantRepo.insertVariantSet(questionId, set.setId || 'V1', items);
          }
        }
        for (const attempt of card.attempts ?? []) {
          await attemptRepo.insertAttempt({
            questionId,
            subject,
            answer: attempt.answer ?? '',
            verdict: attempt.verdict ?? 'self_partial',
            source: attempt.source || 'practice',
            at: attempt.at ?? null,
          });
        }
      }

      result.imported.push({ id: questionId, action, text: textBody });
    } catch (err) {
      logger.warn({ event: 'import.card_failed', err: (err as Error).message }, '[wrongbook] import failed');
      result.errors.push({ text: (card.textBody ?? '').slice(0, 80), reason: (err as Error).message });
    }
  }

  // 去重 warnings
  result.warnings = [...new Set(result.warnings)];
  return result;
}

/**
 * 读取错题详情：题目本体 + 变式 + 按变式组 id 聚合的变式组 + 作答记录。
 * @param id 错题 id
 * @returns 详情，题目不存在返回 null
 */
export async function getQuestionDetail(id: string): Promise<{
  question: QuestionCard;
  variants: Awaited<ReturnType<typeof variantRepo.listVariants>>;
  variantSets: { setId: string; createdAt: string; items: any[] }[];
  attempts: Awaited<ReturnType<typeof attemptRepo.listAttempts>>;
} | null> {
  const question = await questionRepo.getQuestionById(id);
  if (!question) return null;
  const variants = await variantRepo.listVariants(id);
  const attempts = await attemptRepo.listAttempts(id);
  const setMap = new Map<string, { setId: string; createdAt: string; items: any[] }>();
  for (const v of variants) {
    if (!setMap.has(v.setId)) {
      setMap.set(v.setId, { setId: v.setId, createdAt: v.createdAt, items: [] });
    }
    setMap.get(v.setId)!.items.push(v);
  }
  return {
    question,
    variants,
    variantSets: [...setMap.values()].sort((a, b) => (a.setId < b.setId ? -1 : 1)),
    attempts,
  };
}

/** 生成导入内容的短签名（SHA-256 前 16 位），用于判断是否重复导入 */
export function importSignature(content: string): string {
  return sha256Hex(content).slice(0, 16);
}
