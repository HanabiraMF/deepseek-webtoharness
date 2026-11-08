const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, 'plugins');
let serverPlugins = {}; // { name: { description, execute } }

// 确保插件目录存在
if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

function loadServerPlugins() {
    serverPlugins = {};
    try {
        const files = fs.readdirSync(PLUGINS_DIR);
        for (const file of files) {
            if (file.endsWith('.js')) {
                try {
                    delete require.cache[require.resolve(path.join(PLUGINS_DIR, file))];
                    const plugin = require(path.join(PLUGINS_DIR, file));
                    if (plugin && plugin.name && typeof plugin.execute === 'function') {
                        serverPlugins[plugin.name] = plugin;
                    }
                } catch (e) {
                    console.error(`加载插件 ${file} 失败:`, e.message);
                }
            }
        }
        console.log(`已加载 ${Object.keys(serverPlugins).length} 个本地服务端插件。`);
    } catch (e) {
        console.error('读取插件目录失败:', e.message);
    }
}
loadServerPlugins();

const PORT = parseInt(process.env.DS_AGENT_PORT || '39999', 10);
const MAX_BODY = 1024 * 1024;
const MAX_BUFFER = 10 * 1024 * 1024;
const EXEC_TIMEOUT = 30000;
const FETCH_TIMEOUT = 30000;
const MAX_FETCH_RESP = 10 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set(['https://chat.deepseek.com']);
const TOKEN = process.env.DS_AGENT_TOKEN || crypto.randomBytes(24).toString('hex');
const REQUIRE_TOKEN = process.env.DS_AGENT_ALLOW_NO_TOKEN !== '1';

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '', size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) { req.destroy(); return reject(new Error('请求体过大')); }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
function decodeBuffer(buf) {
    if (!buf || buf.length === 0) return '';
    try {
        const s = buf.toString('utf8');
        if (!s.includes('\ufffd')) return s;
    } catch {}
    try { return new TextDecoder('gbk').decode(buf); } catch {}
    return buf.toString('utf8');
}
const checkOrigin = (req) => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);
const checkToken = (req) => !REQUIRE_TOKEN || req.headers['x-agent-token'] === TOKEN;

