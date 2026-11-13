const { resolveWsPath, getWorkspace } = require('./_workspace');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
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
    name: 'screenshot',
    description: '截取当前主屏幕并保存为工作区内的 png，返回相对路径（可配合 image 工具直接查看）。参数：filename(可选)。',
    execute: async (args) => {
        const filename = (V(args, 'filename') || ('screenshot_' + Date.now() + '.png')).replace(/[<>:"|?*]/g, '_');
        const absPath = await resolveWsPath(filename);
        const ps = `
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
            $graphic = [System.Drawing.Graphics]::FromImage($bmp)
            $graphic.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
            $bmp.Save('${absPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
            $graphic.Dispose()
            $bmp.Dispose()
        `;
        const tmpFile = path.join(os.tmpdir(), 'ds_shot_' + Date.now() + '.ps1');
        
        try {
            fs.writeFileSync(tmpFile, '\uFEFF' + ps, 'utf8');
        } catch (e) {
            return '创建临时脚本失败: ' + e.message;
        }

        return new Promise((resolve) => {
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
                try { fs.unlinkSync(tmpFile); } catch (e) {}
                if (err) return resolve('截图失败: ' + (stderr || err.message));
                if (fs.existsSync(absPath)) {
                    const kb = (fs.statSync(absPath).size / 1024).toFixed(1);
                    resolve('截图成功：' + filename + '（' + kb + 'KB）。如需查看请调用 image 工具。');
                } else {
                    resolve('命令已执行但未生成文件，可能缺少屏幕访问权限。');
                }
            });
        });
    }
};
