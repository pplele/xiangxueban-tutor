import type { z } from 'zod';
import { validationError } from './errors';

/**
 * 用 zod schema 校验输入数据，失败时抛出带字段详情的 validationError。
 * @param schema zod 校验 schema
 * @param data 待校验的原始数据
 * @returns 校验通过并推断类型后的数据
 * @throws 参数不合法时抛出 400 VALIDATION_ERROR
 */
export function parseInput<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      details[key] = issue.message;
    }
    throw validationError('请求参数不合法', details);
  }
  return result.data;
}
