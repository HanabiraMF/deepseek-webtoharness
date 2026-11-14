const { resolveWsPath, V } = require('./_workspace');
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = {
    name: 'svg_gen',
    description: "生成 SVG 矢量图：快速模板 / 源码文件 / base64 源码",
    params: [
        { k: "dest", cn: "保存路径", req: false, d: "默认 svg_时间戳.svg" },
        { k: "svg_b64", cn: "源码base64", req: false, d: "推荐传完整自定义源码，避免 XML 截断" },
        { k: "src", cn: "源SVG文件", req: false, d: "工作区内已有 svg 路径" },
        { k: "text", cn: "文字", req: false, d: "快速模式用，\\n 换行" },
        { k: "width", cn: "宽度", req: false, d: "默认 600" },
        { k: "height", cn: "高度", req: false, d: "默认 400" },
        { k: "fill", cn: "文字色", req: false, d: "默认 #222" },
        { k: "bg", cn: "背景色", req: false, d: "默认 #fff" }
    ],
    execute: async (args) => {
        const destRaw = V(args, 'dest') || ('svg_' + Date.now() + '.svg');
        const dest = /\.svg$/i.test(destRaw) ? destRaw : destRaw + '.svg';
        const src = V(args, 'src');
        const b64 = V(args, 'svg_b64') || V(args, 'svgb64');
        const svgSrc = V(args, 'svg');

        let content = '';
        if (src) {
            const absSrc = await resolveWsPath(src);
            if (!fs.existsSync(absSrc)) return '错误：src 文件不存在: ' + src;
            content = fs.readFileSync(absSrc, 'utf8');
        } else if (b64) {
            try {
                content = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
            } catch (e) {
                return '错误：svg_b64 解码失败: ' + e.message;
            }
        } else if (svgSrc && svgSrc.trim()) {
            content = svgSrc.trim();
            if (!/<\/svg\s*>/i.test(content)) {
                return '错误：svg 源码不完整（缺少 </svg> 结尾），很可能是 XML 解析截断。请改用 svg_b64（base64 编码）或 src（先写文件再引用）传入完整源码。';
            }
        } else {
            const width = parseInt(V(args, 'width') || '600', 10) || 600;
            const height = parseInt(V(args, 'height') || '400', 10) || 400;
            const text = V(args, 'text') || 'SVG';
            const fill = V(args, 'fill') || '#222222';
            const bg = V(args, 'bg') || '#ffffff';
            const lines = String(text).split(/\\n|\n/);
            const fontSize = Math.max(14, Math.min(48, Math.floor(height / (lines.length + 2))));
            const lineH = Math.round(fontSize * 1.3);
            const startY = Math.round(height / 2 - ((lines.length - 1) * lineH) / 2);
            const tspans = lines.map((ln, i) =>
                '<tspan x="' + (width / 2) + '" y="' + (startY + i * lineH) + '">' + esc(ln) + '</tspan>'
            ).join('');
            content = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
                '<rect width="100%" height="100%" fill="' + esc(bg) + '"/>' +
                '<text font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="' + fontSize + '" fill="' + esc(fill) + '" text-anchor="middle" dominant-baseline="middle">' +
                tspans + '</text></svg>';
        }

        if (!/<svg[\s>]/i.test(content)) return '错误：内容中未找到 <svg> 标签。';

        const abs = await resolveWsPath(dest);
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        const kb = (fs.statSync(abs).size / 1024).toFixed(2);
        return 'SVG 已生成：' + dest + '（' + kb + 'KB）。展示给用户可调用 image/preview；要让 AI 自己看到渲染结果，请用 attach 把该文件送进对话。';
    }
};
