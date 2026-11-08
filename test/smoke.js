// 冒烟测试：不依赖外部框架，node test/smoke.js 直接运行
// 覆盖：鉴权分离、工作区切换、/fs 全操作、/exec 回落
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 40200 + Math.floor(Math.random() * 100);
const TOKEN = 'smoke-' + Date.now();

const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DS_AGENT_PORT: String(PORT), DS_AGENT_TOKEN: TOKEN }),
    windowsHide: true
});
let serverLog = '';
child.stdout.on('data', d => serverLog += d);
child.stderr.on('data', d => serverLog += d);

function call(p, method, body, withToken, origin) {
    return new Promise(resolve => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (origin) headers['Origin'] = origin;
        if (withToken) headers['X-Agent-Token'] = TOKEN;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', headers }, res => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => { let j; try { j = JSON.parse(out); } catch { j = { raw: out }; } resolve({ status: res.statusCode, body: j }); });
        });
        req.on('error', e => resolve({ status: -1, body: { error: e.message } }));
        req.setTimeout(20000, () => { req.destroy(); resolve({ status: -2, body: { error: 'TIMEOUT' } }); });
        if (data) req.write(data);
        req.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function chk(name, cond, extra) {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + ' -> ' + JSON.stringify(extra).slice(0, 200)); }
}

(async () => {
    await sleep(1500);
    const ORIGIN = 'https://chat.deepseek.com';
    const tmpWs = path.join(ROOT, '_smoke_ws');

    // A. 鉴权
    let r = await call('/workspace', 'GET', null, false, ORIGIN);
    chk('无 Token /workspace = 200', r.status === 200, r);
    r = await call('/fs', 'POST', { op: 'listdir', path: '.' }, false, ORIGIN);
    chk('无 Token /fs = 403', r.status === 403, r);
    r = await call('/exec', 'POST', { command: 'echo x' }, false, ORIGIN);
    chk('无 Token /exec = 403', r.status === 403, r);
    r = await call('/workspace/pick', 'POST', {}, false, null);
    chk('无 Origin /workspace/pick = 403', r.status === 403, r);

    // B. 工作区切换
    fs.mkdirSync(tmpWs, { recursive: true });
    fs.writeFileSync(path.join(tmpWs, 'marker.txt'), 'hello smoke', 'utf8');
    r = await call('/workspace/set', 'POST', { path: tmpWs }, true, ORIGIN);
    chk('切换工作区', r.body.ok, r);
    r = await call('/fs', 'POST', { op: 'listdir', path: '.' }, true, ORIGIN);
    chk('/fs 跟随工作区', String(r.body.result).includes('marker.txt'), r);
    r = await call('/fs', 'POST', { op: 'openfile', path: path.join(ROOT, 'server.js') }, true, ORIGIN);
    chk('拒绝越界', !r.body.ok, r);

    // C. /fs 全操作
    r = await call('/fs', 'POST', { op: 'writefile', path: 't.txt', content: 'a\nb' }, true, ORIGIN);
    chk('writefile', r.body.ok, r);
    r = await call('/fs', 'POST', { op: 'append', path: 't.txt', content: '\nc' }, true, ORIGIN);
    chk('append', r.body.ok, r);
    r = await call('/fs', 'POST', { op: 'edit', path: 't.txt', old: 'a', new: 'A' }, true, ORIGIN);
    chk('edit', r.body.ok, r);
    r = await call('/fs', 'POST', { op: 'grep', pattern: 'A', path: '.' }, true, ORIGIN);
    chk('grep', String(r.body.result).includes('t.txt'), r);
    chk('grep 不含 .bak', !String(r.body.result).includes('.bak'), r);
    r = await call('/fs', 'POST', { op: 'glob', pattern: '*.txt' }, true, ORIGIN);
    chk('glob 不含 .bak', !String(r.body.result).includes('.bak'), r);
    r = await call('/fs', 'POST', { op: 'copy', from: 't.txt', to: 'u.txt' }, true, ORIGIN);
    chk('copy', r.body.ok, r);
    r = await call('/fs', 'POST', { op: 'hash', path: 't.txt' }, true, ORIGIN);
    chk('hash', String(r.body.result).includes('SHA-256'), r);
    r = await call('/fs', 'POST', { op: 'del', path: 'u.txt' }, true, ORIGIN);
    chk('del', r.body.ok, r);

    // D. /exec
    r = await call('/exec', 'POST', { command: 'type marker.txt' }, true, ORIGIN);
    chk('/exec 在新工作区', String(r.body.output).includes('hello smoke'), r);
    r = await call('/exec', 'POST', { command: 'echo fallback', cwd: 'C:\\no\\such\\dir' }, true, ORIGIN);
    chk('/exec 无效 cwd 回落', r.status === 200 && String(r.body.output).includes('fallback'), r);

    // 清理
    await call('/workspace/set', 'POST', { path: ROOT }, true, ORIGIN);
    try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}

    console.log('\n=== ' + pass + ' 通过, ' + fail + ' 失败 ===');
    child.kill();
    setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
