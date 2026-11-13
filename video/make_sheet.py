# -*- coding: utf-8 -*-
import os
from PIL import Image, ImageDraw, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
names = ['1_intro', '2_pain', '3_power', '4_bootstrap', '5_plugins', '6_outro']
labels = ['① 片头 (0-7s)', '② 痛点 (7-18s)', '③ 核心能力 (18-32s)',
          '④ 自举 (32-47s)', '⑤ 插件矩阵 (47-61s)', '⑥ 结尾 (61-72s)']

TW, TH = 560, 315          # 缩略图尺寸（等比 16:9）
COLS, ROWS = 2, 3
GAP = 18
LABEL_H = 30

W = COLS * TW + (COLS + 1) * GAP
H = ROWS * (TH + LABEL_H) + (ROWS + 1) * GAP

sheet = Image.new('RGB', (W, H), (28, 28, 34))
d = ImageDraw.Draw(sheet)
font = ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', 19)

for i, (n, lab) in enumerate(zip(names, labels)):
    p = os.path.join(here, f'shot_{n}.png')
    if not os.path.exists(p):
        continue
    img = Image.open(p).convert('RGB').resize((TW, TH), Image.LANCZOS)
    r, c = divmod(i, COLS)
    x = GAP + c * (TW + GAP)
    y = GAP + r * (TH + LABEL_H + GAP)
    d.text((x, y + 3), lab, font=font, fill=(240, 240, 245))
    # 缩略图边框
    sheet.paste(img, (x, y + LABEL_H))
    d.rectangle([x - 1, y + LABEL_H - 1, x + TW, y + LABEL_H + TH],
                outline=(70, 70, 82), width=1)

out = os.path.join(here, 'contact_sheet.png')
sheet.save(out)
print('生成:', out)
print('尺寸:', sheet.size, '大小:', round(os.path.getsize(out) / 1024, 1), 'KB')
