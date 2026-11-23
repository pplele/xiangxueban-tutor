import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describeImage as describeImageRaw } from '../agent/llm';
import { badRequest, conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { parseLooseJson } from '../lib/json';
import * as examRepo from '../repos/exams';

/**
 * 上传图片落盘目录（gitignore 已排除）：多候选定位 data/exam-uploads，再拼上试卷 id 子目录。
 * @param examId 试卷 id
 */
function uploadDir(examId: string): string {
  const candidates = [
    path.resolve(process.cwd(), 'data/exam-uploads'),
    path.resolve(process.cwd(), '../data/exam-uploads'),
    path.resolve(process.cwd(), '../../data/exam-uploads'),
    path.resolve(__dirname, '../../../data/exam-uploads'),
  ];
  const base = candidates.find((p) => fs.existsSync(path.dirname(p))) ?? candidates[0];
  return path.join(base, examId);
}

/**
 * 校验文件名（仅 jpg/jpeg 且无路径穿越）并拼出答题卡照片绝对路径。
 * @param examId 试卷 id
 * @param file 文件名
 * @returns 照片绝对路径
 */
export function uploadFilePath(examId: string, file: string): string {
  if (!/^[\w-]+\.jpe?g$/i.test(file)) throw badRequest('非法文件名');
  const dir = uploadDir(examId);
  const full = path.join(dir, file);
  if (!full.startsWith(dir)) throw badRequest('非法路径');
  return full;
}

/**
 * 删除试卷时清理该卷的答题卡照片目录（仅限该卷 UUID 目录）。
 * @param examId 试卷 UUID
 */
export async function removeExamUploads(examId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(examId)) {
    throw badRequest('非法试卷编号');
  }
  await fsp.rm(uploadDir(examId), { recursive: true, force: true });
}

/** 答题卡上传入参：区块（填空/解答）、题号、图片 dataURL */
export interface UploadInput {
  section: 'blank' | 'solve';
  questionNo?: number | null;
  image: string;
}

/** 上传结果：上传记录、填空识别出的答案、视觉识别是否失败 */
export interface UploadResult {
  upload: examRepo.ExamUpload;
  /** 填空题照片识别出的 { 题号: 答案 }，已写回自动保存的作答 */
  blankAnswers: Record<string, { answer?: string; selfRating?: string | null }>;
  /** 视觉识别失败（外部服务波动）：照片已保存、ocrText 为空，需学生手动输入/自评 */
  ocrFailed: boolean;
}

/**
 * 视觉识别降级包装：外部视觉服务波动（限流/网络/格式被拒）时返回空文本而不是抛错，
 * 照片已落盘仍写入 uploads，学生可手动填写/自评（见 finalize 兜底链）。
 */
async function describeImage(...args: Parameters<typeof describeImageRaw>): Promise<string> {
  try {
    return await describeImageRaw(...args);
  } catch (err) {
    logger.warn(
      { event: 'exam.ocr_failed', err: String(err) },
      '[exam] vision OCR failed, keep photo with empty ocrText for manual input',
    );
    return '';
  }
}

/**
 * 答题卡照片上传：校验试卷状态与题号 → 图片落盘 → 视觉识别
 * （填空按题号提取答案写回自动保存作答；解答题转录手写过程）→ 更新 uploads。
 * 填空区/解答题每题只保留最新一张照片。
 * @param examId 试卷 id
 * @param input 上传入参
 * @returns 上传记录、识别出的填空答案、识别是否失败
 */
