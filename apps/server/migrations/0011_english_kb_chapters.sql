-- 英语考点章节对齐《库课·大学英语》笔记目录（data/kb/english）。
-- 只更新 kp_whitelist 中 english 的 chapter 列，kp_code / 名称 / 层级一律不动，
-- 因此错题本、学习笔记（按 chapter 分组）、组卷章节、画像统计会自动按教材章节走。
-- 该 UPDATE 幂等，可重复执行。
UPDATE kp_whitelist
   SET chapter = CASE kp_code
     WHEN 'E1.1'  THEN '第一章 词法'
     WHEN 'E1.2'  THEN '第一章 词法'
     WHEN 'E1.3'  THEN '第一章 词法'
     WHEN 'E1.4'  THEN '第一章 词法'
     WHEN 'E1.5'  THEN '第二章 句法上'
     WHEN 'E1.6'  THEN '第二章 句法上'
     WHEN 'E1.8'  THEN '第二章 句法上'
     WHEN 'E1.9'  THEN '第二章 句法上'
     WHEN 'E1.10' THEN '第二章 句法上'
     WHEN 'E1.11' THEN '第二章 句法上'
     WHEN 'E1.12' THEN '第二章 句法上'
     WHEN 'E1.7'  THEN '第二章 句法下'
     WHEN 'E3.1'  THEN '第三章 词汇和语法'
     WHEN 'E3.2'  THEN '第四章 完形填空'
     WHEN 'E3.3'  THEN '第四章 完形填空'
     WHEN 'E2.1'  THEN '第五章 阅读理解'
     WHEN 'E2.2'  THEN '第五章 阅读理解'
     WHEN 'E2.3'  THEN '第五章 阅读理解'
     WHEN 'E2.4'  THEN '第五章 阅读理解'
     WHEN 'E2.5'  THEN '第五章 阅读理解'
     WHEN 'E4.1'  THEN '第六章 翻译'
     WHEN 'E4.2'  THEN '第六章 翻译'
     WHEN 'E4.3'  THEN '第六章 翻译'
     WHEN 'E5.1'  THEN '第七章 写作上（应用文）'
     WHEN 'E5.2'  THEN '第七章 写作下（提纲·图画·图表）'
     WHEN 'E5.3'  THEN '第七章 写作下（提纲·图画·图表）'
     WHEN 'E5.4'  THEN '第七章 写作下（提纲·图画·图表）'
     WHEN 'E5.5'  THEN '第七章 写作下（提纲·图画·图表）'
   END
 WHERE subject = 'english'
   AND kp_code IN (
     'E1.1','E1.2','E1.3','E1.4','E1.5','E1.6','E1.7','E1.8','E1.9','E1.10','E1.11','E1.12',
     'E2.1','E2.2','E2.3','E2.4','E2.5',
     'E3.1','E3.2','E3.3',
     'E4.1','E4.2','E4.3',
     'E5.1','E5.2','E5.3','E5.4','E5.5'
   );
