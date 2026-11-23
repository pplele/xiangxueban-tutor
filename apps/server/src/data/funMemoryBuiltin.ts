/**
 * 「单词趣味记忆」内置素材：谚语(proverb) 与 近似词(similar)。
 * 统一用 `**词**（释义）` 标记生词，前端「翻转藏译文」会隐藏所有（...）内容自测词义。
 * 素材里的单词尽量取自 data/vocab 词库；用户点名但不在词库的词也照收录。
 */

export interface BuiltinItem {
  title: string;
  body: string;
}

/** 谚语：每条给出原句 + 词库词释义 + 中文义 + 用法提示 */
export const BUILTIN_PROVERBS: BuiltinItem[] = [
  {
    title: 'No pain, no gain. 不劳无获',
    body: [
      '## No pain, no gain.',
      '**pain**（n. 疼痛；辛苦） · **gain**（n. 收获；收益）',
      '译：不劳无获，没有付出就没有收获。',
      '记：写作里想说"付出才有回报"，用这句比 "No effort, no result" 更地道。',
    ].join('\n'),
  },
  {
    title: 'Respect our respective rights. 尊重各自的权利',
    body: [
      '## We should respect our respective rights.',
      '**respect**（v. 尊重） · **respective**（adj. 各自的；分别的） · **right**（n. 权利）',
      '译：我们应当尊重各自的权利。',
      '记：**respective** = 各自的，写作里替换 "our own" 更书面；respect / respective 同根易混。',
    ].join('\n'),
  },
  {
    title: 'The enemy of my enemy is my friend. 敌人的敌人就是朋友',
    body: [
      '## The enemy of my enemy is my friend.',
      '**enemy**（n. 敌人） · **friend**（n. 朋友）',
      '译：敌人的敌人就是朋友。',
      '记：阅读理解里出现的外交/博弈语境高频句；of 表所属，注意双重所有关系。',
    ].join('\n'),
  },
  {
    title: 'Where there is a will, there is a way. 有志者事竟成',
    body: [
      '## Where there is a will, there is a way.',
      '**will**（n. 意志；意愿） · **way**（n. 方法；道路）',
      '译：有志者事竟成。',
      '记：**will** 这里不是情态动词"将要"，而是名词"意志"——完形常考词性转换。',
    ].join('\n'),
  },
  {
    title: 'Practice makes perfect. 熟能生巧',
    body: [
      '## Practice makes perfect.',
      '**practice**（n. 练习） · **perfect**（adj. 完美的）',
      '译：熟能生巧。',
      '记：**practice** 名词，动词是 **practise**；美式英语动词也写 practice。',
    ].join('\n'),
  },
  {
    title: 'A friend in need is a friend indeed. 患难见真情',
    body: [
      '## A friend in need is a friend indeed.',
      '**need**（n. 需要；困难） · **indeed**（adv. 确实；真正地）',
      '译：患难中的朋友才是真朋友。',
      '记：**in need** = 在困难中；**indeed** 句末加强语气，写作加分副词。',
    ].join('\n'),
  },
  {
    title: 'It is never too old to learn. 活到老学到老',
    body: [
      '## It is never too old to learn.',
      '**never**（adv. 从不） · **learn**（v. 学习；得知）',
      '译：活到老，学到老。',
      '记：**too + adj. + to do** 是"太……而不能"结构，这里 never 否定后变"永远不会太老而不能学"。',
    ].join('\n'),
  },
  {
    title: 'Actions speak louder than words. 事实胜于雄辩',
    body: [
      '## Actions speak louder than words.',
      '**action**（n. 行动） · **loud**（adj. 响亮的）· **word**（n. 话；言语）',
      '译：行动比言语更有说服力。',
      '记：**louder** 是 loud 的比较级，than 引出比较对象；议论文举例常用。',
    ].join('\n'),
  },
  {
    title: 'Look before you leap. 三思而后行',
    body: [
      '## Look before you leap.',
      '**look**（v. 看；考虑） · **before**（conj. 在……之前） · **leap**（v./n. 跳跃）',
      '译：跳之前先看——三思而后行。',
      '记：**leap** 跳跃，过去式 leapt/leaped；近义 jump。',
    ].join('\n'),
  },
  {
    title: 'Better late than never. 迟做总比不做好',
    body: [
      '## Better late than never.',
      '**late**（adj. 迟的；晚的） · **never**（adv. 从不）',
      '译：迟做总比不做强。',
      '记：Better A than B 结构的固定谚语，**late** 这里是形容词。',
    ].join('\n'),
  },
  {
    title: 'Health is wealth. 健康就是财富',
    body: [
      '## Health is wealth.',
      '**health**（n. 健康） · **wealth**（n. 财富）',
      '译：健康就是财富。',
      '记：**health** 名词 / **healthy** 形容词；**wealth** 不可数名词，"大量"用 a wealth of。',
    ].join('\n'),
  },
  {
    title: 'Failure is the mother of success. 失败是成功之母',
    body: [
      '## Failure is the mother of success.',
      '**failure**（n. 失败） · **success**（n. 成功）',
      '译：失败是成功之母。',
      '记：fail(v.) → failure(n.)；succeed(v.) → success(n.) → successful(adj.)，词性转换必考。',
    ].join('\n'),
  },
  {
    title: 'Knowledge is power. 知识就是力量',
    body: [
      '## Knowledge is power.',
      '**knowledge**（n. 知识） · **power**（n. 力量；权力）',
      '译：知识就是力量。',
      '记：**knowledge** 不可数名词；**power** 作"电力"也常用。',
    ].join('\n'),
  },
  {
    title: 'Where there is smoke, there is fire. 无风不起浪',
    body: [
      '## Where there is smoke, there is fire.',
      '**smoke**（n. 烟） · **fire**（n. 火）',
      '译：有烟就有火——无风不起浪。',
      '记：Where there is... there is... 句型的又一例句，与 will/way 那句一起记。',
    ].join('\n'),
  },
  {
    title: 'You cannot judge a book by its cover. 不可以貌取人',
    body: [
      '## You cannot judge a book by its cover.',
      '**judge**（v. 判断） · **cover**（n. 封面；覆盖物）',
      '译：不能只凭封面判断一本书——不可以貌取人。',
      '记：作文里劝人别只看外表时可直接引用；**judge...by...** 是固定搭配。',
    ].join('\n'),
  },
  {
    title: 'Time and tide wait for no man. 岁月不待人',
    body: [
      '## Time and tide wait for no man.',
      '**wait**（v. 等待） · **tide**（n. 潮汐；潮流）',
      '译：时间和潮汐不等人——岁月不待人。',
      '记：**wait for** 等待；tide 还可指"潮流"，如 the tide of history。',
    ].join('\n'),
  },
];

