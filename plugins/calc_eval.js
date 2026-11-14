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

// ===== 任意精度整数求值器（BigInt）=====
// 支持：整数字面量、+ - * / % **、一元正负号、括号、变量名
// 除不尽或含小数时返回失败，交由 Number 路径处理
function tokenizeBigInt(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9]/.test(c)) {
            let j = i;
            while (j < s.length && /[0-9_]/.test(s[j])) j++;
            tokens.push({ t: 'num', v: s.slice(i, j).replace(/_/g, '') });
            i = j;
            continue;
        }
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
            tokens.push({ t: 'id', v: s.slice(i, j) });
            i = j;
            continue;
        }
        if (s.startsWith('**', i)) { tokens.push({ t: 'op', v: '**' }); i += 2; continue; }
        if ('+-*/%()'.indexOf(c) >= 0) { tokens.push({ t: 'op', v: c }); i++; continue; }
        throw new Error('非法字符: ' + c);
    }
    return tokens;
}

function evalBigIntExpr(expr, vars) {
    let tokens, pos = 0;
    try { tokens = tokenizeBigInt(String(expr)); } catch (e) { return { ok: false, error: e.message }; }
    if (!tokens.length) return { ok: false, error: '空表达式' };

    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const isOp = (v) => { const t = peek(); return !!t && t.t === 'op' && t.v === v; };

    function toBig(x) {
        if (typeof x === 'bigint') return x;
        if (typeof x === 'number') { if (!Number.isInteger(x)) return null; return BigInt(x); }
        if (typeof x === 'string') { const s = x.trim(); if (!/^-?\d+$/.test(s)) return null; return BigInt(s); }
        return null;
    }

    function parseExpr() {
        let v = parseTerm();
        while (isOp('+') || isOp('-')) {
            const op = next().v;
            const r = parseTerm();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    }
    function parseTerm() {
        let v = parseUnary();
        while (isOp('*') || isOp('/') || isOp('%')) {
            const op = next().v;
            const r = parseUnary();
            if (op === '*') { v = v * r; }
            else {
                if (r === 0n) throw new Error('除零');
                if (op === '/' && v % r !== 0n) throw new Error('结果非整数');
                v = op === '/' ? v / r : v % r;
            }
        }
        return v;
    }
    function parseUnary() {
        if (isOp('+')) { next(); return parseUnary(); }
        if (isOp('-')) { next(); return -parsePower(); }
        return parsePower();
    }
    function parsePower() {
        const base = parseAtom();
        if (isOp('**')) {
            next();
            const exp = parseUnary();
            if (exp < 0n) throw new Error('负指数不支持大数模式');
            if (exp > 100000n) throw new Error('指数过大（上限 100000）');
            return base ** exp;
        }
        return base;
    }
    function parseAtom() {
        const t = peek();
        if (!t) throw new Error('表达式不完整');
        if (t.t === 'num') { pos++; return BigInt(t.v); }
        if (t.t === 'id') {
            pos++;
            if (!vars || !Object.prototype.hasOwnProperty.call(vars, t.v)) throw new Error('未知变量 ' + t.v);
            const b = toBig(vars[t.v]);
            if (b === null) throw new Error('变量非整数 ' + t.v);
            return b;
        }
        if (t.t === 'op' && t.v === '(') {
            pos++;
            const v = parseExpr();
            if (!isOp(')')) throw new Error('缺少右括号');
            pos++;
            return v;
        }
        throw new Error('意外符号 ' + t.v);
    }

    try {
        const v = parseExpr();
        if (pos !== tokens.length) return { ok: false, error: '存在多余内容' };
        return { ok: true, value: v };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 判断是否值得走 BigInt 路径
function shouldUseBigInt(expr, vars, numVal) {
    const nums = String(expr).match(/\d+/g) || [];
    for (const n of nums) {
        if (n.length > 16) return true;
        if (n.length === 16 && BigInt(n) > BigInt(Number.MAX_SAFE_INTEGER)) return true;
    }
    if (vars && typeof vars === 'object') {
        for (const k of Object.keys(vars)) {
            const x = vars[k];
            if (typeof x === 'string' && /^-?\d{16,}$/.test(x.trim())) return true;
            if (typeof x === 'bigint') return true;
        }
    }
    if (typeof numVal === 'number') {
        if (Number.isInteger(numVal) && Math.abs(numVal) > Number.MAX_SAFE_INTEGER) return true;
        if (!Number.isFinite(numVal) && /\*\*|\*/.test(String(expr))) return true;
    }
    return false;
}

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
    description: "表达式求值/快速计算：四则运算、数学函数、数组统计；大整数自动精确计算",
    params: [
        { k: "expr", cn: "表达式", req: true, d: "可逗号或换行分隔多个。乘方用 ** 而非 ^（^ 是位异或）。大整数（如 2**200）会自动用 BigInt 精确计算" },
        { k: "vars", cn: "变量", req: false, d: "JSON 字符串，如 {\"a\":3}" },
        { k: "source", cn: "表达式文件", req: false, d: "每行一个表达式" },
        { k: "precision", cn: "小数位", req: false, d: "默认保留原始精度（仅小数结果生效）" },
        { k: "bigint", cn: "大数模式", req: false, d: "auto（默认，检测到超大整数时自动精确计算）/ on（强制精确整数）/ off（禁用，只用浮点）" }
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
        const bigintMode = (V(args, 'bigint') || 'auto').toLowerCase();

        const ctx = buildContext(vars);
        const sandbox = vm.createContext(ctx);
        const lines = [];
        let okCount = 0, failCount = 0;
        let bigCount = 0;

        for (const e of list.slice(0, 100)) {
            const bad = safetyScan(e);
            if (bad) { lines.push('❌ ' + e + '  →  含不允许的语法: ' + bad); failCount++; continue; }

            // 1) 先走 Number 路径（保留全部原有能力）
            let numVal, numErr = null;
            try {
                numVal = vm.runInContext('(' + e + ')', sandbox, { timeout: 2000 });
            } catch (err) { numErr = err; }

            // 2) 判断是否需要 BigInt 精确路径
            // auto 模式：Number 成功且疑似精度不足 → 用 BigInt 重算；
            //            Number 失败（如 -2**100 这类 JS 语法限制）→ 也尝试 BigInt 兜底
            const wantBig = bigintMode === 'on' ||
                (bigintMode === 'auto' && (numErr || shouldUseBigInt(e, vars, numVal)));

            if (wantBig) {
                const r = evalBigIntExpr(e, vars);
                if (r.ok) {
                    lines.push('✅ ' + e + '  =  ' + r.value.toString() + '  （BigInt 精确）');
                    okCount++; bigCount++;
                    continue;
                }
                if (bigintMode === 'on') {
                    lines.push('❌ ' + e + '  →  大数模式无法计算: ' + (r.error || '未知原因'));
                    failCount++;
                    continue;
                }
                // auto 模式：BigInt 不适用（含小数/除不尽等），回落到 Number 结果或原错误
            }

            // 3) Number 结果输出
            if (numErr) {
                lines.push('❌ ' + e + '  →  ' + numErr.message);
                failCount++;
                continue;
            }
            let out;
            if (typeof numVal === 'number') {
                out = precision != null ? Number(numVal.toFixed(precision)) : numVal;
            } else if (typeof numVal === 'object' && numVal !== null) {
                out = JSON.stringify(numVal);
            } else {
                out = String(numVal);
            }
            lines.push('✅ ' + e + '  =  ' + out);
            okCount++;
        }

        const head = `计算完成（成功 ${okCount} / 失败 ${failCount}${bigCount ? '，其中 ' + bigCount + ' 项 BigInt 精确' : ''}）`;
        return head + '\n' + lines.join('\n');
    }
};
