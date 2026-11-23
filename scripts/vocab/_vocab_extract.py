"""《送分笔记 英语》是 2-up 拼版扫描：每张 PDF 纸左右各一个书页（S1 左 / S2 右）。
本脚本为每个书页裁出左右两栏，命名 s{纸号}-{L|R}{1|2}.jpg，交给视觉模型逐栏识别。
用法：python scripts/_vocab_extract.py
输出：F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/pages/s005-L1.jpg ...
"""
import os
import re

from PIL import Image
from pypdf import PdfReader

SRC = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/送分笔记 英语阅读.pdf'
OUT = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/pages'
os.makedirs(OUT, exist_ok=True)

reader = PdfReader(SRC)


def drawn(page):
    """按绘制顺序返回 [(位置S1/S2, 图片名)]，S1 在左半页、S2 在右半页"""
    data = page.get_contents().get_data().decode('latin-1')
    out = []
    # 每个 BDC 段里的 /ImN Do；段号由 /ID /S1 /S2 标记
    for m in re.finditer(r'/ID /(S\d)\b.*?/(\w+)\s+Do', data, re.S):
        out.append((m.group(1), m.group(2)))
    return out


def main():
    report = []
    for idx, page in enumerate(reader.pages, start=1):
        slot = dict(drawn(page))
        by_name = {im.name.split('.')[0]: im for im in page.images}
        for s in ('S1', 'S2'):
            name = slot.get(s)
            if not name or name not in by_name:
                report.append((idx, s, 'MISSING'))
                continue
            path = f'{OUT}/_tmp.jpg'
            with open(path, 'wb') as f:
                f.write(by_name[name].data)
            im = Image.open(path)
            w, h = im.size
            tag = 'L' if s == 'S1' else 'R'
            im.crop((0, 0, int(w * 0.52), h)).save(f'{OUT}/s{idx:03d}-{tag}1.jpg', quality=90)
            im.crop((int(w * 0.48), 0, w, h)).save(f'{OUT}/s{idx:03d}-{tag}2.jpg', quality=90)
            report.append((idx, s, name, w, h))
    os.path.exists(f'{OUT}/_tmp.jpg') and os.remove(f'{OUT}/_tmp.jpg')
    print('导出栏数:', sum(1 for r in report if len(r) > 3))
    for r in report[:6]:
        print(r)


if __name__ == '__main__':
    main()
