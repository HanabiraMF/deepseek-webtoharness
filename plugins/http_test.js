const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
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

function request(urlStr, opt) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(urlStr); } catch (e) { return resolve({ error: 'URL 无效: ' + e.message }); }
        const lib = u.protocol === 'https:' ? https : http;
        const headers = Object.assign({}, opt.headers || {});
        let body = opt.body;
        if (body != null && typeof body !== 'string') body = JSON.stringify(body);
        if (body != null && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
        }
        if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
        const t0 = Date.now();
        const req = lib.request({
            method: (opt.method || 'GET').toUpperCase(),
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            headers,
            timeout: opt.timeout || 15000
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: data,
                ms: Date.now() - t0
            }));
        });
        req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ error: '请求超时', ms: Date.now() - t0 }); });
        if (body != null) req.write(body);
        req.end();
    });
}

function tryJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

function getByPath(obj, p) {
    const parts = String(p || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const k of parts) { if (cur == null) return undefined; cur = cur[k]; }
    return cur;
}

module.exports = {
    name: 'http_test',
    description: "HTTP 接口测试与断言：状态码 / 内容 / JSON 字段 / 耗时",
    params: [
        { k: "url", cn: "请求地址", req: true, d: "可逗号分隔多个" },
        { k: "method", cn: "方法", req: false, d: "默认 GET" },
        { k: "headers", cn: "请求头", req: false, d: "JSON 字符串" },
        { k: "body", cn: "请求体", req: false, d: "JSON 或纯文本" },
        { k: "expectStatus", cn: "期望状态码", req: false, d: "默认 200，可用 200,201 表示任一" },
        { k: "expectContains", cn: "需包含文本", req: false, d: "多个用 ||| 分隔，全部需包含" },
        { k: "expectNotContains", cn: "不得包含", req: false, d: "" },
        { k: "expectJson", cn: "JSON 断言", req: false, d: "数组，如 [{\"field\":\"data.id\",\"equals\":1}]" },
        { k: "maxMs", cn: "耗时上限", req: false, d: "毫秒" },
        { k: "showBody", cn: "显示响应体", req: false, d: "true 时输出，默认截断 800 字" }
    ],
    execute: async (args) => {
        const urls = (V(args, 'url') || V(args, 'urls')).split(',').map(s => s.trim()).filter(Boolean);
        if (!urls.length) return '错误：缺少 url';
        const method = (V(args, 'method') || 'GET').toUpperCase();
        const headersRaw = V(args, 'headers');
        let headers = {};
        if (headersRaw) {
            try { headers = JSON.parse(headersRaw); } catch (e) { return '错误：headers 不是合法 JSON - ' + e.message; }
        }
        const body = V(args, 'body') || null;
        const expectStatusRaw = V(args, 'expectStatus');
        const expectStatus = expectStatusRaw
            ? expectStatusRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
            : [200];
        const expectContains = V(args, 'expectContains');
        const expectNotContains = V(args, 'expectNotContains');
        const expectJsonRaw = V(args, 'expectJson');
        let expectJson = null;
        if (expectJsonRaw) {
            try { expectJson = JSON.parse(expectJsonRaw); expectJson = Array.isArray(expectJson) ? expectJson : [expectJson]; }
            catch (e) { return '错误：expectJson 不是合法 JSON - ' + e.message; }
        }
        const maxMs = V(args, 'maxMs') ? parseInt(V(args, 'maxMs'), 10) : null;
        const showBody = /^(true|1|yes)$/i.test(V(args, 'showBody'));

        const results = [];
        let allPass = true;

        for (const url of urls) {
            const r = await request(url, { method, headers, body, timeout: 15000 });
            const checks = [];
            const add = (ok, msg) => { checks.push((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) allPass = false; };

            if (r.error) {
                add(false, '请求失败: ' + r.error);
                results.push('◆ ' + method + ' ' + url + '\n' + checks.join('\n'));
                continue;
            }

            add(expectStatus.includes(r.status), '状态码 ' + r.status + '（期望 ' + expectStatus.join('/') + '）');
            if (maxMs != null) add(r.ms <= maxMs, '耗时 ' + r.ms + 'ms（上限 ' + maxMs + 'ms）');

            if (expectContains) {
                for (const piece of expectContains.split('|||')) {
                    if (!piece) continue;
                    add(r.body.includes(piece), '响应包含 ' + JSON.stringify(piece.slice(0, 60)));
                }
            }
            if (expectNotContains) add(!r.body.includes(expectNotContains), '响应不包含 ' + JSON.stringify(expectNotContains.slice(0, 60)));

            if (expectJson && expectJson.length) {
                const data = tryJson(r.body);
                if (data === undefined) {
                    add(false, '响应不是合法 JSON，无法做字段断言');
                } else {
                    for (const c of expectJson) {
                        const actual = getByPath(data, c.field);
                        const expect = c.equals;
                        const ok = (typeof actual === 'object' && actual !== null) || (typeof expect === 'object' && expect !== null)
                            ? JSON.stringify(actual) === JSON.stringify(expect)
                            : String(actual) === String(expect);
                        add(ok, '字段 ' + c.field + ' = ' + JSON.stringify(actual) + (ok ? '' : '（期望 ' + JSON.stringify(expect) + '）'));
                    }
                }
            }

            let block = '◆ ' + method + ' ' + url + '  (' + r.status + ', ' + r.ms + 'ms)\n' + checks.join('\n');
            if (showBody) block += '\n  响应体: ' + r.body.slice(0, 800) + (r.body.length > 800 ? '...' : '');
            results.push(block);
        }

        const head = allPass ? '接口测试全部通过 ✅' : '接口测试存在失败 ❌';
        return head + '\n' + results.join('\n\n');
    }
};
