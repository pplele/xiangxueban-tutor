import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { matchWrong, recognizeQuestion, saveWrong } from '../services/capture';

const subjectEnum = z.enum(['math', 'english', 'cs']);

const ocrSchema = z.object({
  /** 图片 base64，允许带 data:image/...;base64, 前缀；前端压缩后一般 100–400KB */
  image: z.string().min(100).max(2 * 1024 * 1024),
  subject: subjectEnum.optional(),
});

const matchSchema = z.object({
  subject: subjectEnum,
  textBody: z.string().min(4).max(4000),
});

const saveSchema = z.object({
  subject: subjectEnum,
  textBody: z.string().min(4).max(4000),
  solution: z.string().max(8000).optional(),
  note: z.string().max(4000).optional(),
  kpCodes: z.array(z.string().max(20)).max(6).optional(),
  chapter: z.string().max(80).optional(),
  imageUrl: z.string().max(500).optional(),
  title: z.string().max(120).optional(),
});

/**
 * 拍题录入路由注册：OCR 识别 / 错题查重 / 错题沉淀
 */
export async function captureRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /capture/ocr - 拍照识别题干文本（LLM+视觉），返回前不落库，由用户确认后再提问/入库；鉴权：需登录
   */
  app.post('/capture/ocr', async (request) => {
    const body = parseInput(ocrSchema, request.body);
    const result = await recognizeQuestion(body.image, body.subject ?? 'math');
    return result;
  });

  /** POST /capture/wrong-match - 错题查重：指纹精确匹配 + 向量近似匹配，返回候选错题；鉴权：需登录 */
  app.post('/capture/wrong-match', async (request) => {
    const body = parseInput(matchSchema, request.body);
    return matchWrong(body.subject, body.textBody);
  });

  /** POST /capture/wrong-save - 学懂后沉淀为错题：保存题目 / 解析 / 备注 / 知识点等；鉴权：需登录 */
  app.post('/capture/wrong-save', async (request) => {
    const body = parseInput(saveSchema, request.body);
    return saveWrong(body);
  });
}
