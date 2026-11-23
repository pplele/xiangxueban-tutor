-- 回滚 0011：恢复旧的按题型划分的 5 个章节名。
UPDATE kp_whitelist
   SET chapter = CASE
     WHEN kp_code LIKE 'E1.%' THEN '词汇与语法'
     WHEN kp_code LIKE 'E2.%' THEN '阅读理解'
     WHEN kp_code LIKE 'E3.%' THEN '完形填空'
     WHEN kp_code LIKE 'E4.%' THEN '翻译'
     WHEN kp_code LIKE 'E5.%' THEN '写作'
   END
 WHERE subject = 'english'
   AND kp_code ~ '^E[1-5]\.[0-9]+$';
