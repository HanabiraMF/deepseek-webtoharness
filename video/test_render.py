# -*- coding: utf-8 -*-
"""测试渲染管线：PIL 画帧 -> ffmpeg 合成 mp4"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

W, H, FPS = 1280, 720, 30
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test.mp4')
FONT_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
FONT_CODE = 'C:/Windows/Fonts/consola.ttf'

def hexc(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

BG = hexc('08080a')
TEXT = hexc('f5f5f7')
MUTED = hexc('9a9aa5')
BLUE = hexc('5686fe')

def ease_out(t):
    return 1 - pow(1 - t, 3)

def render_frame(t, dur):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)

    # 顶部细线
    d.rectangle([0, 0, W, 2], fill=BLUE)

    # 主标题淡入上移
    p = min(1.0, t / 0.8)
    e = ease_out(p)
    y = int(300 + (1 - e) * 30)
    f_title = ImageFont.truetype(FONT_BOLD, 64)
    title = '赋予网页 AI 本地能力'
    bb = d.textbbox((0, 0), title, font=f_title)
    tw = bb[2] - bb[0]
    # 用灰度遮罩模拟淡入
    layer = Image.new('RGB', (W, H), BG)
    ld = ImageDraw.Draw(layer)
    ld.text(((W - tw) // 2, y), title, font=f_title, fill=TEXT)
    alpha = int(255 * e)
    img = Image.composite(layer, img, Image.new('L', (W, H), alpha))
    d = ImageDraw.Draw(img)

    # 副标题
    p2 = min(1.0, max(0, (t - 0.4) / 0.8))
    if p2 > 0:
        e2 = ease_out(p2)
        f_sub = ImageFont.truetype(FONT_BOLD, 28)
        sub = 'DeepSeek WebtoHarness'
        sb = d.textbbox((0, 0), sub, font=f_sub)
        sw = sb[2] - sb[0]
        layer = Image.new('RGB', (W, H), BG)
        ld = ImageDraw.Draw(layer)
        ld.text(((W - sw) // 2, 390), sub, font=f_sub, fill=BLUE)
        img = Image.composite(layer, img, Image.new('L', (W, H), int(255 * e2)))
        d = ImageDraw.Draw(img)

    # 进度条
    if t > 1.5:
        prog = min(1.0, (t - 1.5) / 2)
        d.rectangle([W//2 - 200, 470, W//2 + 200, 474], fill=hexc('1a1a22'))
        d.rectangle([W//2 - 200, 470, W//2 - 200 + int(400 * prog), 474], fill=BLUE)

    return img

def main():
    dur = 6.0
    total = int(dur * FPS)
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [ff, '-y', '-f', 'rawvideo', '-vcodec', 'rawvideo',
           '-s', f'{W}x{H}', '-pix_fmt', 'rgb24', '-r', str(FPS),
           '-i', '-', '-an', '-vcodec', 'libx264', '-preset', 'medium',
           '-crf', '18', '-pix_fmt', 'yuv420p', OUT]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for i in range(total):
        t = i / FPS
        frame = render_frame(t, dur)
        proc.stdin.write(frame.tobytes())
        if i % 30 == 0:
            print(f'  帧 {i}/{total}')
    proc.stdin.close()
    err = proc.stderr.read().decode('utf8', 'ignore')
    proc.wait()
    if proc.returncode != 0:
        print('ffmpeg 失败:'); print(err[-1500:]); sys.exit(1)
    size = os.path.getsize(OUT) / 1024
    print(f'完成: {OUT}  {size:.0f}KB  {total}帧')

if __name__ == '__main__':
    main()
