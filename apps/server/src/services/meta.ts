import { SUBJECTS, type SubjectWithChapters } from '@tutor/shared';
import { listChapters } from '../repos/meta';
import { stats } from '../repos/questions';

/** 提取编码中的数字序列作为自然排序键；无数字时排到最后 */
function naturalKey(code: string): number[] {
  const nums = code.match(/\d+/g);
  return nums ? nums.map(Number) : [Number.MAX_SAFE_INTEGER];
}

/** 按数字段逐位比较编码（如 1.10 排在 1.2 之后），相同则按中文 locale 比较 */
function compareNatural(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const va = ka[i] ?? 0;
    const vb = kb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return a.localeCompare(b, 'zh-CN');
}

/**
 * 组装科目字典：合并考纲章节与错题中实际出现的章节，并对章节做自然排序。
 * @returns 每个科目附带章节列表（含知识点数、错题数）
 */
export async function listSubjects(): Promise<SubjectWithChapters[]> {
  const chapterRows = await listChapters();
  const result: SubjectWithChapters[] = [];
  for (const subject of SUBJECTS) {
    const questionStats = await stats(subject.code);
    const counts = new Map(questionStats.chapters.map((c) => [c.chapter, c.count]));
    const chapters = chapterRows
      .filter((c) => c.subject === subject.code)
      .sort((a, b) => compareNatural(a.firstCode, b.firstCode))
      .map((c) => ({
        name: c.chapter,
        kpCount: c.kpCount,
        questionCount: counts.get(c.chapter) ?? 0,
      }));
    // 错题里存在但考纲没有的章节（如「试卷错题」）也要展示
    for (const [name, count] of counts) {
      if (!chapters.some((c) => c.name === name)) {
        chapters.push({ name, kpCount: 0, questionCount: count });
      }
    }
    result.push({ ...subject, chapters });
  }
  return result;
}
