# -*- coding: utf-8 -*-
import imageio_ffmpeg, subprocess, os
ff = imageio_ffmpeg.get_ffmpeg_exe()
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, 'promo.mp4')
times = [3.5, 13.0, 26.0, 42.0, 55.0, 67.0]
names = ['1_intro', '2_pain', '3_power', '4_bootstrap', '5_plugins', '6_outro']
for tm, nm in zip(times, names):
    out = os.path.join(here, 'shot_' + nm + '.png')
    subprocess.run([ff, '-y', '-ss', str(tm), '-i', src, '-frames:v', '1', out],
                   capture_output=True)
    print(nm, os.path.getsize(out), 'bytes')
