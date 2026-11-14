const fs = require('fs');
const vm = require('vm');
const { resolveWsPath } = require('./_workspace');

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

// 允许的数学函数
const MATH = {
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
    sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow, exp: Math.exp,
    log: Math.log, log2: Math.log2, log10: Math.log10,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    min: (...a) => Math.min.apply(null, a.length === 1 && Array.isArray(a[0]) ? a[0] : a),
    max: (...a) => Math.max.apply(null, a.length === 1 && Array.isArray(a[0]) ? a[0] : a),
    sign: Math.sign, trunc: Math.trunc,
    hypot: Math.hypot, random: Math.random,
    PI: Math.PI, E: Math.E,
    sum: (arr) => [].concat(arr).reduce((a, b) => a + b, 0),
    avg: (arr) => { const a = [].concat(arr); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; },
    mean: (arr) => { const a = [].concat(arr); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; },
    median: (arr) => { const a = [].concat(arr).slice().sort((x, y) => x - y); if (!a.length) return NaN; const mid = a.length >> 1; return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2; },
    stdev: (arr) => { const a = [].concat(arr); if (!a.length) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length); },
    round_to: (n, d) => { const f = Math.pow(10, d || 0); return Math.round(n * f) / f; }
};

// 禁止访问 require/process 等
function safetyScan(expr) {
    const banned = /(require\s*\(|process|global|globalThis|module|exports|__dirname|__filename|this\s*\.|constructor|prototype|import\s*\(|while\s*\(|for\s*\(|function\s*\()/;
    const hit = expr.match(banned);
    return hit ? hit[0] : null;
}

function buildContext(extra) {
    const ctx = Object.assign({}, MATH);
    if (extra && typeof extra === 'object') {
        for (const k of Object.keys(extra)) {
            if (typeof extra[k] === 'number' || typeof extra[k] === 'string' || typeof extra[k] === 'boolean' || Array.isArray(extra[k])) {
                ctx[k] = extra[k];
            }
        }
    }
    return ctx;
}

module.exports = {
    name: 'calc_eval',
    description: "表达式求值/快速计算：四则运算、数学函数、数组统计",
    params: [
        { k: "expr", cn: "表达式", req: true, d: "可逗号或换行分隔多个" },
        { k: "vars", cn: "变量", req: false, d: "JSON 字符串，如 {\"a\":3}" },
        { k: "source", cn: "表达式文件", req: false, d: "每行一个表达式" },
        { k: "precision", cn: "小数位", req: false, d: "默认保留原始精度" }
    ],
    execute: async (args) => {
        let exprs = V(args, 'expr') || V(args, 'expression') || V(args, 'text');
        const source = V(args, 'source') || V(args, 'path');
        if (source) {
            const abs = await resolveWsPath(source);
            if (!fs.existsSync(abs)) return '错误：文件不存在 ' + source;
            exprs = fs.readFileSync(abs, 'utf8');
        }
        if (!exprs) return '错误：缺少 expr';

        // 智能切分：换行/分号总是切分；逗号仅在括号深度为 0 时切分（避免切断函数参数）
        const list = [];
        let buf = '';
        let depth = 0;
        const pushBuf = () => { const t = buf.trim(); if (t) list.push(t); buf = ''; };
        for (const ch of exprs) {
            if (ch === '(' || ch === '[' || ch === '{') { depth++; buf += ch; continue; }
            if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; buf += ch; continue; }
            if (ch === '\n' || ch === ';') { pushBuf(); continue; }
            if (ch === ',' && depth === 0) { pushBuf(); continue; }
            buf += ch;
        }
        pushBuf();
        if (!list.length) return '错误：expr 为空';

        let vars = {};
        const varsRaw = V(args, 'vars');
        if (varsRaw) {
            try { vars = JSON.parse(varsRaw); } catch (e) { return '错误：vars 不是合法 JSON - ' + e.message; }
        }
        const precisionRaw = V(args, 'precision');
        const precision = precisionRaw === '' ? null : Math.min(Math.max(parseInt(precisionRaw, 10) || 0, 0), 15);

        const ctx = buildContext(vars);
        const sandbox = vm.createContext(ctx);
        const lines = [];
        let okCount = 0, failCount = 0;

        for (const e of list.slice(0, 100)) {
            const bad = safetyScan(e);
            if (bad) { lines.push('❌ ' + e + '  →  含不允许的语法: ' + bad); failCount++; continue; }
            try {
                const val = vm.runInContext('(' + e + ')', sandbox, { timeout: 2000 });
                let out;
                if (typeof val === 'number') {
                    out = precision != null ? Number(val.toFixed(precision)) : val;
                } else if (typeof val === 'object' && val !== null) {
                    out = JSON.stringify(val);
                } else {
                    out = String(val);
                }
                lines.push('✅ ' + e + '  =  ' + out);
                okCount++;
            } catch (err) {
                lines.push('❌ ' + e + '  →  ' + err.message);
                failCount++;
            }
        }

        return `计算完成（成功 ${okCount} / 失败 ${failCount}）\n` + lines.join('\n');
    }
};