const server = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin;
    if (reqOrigin && ALLOWED_ORIGINS.has(reqOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', reqOrigin);
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        if (!checkOrigin(req)) { res.writeHead(403); res.end(); return; }
        res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Token',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }
    if (!checkOrigin(req) || !checkToken(req)) return sendJson(res, 403, { error: 'Forbidden' });

    let pathname;
    try { pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname; }
    catch { return sendJson(res, 400, { error: 'Bad URL' }); }

    if ((req.method === 'POST' || req.method === 'GET') && pathname === '/workspace') {
        return sendJson(res, 200, { cwd: process.cwd() });
    }

    if ((req.method === 'POST' || req.method === 'GET') && pathname === '/plugins/list') {
        const list = Object.values(serverPlugins).map(p => ({ name: p.name, description: p.description }));
        return sendJson(res, 200, { plugins: list });
    }

    if (req.method === 'POST' && pathname === '/plugins/reload') {
        loadServerPlugins();
        const list = Object.values(serverPlugins).map(p => ({ name: p.name, description: p.description }));
        return sendJson(res, 200, { success: true, plugins: list });
    }

    if (req.method === 'POST' && pathname === '/plugins/exec') {
        try {
            const { name, args } = JSON.parse(await readBody(req) || '{}');
            if (!name || !serverPlugins[name]) {
                return sendJson(res, 404, { error: `服务端插件不存在: ${name}` });
            }
            Promise.resolve(serverPlugins[name].execute(args))
                .then(result => sendJson(res, 200, { result: String(result) }))
                .catch(err => sendJson(res, 200, { error: err.message || String(err) }));
        } catch (e) {
            sendJson(res, 400, { error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/exec') {
        try {
            const { command, cwd, timeout = 30000 } = JSON.parse(await readBody(req) || '{}');
            if (typeof command !== 'string' || !command.trim())
                return sendJson(res, 400, { error: '缺少 command' });

            let workDir = process.cwd();
            if (typeof cwd === 'string' && cwd.trim()) {
                const c = cwd.trim();
                let st;
                try { st = fs.statSync(c); }
                catch { return sendJson(res, 400, { error: `cwd 不存在: ${c}`, hint: '请在插件面板重新填写工作区绝对路径' }); }
                if (!st.isDirectory()) return sendJson(res, 400, { error: `cwd 不是目录: ${c}`, hint: 'absPath 应指向工作区根目录' });
                workDir = c;
            }

            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const args = isWin ? ['/c', `chcp 65001 >nul && ${command}`] : ['-c', command];
            
            const child = require('child_process').spawn(shell, args, { cwd: workDir, windowsHide: true });
            
            let output = '';
            let killedByTimeout = false;
            let responded = false;

            const sendResponse = (exitCode, msg = '') => {
                if (responded) return;
                responded = true;
                sendJson(res, 200, { output: output + msg, exitCode, pid: child.pid });
            };

            child.stdout.on('data', d => output += d.toString('utf8'));
            child.stderr.on('data', d => output += d.toString('utf8'));
            
            child.on('close', code => {
                if (!killedByTimeout) sendResponse(code === null ? 1 : code);
            });
            
            child.on('error', err => {
                sendResponse(1, `\n[启动失败] ${err.message}`);
            });

            setTimeout(() => {
                if (!responded) {
                    killedByTimeout = true;
                    sendResponse(0, `\n[进程运行超过 ${timeout/1000} 秒，已转入后台运行。PID: ${child.pid}。如果觉得卡死，可使用 kill_process 终止]`);
                }
            }, parseInt(timeout, 10));
            
        } catch (e) { sendJson(res, 400, { error: e.message }); }
        return;
    }

    if (req.method === 'POST' && pathname === '/exec/kill') {
        try {
            const { pid } = JSON.parse(await readBody(req) || '{}');
            if (!pid) return sendJson(res, 400, { error: '缺少 pid' });
            
            if (process.platform === 'win32') {
                require('child_process').exec(`taskkill /F /PID ${pid} /T`, (err, stdout, stderr) => {
                    sendJson(res, 200, { output: `进程 ${pid} 已被强制终止。\n${stdout}\n${stderr}`, exitCode: 0 });
                });
            } else {
                require('child_process').exec(`kill -9 ${pid}`, (err, stdout, stderr) => {
                    sendJson(res, 200, { output: `进程 ${pid} 已被强制终止。\n${stdout}\n${stderr}`, exitCode: 0 });
                });
            }
        } catch (e) { sendJson(res, 400, { error: e.message }); }
        return;
    }

    if (req.method === 'POST' && pathname === '/fetch') {
        try {
            const { url, method = 'GET', content, headers = {} } = JSON.parse(await readBody(req) || '{}');
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
                return sendJson(res, 400, { error: 'url 必须是 http:// 或 https:// 地址' });
            const m = String(method).toUpperCase();
            if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m))
                return sendJson(res, 400, { error: `不支持的 method: ${m}` });

            const result = await new Promise((resolve, reject) => {
                const lib = url.startsWith('https') ? require('https') : require('http');
                let u;
                try { u = new URL(url); } catch { return reject(new Error('URL 解析失败')); }
                const options = { method: m, headers: {} };

                if (headers && typeof headers === 'object') {
                    for (const [k, v] of Object.entries(headers)) options.headers[k] = String(v);
                }

                let bodyBuf = null;
                if (content !== undefined && content !== null && m !== 'GET' && m !== 'HEAD') {
                    bodyBuf = Buffer.from(String(content), 'utf8');
                    if (!options.headers['Content-Type']) {
                        options.headers['Content-Type'] = 'text/plain; charset=utf-8';
                    }
                    options.headers['Content-Length'] = bodyBuf.length;
                }
                const r = lib.request(u, options, (resp) => {
                    const chunks = [];
                    let size = 0;
                    resp.on('data', c => {
                        size += c.length;
                        if (size > MAX_FETCH_RESP) { resp.destroy(); reject(new Error('响应体超过 10MB 上限')); return; }
                        chunks.push(c);
                    });
                    resp.on('end', () => resolve({
                        status: resp.statusCode,
                        statusText: resp.statusMessage || '',
                        text: Buffer.concat(chunks).toString('utf8'),
                    }));
                    resp.on('error', reject);
                });
                r.setTimeout(FETCH_TIMEOUT, () => r.destroy(new Error(`请求超时（${FETCH_TIMEOUT/1000}s）`)));
                r.on('error', reject);
                if (bodyBuf) r.write(bodyBuf);
                r.end();
            });
            sendJson(res, 200, result);
        } catch (e) {
            sendJson(res, 502, { error: e.message, hint: '检查目标地址是否可达、是否 http(s)、DNS 是否正常' });
        }
        return;
    }

    sendJson(res, 404, { error: 'Not Found' });
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 被占用，设置 DS_AGENT_PORT 换端口`);
    else console.error(e);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`CMD 服务已启动: http://127.0.0.1:${PORT}`);
    if (REQUIRE_TOKEN) {
        console.log('==============================================');
        console.log(' 访问 Token（粘贴到插件面板，仅需一次）:');
        console.log(' ' + TOKEN);
        console.log(' 禁用校验：set DS_AGENT_ALLOW_NO_TOKEN=1');
        console.log('==============================================');
    }
});