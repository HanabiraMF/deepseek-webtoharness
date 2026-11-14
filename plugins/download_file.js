const { resolveWsPath, getWorkspace } = require('./_workspace');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

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
    name: 'download_file',
    description: "从 URL 下载文件保存到工作区，流式写入支持大文件",
    params: [
        { k: "url", cn: "下载链接", req: true, d: "" },
        { k: "dest", cn: "保存路径", req: true, d: "如 downloads/video.mp4" }
    ],
    execute: async (args) => {
        const url = V(args, 'url');
        const dest = V(args, 'dest');
        if (!url || !dest) return '错误：需要 url 和 dest 参数';

        const absPath = await resolveWsPath(dest);
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        try {
            const res = await fetch(url);
            if (!res.ok) return `下载失败: HTTP ${res.status} ${res.statusText}`;
            if (!res.body) return '下载失败: 响应体为空';

            const fileStream = fs.createWriteStream(absPath);
            await pipeline(Readable.fromWeb(res.body), fileStream);

            const stat = fs.statSync(absPath);
            const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
            return `下载成功: ${dest} (${sizeMB} MB)`;
        } catch (e) {
            return '下载出错: ' + e.message;
        }
    }
};
