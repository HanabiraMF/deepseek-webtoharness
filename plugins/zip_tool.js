const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

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
    name: 'zip_tool',
    description: "压缩或解压文件",
    params: [
        { k: "action", cn: "操作", req: true, d: "compress / extract" },
        { k: "source", cn: "源路径", req: true, d: "" },
        { k: "target", cn: "目标路径", req: true, d: "" }
    ],
    execute: async (args) => {
        const action = V(args, 'action').trim().toLowerCase();
        const source = V(args, 'source').trim();
        const target = V(args, 'target').trim();
        if (!action || !source || !target) return '错误：需要 action, source, target';
        if (action !== 'compress' && action !== 'extract') return '错误：action 必须是 compress 或 extract';
        if (!fs.existsSync(source)) return '错误：源路径不存在: ' + source;
        if (action === 'compress' && !path.extname(target)) return '错误：压缩时 target 需带扩展名，如 out.zip';

        const ps = action === 'compress'
            ? "Compress-Archive -LiteralPath '" + source + "' -DestinationPath '" + target + "' -Force"
            : "Expand-Archive -LiteralPath '" + source + "' -DestinationPath '" + target + "' -Force";

        return new Promise((resolve) => {
            exec('powershell -NoProfile -Command "' + ps + '"', { timeout: 60000, windowsHide: true }, (err) => {
                if (err) return resolve('操作失败: ' + err.message);
                let info = '';
                try {
                    const st = fs.statSync(action === 'compress' ? target : target);
                    info = '（' + (st.isDirectory() ? '目录' : (st.size / 1024).toFixed(1) + 'KB') + '）';
                } catch (e) {}
                resolve((action === 'compress' ? '压缩成功: ' : '解压成功到: ') + target + info);
            });
        });
    }
};
