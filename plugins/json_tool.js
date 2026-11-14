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
    description: "JSON 格式化、压缩、校验、转 CSV",
    params: [
        { k: "action", cn: "操作", req: true, d: "format / minify / validate / to_csv" },
        { k: "source", cn: "源文件", req: false, d: "不填则用 text" },
        { k: "text", cn: "JSON 文本", req: false, d: "" },
        { k: "dest", cn: "输出文件", req: false, d: "不填直接返回" }
    ],
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