/** 近似词/同根词组：每组给出词 + 释义 + 辨析，全部取自或围绕词库 */
export const BUILTIN_SIMILARS: BuiltinItem[] = [
  {
    title: 'peculiar / particular 独特的 vs 讲究的',
    body: [
      '## peculiar / particular',
      '**peculiar**（adj. 独特的；古怪的）—— 侧重"与众不同"，常带点怪。',
      '**particular**（adj. 特别的；特定的；讲究的）—— 侧重"某一个 / 挑剔"。',
      '辨：be **particular** about 对……讲究；**peculiar** to 为……特有。',
    ].join('\n'),
  },
  {
    title: 'tailor / sailor 裁缝 vs 水手',
    body: [
      '## tailor / sailor',
      '**tailor**（n. 裁缝 v. 缝制）—— 做衣服的人。',
      '**sailor**（n. 水手；船员）—— 船上干活的人。',
      '辨：两个词只差首字母 t/s，都含 -ailor；记"**t**ailor 拿针线，**s**ailor 开船"。',
    ].join('\n'),
  },
  {
    title: 'trail / trial / rival 小径 vs 审判 vs 对手',
    body: [
      '## trail / trial / rival',
      '**trail**（n. 小径；踪迹 v. 追踪）—— 地上的路。',
      '**trial**（n. 审判；试验；考验）—— 法庭上的"审"。',
      '**rival**（n. 对手 v. 竞争）—— 和你争的人。',
      '辨：三个词都是 -ail/-ial 结尾，看中间字母：tr**ail**(路)、tr**ial**(审)、r**ival**(争)。',
    ].join('\n'),
  },
  {
    title: 'quality / qualify / quantity 质量 vs 合格 vs 数量',
    body: [
      '## quality / qualify / quantity',
      '**quality**（n. 质量；品质）—— 好不好。',
      '**qualify**（v. 使合格；具备资格）—— 够不够格。',
      '**quantity**（n. 数量）—— 多不多。',
      '辨：quality 和 quantity 一对（质 vs 量）；qualify 是 quality 的动词形式。',
    ].join('\n'),
  },
  {
    title: 'throughout / thorough / though / thought 贯穿 vs 彻底 vs 虽然 vs 想法',
    body: [
      '## throughout / thorough / though / thought',
      '**throughout**（prep. 贯穿；自始至终）—— 从头到尾。',
      '**thorough**（adj. 彻底的；全面的）—— 做得彻底。',
      '**though**（conj. 虽然；尽管）—— 让步连词。',
      '**thought**（n. 想法；思考）—— think 的名词。',
      '辨：都含 th-ou-gh-t 一串字母。**though** 最短表"虽然"，加 t 成 **thought**"想法"， thorough 多一个 ro 表"彻底"。',
    ].join('\n'),
  },
  {
    title: 'cross / across 穿过 vs 在对面',
    body: [
      '## cross / across',
      '**cross**（v. 穿过 n. 十字架）—— 动词，直接接宾语：cross the street。',
      '**across**（prep./adv. 横过；在对面）—— 介词/副词，常配动词：walk across the street。',
      '辨：**cross = 动词**，**across = 介词**；句中有实义动词时用 across。',
    ].join('\n'),
  },
  {
    title: 'conclusion / conclusive 结论 vs 决定性的',
    body: [
      '## conclusion / conclusive',
      '**conclusion**（n. 结论；结尾）—— in conclusion 总之。',
      '**conclusive**（adj. 决定性的；确凿的）—— conclusive evidence 确凿证据。',
      '辨：conclude(v. 得出结论) → conclusion(n.) → conclusive(adj.)，一词三态常考。',
    ].join('\n'),
  },
  {
    title: 'authorize / authorization 批准 vs 授权',
    body: [
      '## authorize / authorization',
      '**authorize**（v. 批准；授权）—— 动词。',
      '**authorization**（n. 授权；许可）—— 名词。',
      '辨：author(n. 作者) → authority(n. 权威) → authorize(v.) → authorization(n.)，同根一串记。',
    ].join('\n'),
  },
  {
    title: 'affect / effect 影响（动）vs 效果（名）',
    body: [
      '## affect / effect',
      '**affect**（v. 影响）—— 动词：The weather affects me.',
      '**effect**（n. 效果；影响）—— 名词：have an effect on。',
      '辨：**A**ffect = **A**ction(动词)，**E**ffect = **E**nd(结果名词)。',
    ].join('\n'),
  },
  {
    title: 'adapt / adopt / adjust 适应 vs 采纳 vs 调整',
    body: [
      '## adapt / adopt / adjust',
      '**adapt**（v. 适应；改编）—— adapt to 适应；be adapted from 改编自。',
      '**adopt**（v. 采纳；收养）—— adopt a policy / a child。',
      '**adjust**（v. 调整；适应）—— adjust to 调整适应。',
      '辨：adapt 改自己适应环境，adopt 拿别人（主意/孩子）来用，adjust 微调。',
    ].join('\n'),
  },
  {
    title: 'assume / assure / ensure 假定 vs 使确信 vs 确保',
    body: [
      '## assume / assure / ensure',
      '**assume**（v. 假定；承担）—— assume responsibility 承担责任。',
      '**assure**（v. 使确信；向……保证）—— assure sb. of sth.。',
      '**ensure**（v. 确保；保证）—— ensure that...。',
      '辨：assume 是"以为"，assure 对人"打包票"，ensure 对事"确保"。',
    ].join('\n'),
  },
  {
    title: 'commend / comment / command 表扬 vs 评论 vs 命令',
    body: [
      '## commend / comment / command',
      '**commend**（v. 表扬；推荐）—— commend sb. for sth.。',
      '**comment**（n./v. 评论）—— comment on 对……评论。',
      '**command**（n./v. 命令；掌握）—— command the army / a good command of English。',
      '辨：三词都 com- 开头，中间不同：comm**end**(表扬)、comm**ent**(评论)、comm**and**(命令)。',
    ].join('\n'),
  },
  {
    title: 'confirm / conform 确认 vs 遵守',
    body: [
      '## confirm / conform',
      '**confirm**（v. 确认；证实）—— confirm a booking。',
      '**conform**（v. 遵守；符合）—— conform to/with 遵守。',
      '辨：con-firm 确认（firm  firm 确定），con-form 符合（form 形式）。',
    ].join('\n'),
  },
  {
    title: 'contend / content / contest / context 竞争 vs 内容 vs 比赛 vs 语境',
    body: [
      '## contend / content / contest / context',
      '**contend**（v. 竞争；主张）—— contend with 与……抗争。',
      '**content**（n. 内容 adj. 满足的）—— be content with 对……满意。',
      '**contest**（n. 比赛 v. 争夺）。',
      '**context**（n. 上下文；背景）—— in context 在语境中。',
      '辨：都 con-tent 一串，看词尾：-end 争、-ent 内容/满足、-est 比赛、-ext 语境。',
    ].join('\n'),
  },
  {
    title: 'complement / compliment 补充物 vs 赞美',
    body: [
      '## complement / compliment',
      '**complement**（n. 补充物 v. 补充）—— 使完整的东西。',
      '**compliment**（n./v. 赞美；恭维）—— 夸奖的话。',
      '辨：compl**e**ment 补充(e = 完整)，compl**i**ment 赞美(i = 我夸你)。',
    ].join('\n'),
  },
  {
    title: 'device / devise 装置 vs 设计',
    body: [
      '## device / devise',
      '**device**（n. 装置；设备）—— 具体的东西。',
      '**devise**（v. 设计；想出）—— 动作。',
      '辨：-ice 结尾是名词(装置)，-ise 结尾是动词(设计)，同 principle/principal 一类。',
    ].join('\n'),
  },
  {
    title: 'breath / breathe 呼吸（名）vs 呼吸（动）',
    body: [
      '## breath / breathe',
      '**breath**（n. 呼吸；气息）—— take a deep breath。',
      '**breathe**（v. 呼吸）—— breathe in/out 吸气/呼气。',
      '辨：名词 breath 结尾 -th，动词 breathe 结尾 -the（多一个 e 发 /ð/）。',
    ].join('\n'),
  },
  {
    title: 'cloth / clothe / clothes 布 vs 给穿衣 vs 衣服',
    body: [
      '## cloth / clothe / clothes',
      '**cloth**（n. 布；布料）—— 不可数，a piece of cloth。',
      '**clothe**（v. 给……穿衣）—— be clothed in。',
      '**clothes**（n. 衣服）—— 恒复数，无单数形式。',
      '辨：cloth 料子，clothe 动词穿衣，clothes 衣服总称。',
    ].join('\n'),
  },
  {
    title: 'principal / principle 校长·主要的 vs 原则',
    body: [
      '## principal / principle',
      '**principal**（adj. 主要的 n. 校长；本金）—— the principal reason。',
      '**principle**（n. 原则；原理）—— in principle 原则上。',
      '辨：princi**pal** 末尾 -pal 记"校长(pal 伙伴)"，princi**ple** 末尾 -ple 记"原则(rule)"。',
    ].join('\n'),
  },
  {
    title: 'council / counsel 委员会 vs 建议',
    body: [
      '## council / counsel',
      '**council**（n. 委员会；理事会）—— 一个机构。',
      '**counsel**（n./v. 建议；忠告；律师）—— 建议或法律顾问。',
      '辨：counc**i**l 机构(i 像 institution)，couns**e**l 建议(e 像 advice)。',
    ].join('\n'),
  },
  {
    title: 'quiet / quite 安静 vs 相当',
    body: [
      '## quiet / quite',
      '**quiet**（adj. 安静的）—— 没有声音。',
      '**quite**（adv. 相当；完全）—— quite good 相当好。',
      '辨：两词字母完全一样只是顺序不同：qu**ie**t(安静 i-e)、qu**it**e(相当 i-e 换位置)。',
    ].join('\n'),
  },
  {
    title: 'rise / raise / arise / arouse 升起（不及）vs 举起（及）',
    body: [
      '## rise / raise / arise / arouse',
      '**rise**（v. 上升；升起）—— 不及物，The sun rises.',
      '**raise**（v. 举起；提高；筹集）—— 及物，raise your hand。',
      '**arise**（v. 出现；产生）—— 问题 arise。',
      '**arouse**（v. 唤起；引起）—— arouse interest。',
      '辨：rise/arise 不及物（自己起来），raise/arouse 及物（使……起来）。',
    ].join('\n'),
  },
  {
    title: 'loose / lose / loss 松的 vs 丢失 vs 损失',
    body: [
      '## loose / lose / loss',
      '**loose**（adj. 松的；松散的）—— 不紧。',
      '**lose**（v. 丢失；输掉）—— 动作，过去式 lost。',
      '**loss**（n. 损失；丢失）—— at a loss 困惑。',
      '辨：loose 形容词(发音 /luːs/)，lose 动词，loss 名词。',
    ].join('\n'),
  },
  {
    title: 'economic / economical 经济的 vs 节约的',
    body: [
      '## economic / economical',
      '**economic**（adj. 经济的；经济上的）—— economic growth 经济增长。',
      '**economical**（adj. 节约的；经济实惠的）—— be economical with 节省。',
      '辨：带 -ical 的多表"节约"，economic 专指"经济(领域)的"。',
    ].join('\n'),
  },
  {
    title: 'effective / efficient 有效的 vs 高效的',
    body: [
      '## effective / efficient',
      '**effective**（adj. 有效的；起作用的）—— 强调"达到效果"。',
      '**efficient**（adj. 高效的；效率高的）—— 强调"少投入多产出"。',
      '辨：effective 看结果(effective medicine 有效的药)，efficient 看效率(efficient machine)。',
    ].join('\n'),
  },
  {
    title: 'historic / historical 有历史意义的 vs 历史上的',
    body: [
      '## historic / historical',
      '**historic**（adj. 有历史意义的；划时代的）—— a historic moment。',
      '**historical**（adj. 历史上的；与历史有关的）—— historical figures。',
      '辨：-ic 表"具有……性质的(了不起)"，-ical 表"与……相关的"。',
    ].join('\n'),
  },
  {
    title: 'continual / continuous 频繁的 vs 连续的',
    body: [
      '## continual / continuous',
      '**continual**（adj. 频繁的；一再发生的）—— 中间有间断的反复。',
      '**continuous**（adj. 连续的；不间断的）—— 中间不断。',
      '辨：continual 反复但停过(令人烦)，continuous 一直不停。',
    ].join('\n'),
  },
  {
    title: 'identify / identity 识别 vs 身份',
    body: [
      '## identify / identity',
      '**identify**（v. 认出；鉴定）—— identify with 认同。',
      '**identity**（n. 身份；特征）—— identity card 身份证。',
      '辨：动词 -ify，名词 -ity，同根转换。',
    ].join('\n'),
  },
  {
    title: 'respect / respective / respectful / respectable 尊重 vs 各自的 vs 恭敬的 vs 体面的',
    body: [
      '## respect / respective / respectful / respectable',
      '**respect**（v./n. 尊重）—— respect sb. / show respect to。',
      '**respective**（adj. 各自的；分别的）—— their respective rooms。',
      '**respectful**（adj. 恭敬的；表示尊重的）—— be respectful to sb.。',
      '**respectable**（adj. 值得尊敬的；体面的）—— a respectable man。',
      '辨：respective 各自的、respectful(对别人)恭敬的、respectable(被别人)尊敬的。',
    ].join('\n'),
  },
  {
    title: 'sensitive / sensible 敏感的 vs 明智的',
    body: [
      '## sensitive / sensible',
      '**sensitive**（adj. 敏感的；易受伤害的）—— be sensitive to 对……敏感。',
      '**sensible**（adj. 明智的；合理的）—— a sensible decision。',
      '辨：sensitive 是"感受敏感"，sensible 是"判断明智(-ible 能……的)"。',
    ].join('\n'),
  },
  {
    title: 'personal / personnel 个人的 vs 全体人员',
    body: [
      '## personal / personnel',
      '**personal**（adj. 个人的；私人的）—— personal information。',
      '**personnel**（n. 全体人员；人事部门）—— 一个群体。',
      '辨：personal 形容词"个人的"，personnel 名词"员工们"，别把 -nel 丢了。',
    ].join('\n'),
  },
  {
    title: 'precede / proceed 先于 vs 继续进行',
    body: [
      '## precede / proceed',
      '**precede**（v. 先于；在……之前）—— pre- 表"在前"。',
      '**proceed**（v. 继续进行；前进）—— proceed with 继续进行。',
      '辨：pre- 在前(precede 先发生)，pro- 向前(proceed 往前走)。',
    ].join('\n'),
  },
  {
    title: 'stationery / stationary 文具 vs 静止的',
    body: [
      '## stationery / stationary',
      '**stationery**（n. 文具；信纸）—— 买的东西。',
      '**stationary**（adj. 静止的；固定的）—— 不动的。',
      '辨：statio**nery** 里 e 像 envelope(信封)→文具；statio**nary** 里 a 像 at rest→静止。',
    ].join('\n'),
  },
  {
    title: 'desert / dessert 沙漠 vs 甜点',
    body: [
      '## desert / dessert',
      '**desert**（n. 沙漠 v. 抛弃）—— 沙漠/遗弃。',
      '**dessert**（n. 甜点；甜食）—— 饭后甜点。',
      '辨：dessert 有两个 s，因为甜点"甜(sweet)"要多吃一口(s)。',
    ].join('\n'),
  },
  {
    title: 'award / aware 奖品 vs 意识到的',
    body: [
      '## award / aware',
      '**award**（n. 奖品 v. 授予）—— award sb. sth.。',
      '**aware**（adj. 意识到的）—— be aware of 意识到。',
      '辨：award 是"奖"，aware 是"知道"，只差词尾。',
    ].join('\n'),
  },
  {
    title: 'basic / basis / base 基本的 vs 基础 vs 基地',
    body: [
      '## basic / basis / base',
      '**basic**（adj. 基本的；基础的）—— basic skills。',
      '**basis**（n. 基础；依据）—— on the basis of 在……基础上。',
      '**base**（n. 基地；底部 v. 以……为基础）—— be based on 以……为依据。',
      '辨：basic 形容词，basis 抽象名词(依据)，base 具体名词(基地)+动词。',
    ].join('\n'),
  },
  {
    title: 'contract / contrast / contact 合同 vs 对比 vs 接触',
    body: [
      '## contract / contrast / contact',
      '**contract**（n. 合同 v. 收缩）—— sign a contract。',
      '**contrast**（n./v. 对比；对照）—— in contrast to 与……对比。',
      '**contact**（n./v. 接触；联系）—— keep in contact with。',
      '辨：都 con- 开头：-tract 拉(合同把人拉在一起)、-trast 对照、-tact 触碰。',
    ].join('\n'),
  },
  {
    title: 'emerge / emergency / immigrate / migrate 出现 vs 紧急 vs 移入 vs 迁徙',
    body: [
      '## emerge / emergency / immigrate / migrate',
      '**emerge**（v. 出现；浮现）—— emerge from 从……出现。',
      '**emergency**（n. 紧急情况）—— in an emergency。',
      '**immigrate**（v. 移入；移民入境）—— immigrate to。',
      '**migrate**（v. 迁移；迁徙）—— 鸟迁徙/人迁移。',
      '辨：e-merge 往外冒(出现)，im-migrate 往里移(移入)，migrate 泛指迁移。',
    ].join('\n'),
  },
  {
    title: 'explicit / implicit 明确的 vs 含蓄的',
    body: [
      '## explicit / implicit',
      '**explicit**（adj. 明确的；清晰的）—— 说得清清楚楚。',
      '**implicit**（adj. 含蓄的；暗含的）—— 不说但能意会。',
      '辨：ex- 向外(说明白)，im- 向内(含着不说)；一对反义词。',
    ].join('\n'),
  },
  {
    title: 'formal / former 正式的 vs 以前的',
    body: [
      '## formal / former',
      '**formal**（adj. 正式的；形式的）—— formal dress 正装。',
      '**former**（adj. 以前的； former）—— the former 前者(对比 latter 后者)。',
      '辨：formal 正式，former 从前；阅读里 the former...the latter... 常考。',
    ].join('\n'),
  },
  {
    title: 'consider / considerable / considerate 考虑 vs 相当大的 vs 体贴的',
    body: [
      '## consider / considerable / considerate',
      '**consider**（v. 考虑；认为）—— consider doing。',
      '**considerable**（adj. 相当大的；可观的）—— a considerable amount。',
      '**considerate**（adj. 体贴的；考虑周到的）—— be considerate of others。',
      '辨：considerable 形容"数量大"，considerate 形容"人会体谅"。',
    ].join('\n'),
  },
  {
    title: 'alone / lonely 独自 vs 孤独的',
    body: [
      '## alone / lonely',
      '**alone**（adj./adv. 独自；单独）—— 客观状态，一个人。',
      '**lonely**（adj. 孤独的；寂寞的）—— 主观感受，带感情色彩。',
      '辨：live alone 独居(客观)，feel lonely 感到孤独(主观)；lonely 还能形容地方"荒凉的"。',
    ].join('\n'),
  },
  {
    title: '词根 tain：attain / obtain / contain / maintain / retain',
    body: [
      '## attain / obtain / contain / maintain / retain',
      '**attain**（v. 达到；获得）—— attain a goal。',
      '**obtain**（v. 获得；取得）—— obtain permission。',
      '**contain**（v. 包含；容纳）—— 里面装有。',
      '**maintain**（v. 维持；保养；主张）—— 保持住。',
      '**retain**（v. 保留；保持）—— 留住不丢。',
      '记：都含词根 **tain**(拿住)：at- 努力拿到、ob- 拿到手、con- 一起拿(包含)、main- 用手拿住(维持)、re- 拿回来(保留)。',
    ].join('\n'),
  },
  {
    title: '词根 pose：impose / compose / propose / suppose / expose',
    body: [
      '## impose / compose / propose / suppose / expose',
      '**impose**（v. 强加；征收）—— impose on 把……强加于。',
      '**compose**（v. 组成；创作）—— be composed of 由……组成。',
      '**propose**（v. 提议；求婚）—— propose that...。',
      '**suppose**（v. 假设；认为）—— be supposed to 应该。',
      '**expose**（v. 暴露；揭露）—— expose to 使暴露于。',
      '记：词根 **pose**(放)：im- 放上去(强加)、com- 放一起(组成)、pro- 往前放(提议)、sup- 放在下面当假设、ex- 放出去(暴露)。',
    ].join('\n'),
  },
  {
    title: '词根 spect：inspect / respect / prospect / suspect',
    body: [
      '## inspect / respect / prospect / suspect',
      '**inspect**（v. 检查；视察）—— in- 往里看。',
      '**respect**（v./n. 尊重）—— re- 再看一眼(重视)。',
      '**prospect**（n. 前景；展望）—— pro- 往前看。',
      '**suspect**（v. 怀疑 n. 嫌疑人）—— sus- 往上瞄(起疑)。',
      '记：词根 **spect**(看)：不同前缀 = 往不同方向看。',
    ].join('\n'),
  },
  {
    title: '词根 tribute：attribute / contribute / distribute',
    body: [
      '## attribute / contribute / distribute',
      '**attribute**（v. 归因于 n. 属性）—— attribute A to B 把A归因于B。',
      '**contribute**（v. 贡献；捐助；促成）—— contribute to 有助于。',
      '**distribute**（v. 分发；分配）—— 分给多人。',
      '记：词根 **tribute**(给予)：at- 把结果归给原因、con- 一起给(贡献)、dis- 分开给(分发)。',
    ].join('\n'),
  },
  {
    title: '词根 ply：apply / imply / reply / supply',
    body: [
      '## apply / imply / reply / supply',
      '**apply**（v. 申请；应用）—— apply for 申请；apply to 适用于。',
      '**imply**（v. 暗示；意味着）—— 话里有话。',
      '**reply**（v./n. 回答）—— reply to 回复。',
      '**supply**（v./n. 供应）—— supply sb. with sth.。',
      '记：词根 **ply**(折叠/弯曲)：ap- 贴上去(应用)、im- 折进去(暗示)、re- 折回去(回答)、sup- 从下面递上(供应)。',
    ].join('\n'),
  },
  {
    title: '词根 fer：transfer / refer / prefer / offer / suffer',
    body: [
      '## transfer / refer / prefer / offer / suffer',
      '**transfer**（v. 转移；调动）—— 从一处搬到另一处。',
      '**refer**（v. 提及；参考）—— refer to 提到/查阅。',
      '**prefer**（v. 更喜欢）—— prefer A to B。',
      '**offer**（v. 提供；主动提出）—— offer sb. sth.。',
      '**suffer**（v. 遭受；受苦）—— suffer from 患……/受……之苦。',
      '记：词根 **fer**(拿/带)：trans- 转移、re- 带回(提及)、pre- 先拿(更喜欢)、of- 拿出(提供)、suf- 承受(遭受)。',
    ].join('\n'),
  },
  {
    title: 'compete / complete / compute 竞争 vs 完成 vs 计算',
    body: [
      '## compete / complete / compute',
      '**compete**（v. 竞争）—— compete with 与……竞争。',
      '**complete**（v. 完成 adj. 完整的）—— 做完了。',
      '**compute**（v. 计算）—— 算数。',
      '辨：三词 com- 开头：-pete 争(pet 争宠)、-plete 满(填满→完成)、-pute 算(电脑 computer)。',
    ].join('\n'),
  },
  {
    title: 'access / excess / process 获取 vs 过量 vs 过程（attribute 相关）',
    body: [
      '## access / excess / process',
      '**access**（n./v. 通道；获取）—— have access to 有权使用。',
      '**excess**（n. 过量 adj. 过度的）—— in excess of 超过。',
      '**process**（n. 过程 v. 处理）—— in the process of 在……过程中。',
      '辨：都含 -cess(走)：ac- 接近(进入)、ex- 走出(过量)、pro- 向前走(过程)。',
    ].join('\n'),
  },
];
