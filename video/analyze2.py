# -*- coding: utf-8 -*-
"""排除顶部装饰线后的干净内容密度测量"""
import os
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
BG = (8, 8, 10)
SKIP_TOP = 6  # 跳过顶部装饰线

def analyze(path):
    img = Image.open(path).convert('RGB')
    w, h = img.size
    px = img.load()
    total = nonbg = 0
    minx, miny, maxx, maxy = w, h, -1, -1
    rows = [0] * 12  # 按 12 等分统计垂直分布
    for y in range(SKIP_TOP, h, 4):
        for x in range(0, w, 4):
            total += 1
            r, g, b = px[x, y]
            if abs(r-BG[0]) + abs(g-BG[1]) + abs(b-BG[2]) > 24:
                nonbg += 1
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
                rows[min(11, (y - SKIP_TOP) * 12 // (h - SKIP_TOP))] += 1
    ratio = nonbg / total * 100 if total else 0
    print(f'\n--- {os.path.basename(path)} ---')
    print(f'  内容密度: {ratio:.2f}%')
    if maxx > 0:
        print(f'  内容范围: 宽 {(maxx-minx)/w*100:.0f}%  高 {(maxy-miny)/h*100:.0f}%')
        print(f'  y 从 {miny} 到 {maxy}')
    s = sum(rows) or 1
    bar = ''.join('█' if v/s > 0.08 else ('▄' if v/s > 0.02 else '·') for v in rows)
    print(f'  垂直密度分布: [{bar}]  最高行占比 {max(rows)/s*100:.0f}%')

names = ['1_intro','2_pain','3_power','4_bootstrap','5_plugins','6_outro']
ratios = []
for n in names:
    p = os.path.join(here, f'shot_{n}.png')
    if os.path.exists(p):
        analyze(p)
