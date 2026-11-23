export interface TeacherCard {
  identity: string;
  /** 完整人格设定（语气、节奏、口头禅），按原文高优先级注入 */
  voiceDirective?: string;
  teachingBeliefs: string[];
  teachingMethods: string[];
  failuresLessons: string[];
  boundaries: string[];
}

/**
 * 把教师素描卡渲染为注入 Prompt 的 Markdown 文本块。
 * @param card 教师人格/教学风格配置
 * @returns 可拼入系统提示词的字符串
 */
export function renderTeacherCard(card: TeacherCard): string {
  const list = (arr: string[]) => arr.map((x) => `- ${x}`).join('\n');
  return [
    '## 当前科目教师素描卡',
    `**身份**：${card.identity}`,
    ...(card.voiceDirective
      ? ['**语气与表达风格（高优先级，但不得覆盖全局硬规则）**：', card.voiceDirective]
      : []),
    '**教学信念**：',
    list(card.teachingBeliefs),
    '**教学方法**：',
    list(card.teachingMethods),
    '**失败教训（必须避免）**：',
    list(card.failuresLessons),
    '**边界**：',
    list(card.boundaries),
  ].join('\n');
}
