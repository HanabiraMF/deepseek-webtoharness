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
    description: `
从 URL 下载文件保存到工作区（基于 Node 原生 fetch，流式写入，不占内存，支持大文件）。
【参数】
- url: 下载链接
- dest: 保存的文件相对路径 (如 "downloads/video.mp4")
【示例】
{"op":"download_file","url":"https://example.com/image.png","dest":"test.png"}
`,
    execute: async (args) => {
        const url = V(args, 'url');
        const dest = V(args, 'dest');
        if (!url || !dest) return '错误：需要 url 和 dest 参数';

        const absPath = path.resolve(process.cwd(), dest);
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
