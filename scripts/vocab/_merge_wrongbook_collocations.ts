/**
 * 把用户英语错题解析/备注里点名、但附录三未收录的高频搭配并入 collocations.json。
 * 这些搭配 100% 命中用户自己的薄弱点，人工逐题核对后写入（取自 questions 表 solution/note）。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(__dirname, '../../data/vocab/collocations.json');
const list = JSON.parse(fs.readFileSync(FILE, 'utf8')) as {
  word: string;
  phonetic: string;
  meaning: string;
  page: number | null;
  sort: number;
}[];

const fromWrongbook: [string, string][] = [
  ['in great demand', '需求量很大'],
  ['in progress', '在进行中'],
  ['in the process of', '在……过程中'],
  ['in good condition', '状况良好'],
  ['the sight of', '一看到……（的情景）'],
  ['make an appointment with', '与……预约'],
  ['pay attention to', '注意，重视'],
  ['reach an agreement', '达成协议'],
  ['take advantage of', '利用（机会、条件）'],
  ['take care of', '照顾'],
  ['take notice of', '注意到'],
  ['as a result', '因此，结果'],
  ['as a result of', '由于'],
  ['as a matter of fact', '事实上'],
  ['a piece of advice', '一条建议（advice 不可数）'],
  ['a book of', "……的一本（双重所有格 a book of Shirley's）"],
  ['every aspect of', '……的方方面面'],
  ['in every aspect', '在各个方面'],
  ['speak with a local accent', '带着当地口音说话'],
  ['strong tea', '浓茶'],
  ['failure to do sth', '未能做某事'],
  ['tips on doing sth', '关于做某事的窍门'],
  ['one of the', '……之一'],
  ['introduce A to B', '把 A 介绍给 B'],
  ['show signs of', '显示出……的迹象'],
  ['come to a conclusion', '得出结论'],
  ['make a response to', '对……做出回应'],
  ['respond to', '回应'],
  ['find fault with', '挑……的刺，找茬'],
  ['from time to time', '时不时，偶尔'],
  ['be on good terms with', '与……关系融洽'],
  ['There is no point in doing sth', '做某事没有意义'],
  ['It is no use doing sth', '做某事没有用'],
  ['be widely used in', '被广泛应用于'],
  ['have difficulty in doing sth', '在做某事方面有困难'],
];

const exist = new Set(list.map((x) => x.word.toLowerCase()));
let added = 0;
for (const [word, meaning] of fromWrongbook) {
  const key = word.toLowerCase();
  if (exist.has(key)) continue;
  list.push({ word, phonetic: '', meaning, page: null, sort: 0 });
  exist.add(key);
  added += 1;
}
list.sort((a, b) => a.word.localeCompare(b.word));
fs.writeFileSync(FILE, JSON.stringify(list, null, 1), 'utf8');
console.log(`错题补充 ${added} 条 | 最终清单 ${list.length} 条`);
