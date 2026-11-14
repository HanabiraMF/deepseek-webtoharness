const { resolveWsPath } = require('./_workspace');
const fs = require('fs');
const path = require('path');

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

function getPath(obj, p) {
    const parts = String(p == null ? '' : p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const k of parts) {
        if (cur == null) return undefined;
        cur = cur[k];
    }
    return cur;
}

function sameVal(a, b) {
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return String(a) === String(b);
}

async function runCheck(c) {
    const type = String(c.type || '').toLowerCase();
    const abs = c.path ? await resolveWsPath(c.path) : null;
    const need = (cond, passMsg, failMsg) => (cond ? { pass: true, msg: passMsg } : { pass: false, msg: failMsg });

    if (type === 'file_exists') {
        return need(abs && fs.existsSync(abs), '文件存在: ' + c.path, '文件不存在: ' + c.path);
    }
    if (type === 'file_not_exists') {
        return need(!(abs && fs.existsSync(abs)), '文件确实不存在: ' + c.path, '文件不应存在但存在了: ' + c.path);
    }
    if (type === 'file_size') {
        if (!abs || !fs.existsSync(abs)) return { pass: false, msg: '文件不存在: ' + c.path };
        const size = fs.statSync(abs).size;
        const min = c.min == null ? null : Number(c.min);
        const max = c.max == null ? null : Number(c.max);
        const okMin = min == null || size >= min;
        const okMax = max == null || size <= max;
        return need(okMin && okMax, `文件大小 ${size} 在范围内`, `文件大小 ${size} 超出 [${min == null ? '-' : min}, ${max == null ? '-' : max}]`);
    }
    if (type === 'file_contains') {
        if (!abs || !fs.existsSync(abs)) return { pass: false, msg: '文件不存在: ' + c.path };
        let txt = fs.readFileSync(abs, 'utf8');
        let needle = String(c.text == null ? '' : c.text);
        if (c.ignoreCase) { txt = txt.toLowerCase(); needle = needle.toLowerCase(); }
        return need(txt.includes(needle), '文件包含指定文本', '文件不包含指定文本: ' + JSON.stringify(c.text));
    }
    if (type === 'file_regex') {
        if (!abs || !fs.existsSync(abs)) return { pass: false, msg: '文件不存在: ' + c.path };
        const txt = fs.readFileSync(abs, 'utf8');
        let re;
        try { re = new RegExp(String(c.pattern || ''), String(c.flags || '')); } catch (e) { return { pass: false, msg: '正则无效: ' + e.message }; }
        return need(re.test(txt), '文件匹配正则 /' + c.pattern + '/' + (c.flags || ''), '文件不匹配正则 /' + c.pattern + '/' + (c.flags || ''));
    }
    if (type === 'json_valid') {
        if (!abs || !fs.existsSync(abs)) return { pass: false, msg: '文件不存在: ' + c.path };
        try { JSON.parse(fs.readFileSync(abs, 'utf8')); return { pass: true, msg: 'JSON 合法' }; }
        catch (e) { return { pass: false, msg: 'JSON 非法: ' + e.message }; }
    }
    if (type === 'json_field') {
        let data;
        if (abs) {
            if (!fs.existsSync(abs)) return { pass: false, msg: '文件不存在: ' + c.path };
            try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { return { pass: false, msg: 'JSON 解析失败: ' + e.message }; }
        } else if (c.text != null) {
            try { data = JSON.parse(String(c.text)); } catch (e) { return { pass: false, msg: 'JSON 解析失败: ' + e.message }; }
        } else {
            return { pass: false, msg: 'json_field 需要 path 或 text' };
        }
        const actual = getPath(data, c.field);
        // 期望值字段兼容 equals / value / expected 三种写法
        let expect = (c.equals !== undefined) ? c.equals
                   : (c.value !== undefined) ? c.value
                   : c.expected;
        if (typeof expect === 'string') {
            try { expect = JSON.parse(expect); } catch (e) { /* 保持字符串 */ }
        }
        return need(sameVal(actual, expect),
            '字段 ' + c.field + ' = ' + JSON.stringify(actual),
            '字段 ' + c.field + ' 实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect));
    }
    if (type === 'text_contains') {
        const txt = String(c.text == null ? '' : c.text);
        const needle = String(c.value == null ? (c.contains == null ? '' : c.contains) : c.value);
        const ci = c.ignoreCase ? (txt.toLowerCase().includes(needle.toLowerCase())) : txt.includes(needle);
        return need(ci, '文本包含 ' + JSON.stringify(needle), '文本不包含 ' + JSON.stringify(needle));
    }
    if (type === 'text_regex') {
        let re;
        try { re = new RegExp(String(c.pattern || ''), String(c.flags || '')); } catch (e) { return { pass: false, msg: '正则无效: ' + e.message }; }
        return need(re.test(String(c.text == null ? '' : c.text)), '文本匹配正则', '文本不匹配正则 /' + c.pattern + '/');
    }
    if (type === 'exit_code') {
        const actual = Number(c.value);
        const expect = Number(c.equals == null ? 0 : c.equals);
        return need(actual === expect, '退出码 ' + actual, '退出码 ' + actual + '，期望 ' + expect);
    }
    if (type === 'number') {
        const n = Number(c.value);
        const min = c.min == null ? null : Number(c.min);
        const max = c.max == null ? null : Number(c.max);
        const ok = !isNaN(n) && (min == null || n >= min) && (max == null || n <= max);
        return need(ok, `数值 ${n} 在范围内`, `数值 ${n} 不在 [${min == null ? '-' : min}, ${max == null ? '-' : max}] 内`);
    }
    return { pass: false, msg: '未知检查类型: ' + type };
}

module.exports = {
    name: 'assert_tool',
    description: "断言校验：验证文件存在/包含/正则/JSON 字段等，返回 PASS/FAIL 明细",
    params: [
        { k: "checks", cn: "断言规则", req: true, d: "JSON 数组，每项 {type,...}。类型：file_exists / file_not_exists / file_size / file_contains / file_regex / json_valid / json_field / text_contains / text_regex / exit_code / number" }
    ],
    execute: async (args) => {
        let raw = V(args, 'checks') || V(args, 'check');
        if (!raw) return '错误：缺少 checks（JSON 数组或对象）';
        let checks;
        try {
            const parsed = JSON.parse(raw);
            checks = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            return '错误：checks 不是合法 JSON - ' + e.message;
        }
        if (!checks.length) return '错误：checks 为空';

        const lines = [];
        let pass = 0, fail = 0;
        for (let i = 0; i < checks.length; i++) {
            const c = checks[i] || {};
            let r;
            try { r = await runCheck(c); }
            catch (e) { r = { pass: false, msg: '执行异常: ' + e.message }; }
            if (r.pass) { pass++; lines.push(`✅ [${i + 1}] ${c.type}: ${r.msg}`); }
            else { fail++; lines.push(`❌ [${i + 1}] ${c.type}: ${r.msg}`); }
        }
        const head = (fail === 0 ? '全部通过 ✅' : '存在失败项 ❌') + `（通过 ${pass} / 失败 ${fail}）`;
        return head + '\n' + lines.join('\n');
    }
};
