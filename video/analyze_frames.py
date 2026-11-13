# -*- coding: utf-8 -*-
"""客观分析关键帧：非背景像素占比、内容包围盒、主要颜色"""
import os
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
BG = (8, 8, 10)

def analyze(path):
    img = Image.open(path).convert('RGB')
    w, h = img.size
    px = img.load()
    # 采样统计（每 4 像素取一个，提速）
    total = 0
    nonbg = 0
    minx, miny, maxx, maxy = w, h, -1, -1
    colors = {}
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            total += 1
            r, g, b = px[x, y]
            if abs(r-BG[0]) + abs(g-BG[1]) + abs(b-BG[2]) > 24:
                nonbg += 1
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
                key = (r//48, g//48, b//48)
                colors[key] = colors.get(key, 0) + 1
    ratio = nonbg / total * 100 if total else 0
    # 内容区域相对位置的分布（上中下三段各占多少）
    thirds = [0, 0, 0]
    if maxx > 0:
        for y in range(0, h, 4):
            for x in range(0, w, 4):
                r, g, b = px[x, y]
                if abs(r-BG[0]) + abs(g-BG[1]) + abs(b-BG[2]) > 24:
                    thirds[min(2, y * 3 // h)] += 1
    top_colors = sorted(colors.items(), key=lambda kv: -kv[1])[:3]
    tc = [((k[0]*48, k[1]*48, k[2]*48), v) for k, v in top_colors]

    print(f'\n--- {os.path.basename(path)} ({w}x{h}) ---')
    print(f'  非背景像素占比: {ratio:.2f}%')
    if maxx > 0:
        print(f'  内容包围盒: x[{minx},{maxx}] y[{miny},{maxy}]')
        print(f'  内容宽度占画面: {(maxx-minx)/w*100:.0f}%  高度占: {(maxy-miny)/h*100:.0f}%')
    else:
        print('  !! 整帧都是背景色，没有渲染出任何内容')
    s = sum(thirds) or 1
    print(f'  内容垂直分布 上/中/下: {thirds[0]/s*100:.0f}% / {thirds[1]/s*100:.0f}% / {thirds[2]/s*100:.0f}%')
    print(f'  主要颜色: ' + ', '.join(f'#{c[0]:02x}{c[1]:02x}{c[2]:02x}({v})' for c, v in tc))

for f in ['shot_1_intro.png', 'shot_2_pain.png', 'shot_3_power.png',
          'shot_4_bootstrap.png', 'shot_5_plugins.png', 'shot_6_outro.png']:
    p = os.path.join(here, f)
    if os.path.exists(p):
        analyze(p)
