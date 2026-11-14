const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    if (ex.toolcall) {
        const m = String(ex.toolcall).match(new RegExp('<' + k + '>([\\s\\S]*?)<\\/' + k + '>', 'i'));
        if (m) { let v = m[1]; const c = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/); if (c) v = c[1]; return v.trim(); }
    }
    return '';
};

module.exports = {
    name: 'regex_test',
    description: "正则测试：查看是否匹配、匹配结果与分组",
    params: [
        { k: "pattern", cn: "正则", req: true, d: "" },
        { k: "flags", cn: "标志", req: false, d: "如 g / gi / gm，默认 g" },
        { k: "text", cn: "文本", req: false, d: "" },
        { k: "source", cn: "源文件", req: false, d: "优先于 text" },
        { k: "limit", cn: "数量上限", req: false, d: "默认 30" }
    ],
    execute: async (args) => {
        const pattern = V(args, 'pattern');
        if (!pattern) return '错误：缺少 pattern';
        let flags = V(args, 'flags') || 'g';
        if (!flags.includes('g')) flags += 'g';

        let text = V(args, 'text');
        const source = V(args, 'source') || V(args, 'path');
        if (source) {
            const { resolveWsPath } = require('./_workspace');
            const fs = require('fs');
            const abs = await resolveWsPath(source);
            if (!fs.existsSync(abs)) return '错误：文件不存在 ' + source;
            text = fs.readFileSync(abs, 'utf8');
        }
        if (text === '') return '错误：需要 text 或 source';

        let re;
        try { re = new RegExp(pattern, flags); }
        catch (e) { return '正则编译失败: ' + e.message; }

        const limit = Math.min(Math.max(parseInt(V(args, 'limit') || '30', 10) || 30, 1), 500);
        const matches = [];
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null) {
            matches.push(m);
            if (m[0] === '') re.lastIndex++;
            if (matches.length >= limit) break;
            if (++guard > 100000) break;
        }

        if (!matches.length) {
            // 单次测试（不带 g 的语义）也顺便给结论
            return '❌ 未匹配到任何结果\n正则: /' + pattern + '/' + flags + '\n文本长度: ' + text.length;
        }

        const lines = ['✅ 匹配到 ' + matches.length + (matches.length >= limit ? '+（已截断到 ' + limit + '）' : '') + ' 处\n'];
        matches.forEach((mm, i) => {
            const ctx = mm.index >= 0 ? ' @' + mm.index : '';
            lines.push(`[${i + 1}] ${JSON.stringify(mm[0])}${ctx}`);
            for (let g = 1; g < mm.length; g++) {
                lines.push('      $' + g + ' = ' + JSON.stringify(mm[g]));
            }
            if (mm.groups) {
                for (const k of Object.keys(mm.groups)) lines.push('      <' + k + '> = ' + JSON.stringify(mm.groups[k]));
            }
        });
        return lines.join('\n');
    }
};
