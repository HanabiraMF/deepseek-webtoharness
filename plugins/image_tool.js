const { resolveWsPath, getWorkspace } = require('./_workspace');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    return '';
};

module.exports = {
    name: 'image_tool',
    description: "图片缩放与格式转换",
    params: [
        { k: "source", cn: "源图片", req: true, d: "" },
        { k: "dest", cn: "目标图片", req: true, d: "" },
        { k: "width", cn: "宽度", req: false, d: "像素，不填按比例" },
        { k: "height", cn: "高度", req: false, d: "像素，不填按比例" },
        { k: "format", cn: "输出格式", req: false, d: "jpg / png / bmp / gif，默认按扩展名" }
    ],
    execute: async (args) => {
        const source = V(args, 'source');
        const dest = V(args, 'dest');
        if (!source || !dest) return '错误：需要 source 和 dest';
        const srcAbs = await resolveWsPath(source);
        const dstAbs = await resolveWsPath(dest);
        if (!fs.existsSync(srcAbs)) return '错误：源图片不存在 ' + source;
        const dir = path.dirname(dstAbs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const w = parseInt(V(args, 'width') || '0', 10);
        const h = parseInt(V(args, 'height') || '0', 10);
        const fmt = (V(args, 'format') || path.extname(dest).slice(1)).toLowerCase();
        const fmtMap = { jpg: 'Jpeg', jpeg: 'Jpeg', png: 'Png', bmp: 'Bmp', gif: 'Gif' };
        const fmtStr = fmtMap[fmt] || 'Png';

        const ps = `
            Add-Type -AssemblyName System.Drawing
            $img = [System.Drawing.Image]::FromFile('${srcAbs.replace(/\\/g, '\\\\')}')
            $nw = ${w > 0 ? w : 0}
            $nh = ${h > 0 ? h : 0}
            if ($nw -eq 0 -and $nh -eq 0) {
                $nw = $img.Width; $nh = $img.Height
            } elseif ($nw -eq 0) {
                $nw = [int]($img.Width * ($nh / $img.Height))
            } elseif ($nh -eq 0) {
                $nh = [int]($img.Height * ($nw / $img.Width))
            }
            $new = New-Object System.Drawing.Bitmap($nw, $nh)
            $g = [System.Drawing.Graphics]::FromImage($new)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.DrawImage($img, 0, 0, $nw, $nh)
            $new.Save('${dstAbs.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::${fmtStr})
            $g.Dispose()
            $new.Dispose()
            $img.Dispose()
        `;
        const tmpFile = path.join(os.tmpdir(), 'ds_img_' + Date.now() + '.ps1');
        fs.writeFileSync(tmpFile, '\uFEFF' + ps, 'utf8');
        return new Promise((resolve) => {
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
                try { fs.unlinkSync(tmpFile); } catch (e) {}
                if (err) return resolve('图片处理失败: ' + (stderr || err.message));
                if (fs.existsSync(dstAbs)) {
                    const stat = fs.statSync(dstAbs);
                    resolve(`图片处理成功: ${dest} (${(stat.size/1024).toFixed(1)}KB)。如需查看，请用 attach 把该文件送进对话。`);
                } else {
                    resolve('命令执行但未生成文件');
                }
            });
        });
    }
};
