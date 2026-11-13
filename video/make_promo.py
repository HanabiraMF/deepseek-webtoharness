# -*- coding: utf-8 -*-
"""DeepSeek WebtoHarness 宣传片 - 纯代码渲染 72s / 2160帧"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

W, H, FPS = 1280, 720, 30
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'promo.mp4')

# ===== 字体 =====
F_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
F_REG  = 'C:/Windows/Fonts/msyh.ttc'
F_CODE = 'C:/Windows/Fonts/consola.ttf'
_fonts = {}
def font(path, size):
    k = (path, size)
    if k not in _fonts:
        _fonts[k] = ImageFont.truetype(path, size)
    return _fonts[k]

# ===== 配色（与官网一致）=====
def hexc(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
BG      = hexc('08080a')
CARD    = hexc('14141a')
CARD2   = hexc('1c1c24')
BORDER  = hexc('26262e')
TEXT    = hexc('f5f5f7')
MUTED   = hexc('9a9aa5')
DIM     = hexc('66666f')
BLUE    = hexc('5686fe')
BLUE_D  = hexc('3964fe')
GREEN   = hexc('4ade80')

# ===== 缓动 =====
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ease_out(t): t = clamp(t); return 1 - pow(1 - t, 3)
def ease_io(t): t = clamp(t); return 3*t*t - 2*t*t*t
def prog(t, start, dur): return clamp((t - start) / dur) if dur > 0 else 1.0

def lerp(a, b, t): return a + (b - a) * t
def mix(c1, c2, t):
    t = clamp(t)
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))

# ===== 绘制工具 =====
def text_w(d, s, f):
    bb = d.textbbox((0, 0), s, font=f)
    return bb[2] - bb[0], bb[3] - bb[1]

def text_center(img, s, f, y, color, alpha=1.0):
    """居中绘制文字，alpha 支持淡入"""
    if alpha <= 0.01 or not s: return
    d = ImageDraw.Draw(img)
    w, _ = text_w(d, s, f)
    x = (W - w) // 2
    if alpha >= 0.99:
        d.text((x, y), s, font=f, fill=color)
    else:
        layer = Image.new('RGB', (W, H), BG)
        ImageDraw.Draw(layer).text((x, y), s, font=f, fill=color)
        img.paste(Image.composite(layer, img, Image.new('L', (W, H), int(255 * alpha))), (0, 0))

def text_left(img, s, f, x, y, color, alpha=1.0):
    if alpha <= 0.01 or not s: return
    d = ImageDraw.Draw(img)
    if alpha >= 0.99:
        d.text((x, y), s, font=f, fill=color)
    else:
        layer = Image.new('RGB', (W, H), BG)
        ImageDraw.Draw(layer).text((x, y), s, font=f, fill=color)
        img.paste(Image.composite(layer, img, Image.new('L', (W, H), int(255 * alpha))), (0, 0))

def rounded(d, box, r, fill=None, outline=None, width=1):
    try:
        d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)
    except Exception:
        d.rectangle(box, fill=fill, outline=outline, width=width)

def top_line(img, t, color=BLUE):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 2], fill=color)

# ===== 场景 =====
SCENES = [
    ('intro',    0.0,  7.0),
    ('pain',     7.0, 18.0),
    ('power',   18.0, 32.0),
    ('bootstrap',32.0, 47.0),
    ('plugins', 47.0, 61.0),
    ('outro',   61.0, 72.0),
]
TOTAL_DUR = SCENES[-1][2]

def scene_at(t):
    for name, a, b in SCENES:
        if a <= t < b:
            return name, t - a, b - a
    return SCENES[-1][0], t - SCENES[-1][1], SCENES[-1][2] - SCENES[-1][1]

# --- 1. 片头 ---
def draw_intro(img, t, dur):
    d = ImageDraw.Draw(img)
    # 中线展开
    p = ease_out(prog(t, 0, 0.8))
    cx, cy = W // 2, 330
    half = int(340 * p)
    d.rectangle([cx - half, cy - 1, cx + half, cy + 1], fill=BLUE)
    # 标题
    a1 = ease_out(prog(t, 0.5, 1.0))
    text_center(img, 'DeepSeek WebtoHarness', font(F_BOLD, 62), 250, TEXT, a1)
    # 副标题
    a2 = ease_out(prog(t, 1.3, 1.0))
    text_center(img, '赋予网页 AI 真实的本地能力', font(F_REG, 30), 390, BLUE, a2)
    # 三个关键词
    words = ['文件系统', 'Shell 执行', '无限插件']
    a3 = ease_out(prog(t, 2.3, 0.8))
    for i, w in enumerate(words):
        if a3 <= 0: break
        f = font(F_REG, 20)
        wd, _ = text_w(d, w, f)
        gap = 60
        total = sum(text_w(d, x, f)[0] for x in words) + gap * (len(words) - 1)
        startx = (W - total) // 2
        x = startx + sum(text_w(d, x, f)[0] + gap for x in words[:i])
        text_left(img, w, f, x, 470, MUTED, a3)
        if i < len(words) - 1:
            d.ellipse([x + wd + gap//2 - 3, 480, x + wd + gap//2 + 3, 486], fill=DIM)
    # 版本
    a4 = ease_out(prog(t, 3.2, 0.8))
    text_center(img, 'v2.3', font(F_CODE, 18), 560, DIM, a4)
    # 淡出
    fo = prog(t, dur - 0.6, 0.6)
    if fo > 0:
        d.rectangle([0, 0, W, H], fill=mix(BG, hexc('000000'), fo * 0.6))

# --- 2. 痛点 ---
def draw_pain(img, t, dur):
    d = ImageDraw.Draw(img)
    lines = [
        ('网页里的 AI，只能聊天。', 0.3),
        ('想让它动你的文件？得复制粘贴来回折腾。', 1.6),
        ('其实，它可以更直接。', 3.4),
    ]
    for i, (s, st) in enumerate(lines):
        a = ease_out(prog(t, st, 0.7))
        up = int((1 - ease_out(prog(t, st, 0.7))) * 24)
        f = font(F_BOLD if i == 2 else F_REG, 40 if i == 2 else 34)
        color = BLUE if i == 2 else TEXT
        text_center(img, s, f, 300 + i * 90 - up, color, a)
    fo = prog(t, dur - 0.5, 0.5)
    if fo > 0:
        d.rectangle([0, 0, W, H], fill=mix(BG, hexc('000000'), fo * 0.5))

# --- 3. 核心能力 ---
def draw_power(img, t, dur):
    d = ImageDraw.Draw(img)
    text_center(img, '它现在能做什么', font(F_BOLD, 40), 90, TEXT, ease_out(prog(t, 0, 0.6)))
    items = [
        ('读写文件', '在真实目录里创建、修改、搜索'),
        ('执行命令', '跑测试、编译、调用系统工具'),
        ('连接数据', 'SQLite 查询、PDF 解析、JSON 转换'),
    ]
    for i, (title, sub) in enumerate(items):
        st = 0.8 + i * 0.75
        a = ease_out(prog(t, st, 0.6))
        if a <= 0: continue
        y = 220 + i * 140
        dx = int((1 - ease_out(prog(t, st, 0.6))) * -40)
        # 左侧色条
        d.rectangle([160 + dx, y, 164 + dx, y + 92], fill=mix(BG, BLUE, a))
        text_left(img, title, font(F_BOLD, 34), 200 + dx, y, TEXT, a)
        text_left(img, sub, font(F_REG, 22), 200 + dx, y + 52, MUTED, a)
    fo = prog(t, dur - 0.5, 0.5)
    if fo > 0:
        d.rectangle([0, 0, W, H], fill=mix(BG, hexc('000000'), fo * 0.5))

# --- 4. 自举 ---
CODE_LINES = [
    "({",
    "  name: 'get_weather',",
    "  execute: async (args) => {",
    "    const r = await fetch(url);",
    "    return await r.text();",
    "  }",
    "})",
]
def draw_bootstrap(img, t, dur):
    d = ImageDraw.Draw(img)
    text_center(img, '还能自己长出新能力', font(F_BOLD, 40), 80, TEXT, ease_out(prog(t, 0, 0.6)))
    text_center(img, 'AI 现场写插件，下一轮直接调用', font(F_REG, 22), 140, MUTED, ease_out(prog(t, 0.4, 0.6)))

    # 代码窗
    bw, bh = 760, 340
    bx, by = (W - bw) // 2, 210
    a = ease_out(prog(t, 0.6, 0.6))
    if a <= 0: return
    rounded(d, [bx, by, bx + bw, by + bh], 10, fill=CARD, outline=mix(BG, BORDER, a), width=1)
    # 窗口标题栏
    d.rectangle([bx, by, bx + bw, by + 38], fill=CARD2)
    for i, c in enumerate([hexc('ff5f56'), hexc('ffbd2e'), hexc('27c93f')]):
        d.ellipse([bx + 14 + i * 18, by + 14, bx + 24 + i * 18, by + 24], fill=c)
    text_left(img, 'plugins/get_weather.js', font(F_CODE, 14), bx + 90, by + 11, DIM)

    # 逐行打字
    f_code = font(F_CODE, 17)
    line_h = 36
    chars_per_sec = 38
    elapsed = max(0.0, t - 1.2)
    budget = elapsed * chars_per_sec
    y = by + 60
    for ln in CODE_LINES:
        if budget <= 0: break
        show = ln[:int(min(len(ln), budget))]
        budget -= len(ln)
        # 简单着色
        color = MUTED
        if 'name:' in show or 'execute' in show or 'const' in show or 'return' in show:
            color = hexc('c8c8d4')
        text_left(img, show, f_code, bx + 24, y, color, a)
        if budget > 0 and show == ln and 'toolcall' not in ln:
            pass
        y += line_h
        if y > by + bh - 20: break

    # 完成后标记
    done_a = ease_out(prog(t, 5.2, 0.6))
    if done_a > 0:
        text_center(img, '注册成功 · 立即可用', font(F_REG, 20), by + bh + 30, GREEN, done_a)

    fo = prog(t, dur - 0.5, 0.5)
    if fo > 0:
        d.rectangle([0, 0, W, H], fill=mix(BG, hexc('000000'), fo * 0.5))

# --- 5. 插件矩阵 ---
PLUGIN_NAMES = ['python','git','进程','通知','截图','语音','环境','网络',
                '服务器','WiFi','下载','压缩','PDF','SQLite','JSON','图片','加密','二维码']
def draw_plugins(img, t, dur):
    d = ImageDraw.Draw(img)
    text_center(img, '18 项原生插件，开箱即用', font(F_BOLD, 40), 70, TEXT, ease_out(prog(t, 0, 0.6)))

    cols, rows = 6, 3
    cw, ch = 168, 96
    gapx, gapy = 20, 20
    total_w = cols * cw + (cols - 1) * gapx
    total_h = rows * ch + (rows - 1) * gapy
    startx = (W - total_w) // 2
    starty = 190

    for i, name in enumerate(PLUGIN_NAMES):
        r, c = divmod(i, cols)
        st = 0.5 + i * 0.09
        a = ease_out(prog(t, st, 0.5))
        if a <= 0: continue
        x = startx + c * (cw + gapx)
        y = starty + r * (ch + gapy)
        off = int((1 - ease_out(prog(t, st, 0.5))) * 16)
        # 卡片
        fill = mix(BG, CARD, a)
        outline = mix(BG, mix(BORDER, BLUE, 0.35), a)
        rounded(d, [x, y + off, x + cw, y + ch + off], 8, fill=fill, outline=outline, width=1)
        # 名称
        f = font(F_BOLD, 17)
        wd, _ = text_w(d, name, f)
        text_left(img, name, f, x + (cw - wd) // 2, y + 38 + off, mix(BG, TEXT, a), a)

    # 底部统计
    a2 = ease_out(prog(t, 2.6, 0.7))
    text_center(img, '开发执行 · 系统控制 · 网络 · 文件处理', font(F_REG, 20), 570, MUTED, a2)

    fo = prog(t, dur - 0.5, 0.5)
    if fo > 0:
        d.rectangle([0, 0, W, H], fill=mix(BG, hexc('000000'), fo * 0.5))

# --- 6. 结尾 ---
def draw_outro(img, t, dur):
    d = ImageDraw.Draw(img)
    # 中线
    p = ease_out(prog(t, 0, 0.7))
    cx, cy = W // 2, 300
    half = int(300 * p)
    d.rectangle([cx - half, cy - 1, cx + half, cy + 1], fill=BLUE)

    a1 = ease_out(prog(t, 0.4, 0.9))
    text_center(img, '开源 · 零 API 成本', font(F_BOLD, 52), 210, TEXT, a1)

    a2 = ease_out(prog(t, 1.2, 0.9))
    text_center(img, 'github.com/HanabiraMF/deepseek-webtoharness', font(F_CODE, 26), 340, BLUE, a2)

    a3 = ease_out(prog(t, 2.2, 0.9))
    text_center(img, '下载即用 · 18 项插件 · 无限拓展', font(F_REG, 22), 410, MUTED, a3)

    a4 = ease_out(prog(t, 3.2, 0.8))
    text_center(img, 'DeepSeek WebtoHarness', font(F_BOLD, 24), 540, DIM, a4)

# ===== 主循环 =====
def render():
    dur = TOTAL_DUR
    total = int(dur * FPS)
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [ff, '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo',
           '-s', f'{W}x{H}', '-pix_fmt', 'rgb24', '-r', str(FPS),
           '-i', '-', '-an', '-vcodec', 'libx264', '-preset', 'medium',
           '-crf', '19', '-pix_fmt', 'yuv420p', OUT]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    handlers = {
        'intro': draw_intro, 'pain': draw_pain, 'power': draw_power,
        'bootstrap': draw_bootstrap, 'plugins': draw_plugins, 'outro': draw_outro,
    }

    for i in range(total):
        t = i / FPS
        name, lt, ldur = scene_at(t)
        img = Image.new('RGB', (W, H), BG)
        top_line(img, t, mix(BG, BLUE, 0.35))
        handlers[name](img, lt, ldur)
        proc.stdin.write(img.tobytes())
        if i % 120 == 0:
            print(f'  帧 {i}/{total}  场景={name}  {i*100//total}%', flush=True)
    proc.stdin.close()
    err = proc.stderr.read().decode('utf8', 'ignore')
    proc.wait()
    if proc.returncode != 0:
        print('ffmpeg 失败:'); print(err[-2000:]); sys.exit(1)
    size = os.path.getsize(OUT) / 1024 / 1024
    print(f'\n完成: {OUT}')
    print(f'时长 {dur:.0f}s  帧数 {total}  大小 {size:.1f}MB')

if __name__ == '__main__':
    render()