export async function saveExamUpload(examId: string, input: UploadInput): Promise<UploadResult> {
  const row = await examRepo.getExam(examId);
  if (!row) throw notFound('模拟卷不存在');
  if (row.submitted_at) throw conflict('已交卷，不能再上传');

  const items = Array.isArray(row.items) ? row.items : [];
  const blankItems = items.filter((it) => it.questionType === '填空题');
  const solveItems = items.filter((it) => it.questionType === '计算题' || it.questionType === '证明题' || it.questionType === '应用题');

  let questionId: string | null = null;
  let questionNo = 0;
  if (input.section === 'blank') {
    if (blankItems.length === 0) throw badRequest('本卷没有填空题');
  } else {
    if (solveItems.length === 0) throw badRequest('本卷没有解答题');
    if (!input.questionNo) throw badRequest('解答题上传必须带 questionNo');
    const target = items.find((it) => it.no === input.questionNo);
    if (!target || !solveItems.includes(target)) throw badRequest(`第 ${input.questionNo} 题不是解答题`);
    questionId = target.questionId;
    questionNo = target.no;
  }

  const m = /^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i.exec(input.image.trim());
  if (!m) throw badRequest('只支持 PNG / JPG / WEBP 图片');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw badRequest('图片内容为空');
  if (buf.length > 2 * 1024 * 1024) throw badRequest('图片超过 2MB，前端请压缩后上传');

  // 落盘
  const dir = uploadDir(examId);
  await fsp.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = `${id}.jpg`;
  await fsp.writeFile(path.join(dir, file), buf);

  // 识别
  let ocrText = '';
  const blankAnswers: Record<string, { answer?: string }> = {};
  if (input.section === 'blank') {
    const nos = blankItems.map((it) => it.no);
    ocrText = await describeImage(
      input.image,
      [
        '这是学生在答题纸上写的填空题作答区照片。请按题号提取每题的最终答案。',
        `本卷填空题题号是：${nos.join('、')}。`,
        '只提取每题最终答案（等号右边的结果），不要过程。',
        '数学表达式用 LaTeX（如 \\frac{1}{2}、x^2）；纯数字直接写数字。',
        `输出 JSON：{"13": "答案或null", "14": "..."}，键只允许 ${nos.join('、')}，题号不在这张照片里就不写该键。`,
        '看不清的写 null。不输出 JSON 以外的任何文字。',
      ].join('\n'),
      { maxTokens: 900, temperature: 0 },
    );
    const parsed = ocrText ? parseLooseJson(ocrText) : null;
    if (parsed && typeof parsed === 'object') {
      for (const it of blankItems) {
        const v = (parsed as Record<string, unknown>)[String(it.no)];
        if (typeof v === 'string' && v.trim() && v.trim() !== 'null') {
          blankAnswers[it.questionId] = { answer: v.trim() };
        }
      }
    }
    // 写回自动保存的作答（识别结果可被学生在网页上修改，修改也会自动保存）
    if (Object.keys(blankAnswers).length > 0) {
      const answers = { ...(row.answers ?? {}) };
      for (const [qid, v] of Object.entries(blankAnswers)) {
        const prev = answers[qid] ?? {};
        answers[qid] = { ...prev, answer: v.answer };
      }
      await examRepo.saveAnswers(examId, answers);
    }
  } else {
    const target = items.find((it) => it.no === questionNo)!;
    ocrText = await describeImage(
      input.image,
      [
        `这是学生手写的第 ${questionNo} 题解答过程照片。请把解答过程完整转录成文本。`,
        '题目内容：' + (target.stem ?? '').slice(0, 600),
        '要求：',
        '1. 逐行转录学生写的步骤，保留原始顺序，不要替学生补步骤、不要纠错。',
        '2. 数学表达式用 LaTeX。',
        '3. 看不清的字用 □ 占位。',
        '4. 直接输出转录文本，不要任何解释或 JSON。',
      ].join('\n'),
      { maxTokens: 2200, temperature: 0 },
    );
  }

  const upload: examRepo.ExamUpload = {
    id,
    section: input.section,
    questionNo,
    questionId,
    file,
    ocrText,
    createdAt: new Date().toISOString(),
  };
  const uploads = Array.isArray(row.uploads) ? [...row.uploads] : [];
  if (input.section === 'blank') {
    // 填空区只保留最新一张（重拍就替换）
    await examRepo.saveUploads(examId, [upload, ...uploads.filter((u) => u.section !== 'blank')]);
  } else {
    // 解答题每题只保留最新一张
    await examRepo.saveUploads(examId, [upload, ...uploads.filter((u) => !(u.section === 'solve' && u.questionNo === questionNo))]);
  }

  logger.info({ examId, section: input.section, questionNo, uploadId: id }, '[exam] upload saved');
  return { upload, blankAnswers, ocrFailed: !ocrText.trim() };
}
