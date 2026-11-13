const { resolveWsPath, getWorkspace } = require('./_workspace');
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
    name: 'json_tool',
    description: `
JSON 处理工具：格式化、压缩、校验、JSON 转 CSV。
【参数】
- action: 'format' (格式化) / 'minify' (压缩) / 'validate' (校验) / 'to_csv' (转CSV)
- source: (可选) 文件路径。如果不填则使用 text 参数
- text: (可选) 直接的 JSON 字符串
- dest: (可选) 输出文件路径。不填则直接返回结果
【示例】
{"op":"json_tool","action":"format","source":"data.json"}
{"op":"json_tool","action":"validate","text":"{\\"a\\":1}"}
`,
    execute: async (args) => {
        const action = V(args, 'action');
        const source = V(args, 'source');
        const text = V(args, 'text');
        const dest = V(args, 'dest');
        if (!action) return '错误：缺少 action';

        let rawStr = text;
        if (source) {
            const abs = await resolveWsPath(source);
            if (!fs.existsSync(abs)) return '错误：文件不存在 ' + source;
            rawStr = fs.readFileSync(abs, 'utf8');
        }
        if (!rawStr) return '错误：需要 source 或 text';

        let data;
        try {
            data = JSON.parse(rawStr);
        } catch (e) {
            return 'JSON 解析失败: ' + e.message;
        }

        if (action === 'validate') {
            return 'JSON 格式合法 ✅';
        }

        let out = '';
        if (action === 'format') {
            out = JSON.stringify(data, null, 2);
        } else if (action === 'minify') {
            out = JSON.stringify(data);
        } else if (action === 'to_csv') {
            if (!Array.isArray(data)) return '错误：根节点必须是数组才能转 CSV';
            if (!data.length) return '空数组';
            const headers = Object.keys(data[0]);
            const escapeCsv = (v) => {
                if (v === null || v === undefined) return '';
                const s = String(v).replace(/"/g, '""');
                return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s;
            };
            const lines = [headers.map(escapeCsv).join(',')];
            for (const row of data) {
                lines.push(headers.map(h => escapeCsv(row[h])).join(','));
            }
            out = lines.join('\n');
        } else {
            return '错误：action 必须是 format / minify / validate / to_csv';
        }

        if (dest) {
            const absDest = await resolveWsPath(dest);
            const dir = path.dirname(absDest);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absDest, out, 'utf8');
            return `${action} 成功，已保存到 ${dest}`;
        }
        return out;
    }
};
