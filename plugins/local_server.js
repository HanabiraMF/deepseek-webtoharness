const { resolveWsPath, getWorkspace } = require('./_workspace');
const http = require('http');
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

// 把运行中的 server 挂到 global：插件热重载后模块内变量会丢失，
// 挂 global 才能保证新模块仍能找到并关闭旧实例（避免端口被孤儿进程占死）。
const G = globalThis;
G.__DS_LOCAL_SERVER = G.__DS_LOCAL_SERVER || { server: null, port: 8080 };

function getCurrent() { return G.__DS_LOCAL_SERVER.server; }
function setCurrent(s, p) {
    G.__DS_LOCAL_SERVER.server = s || null;
    if (p != null) G.__DS_LOCAL_SERVER.port = p;
}

// 兜底：关闭所有监听指定端口（或全部）的 net.Server 句柄。
// 用于清理「插件热重载前创建、模块引用已丢失」的孤儿监听。
function closeOrphanServers(port) {
    let closed = 0;
    try {
        const handles = process._getActiveHandles ? process._getActiveHandles() : [];
        for (const h of handles) {
            if (!h || typeof h.close !== 'function' || typeof h.address !== 'function') continue;
            let addr = null;
            try { addr = h.address(); } catch (e) { continue; }
            if (!addr || typeof addr !== 'object' || addr.port == null) continue;
            if (port != null && addr.port !== port) continue;
            try { h.close(); closed++; } catch (e) {}
        }
    } catch (e) {}
    return closed;
}

module.exports = {
    name: 'local_server',
    description: "启动或停止极简 HTTP 静态文件服务器",
    params: [
        { k: "action", cn: "操作", req: true, d: "start / stop" },
        { k: "port", cn: "端口", req: false, d: "默认 8080" },
        { k: "dir", cn: "根目录", req: false, d: "默认当前工作区" }
    ],
    execute: async (args) => {
        const action = V(args, 'action');
        const port = parseInt(V(args, 'port') || '8080', 10);
        const dir = path.resolve(await getWorkspace(), V(args, 'dir') || '.');

        if (action === 'stop') {
            const cur = getCurrent();
            let msg = '';
            if (cur) {
                try { cur.close(); } catch (e) {}
                setCurrent(null);
                msg = '服务器已停止';
            }
            // 兜底清理热重载遗留的孤儿监听（指定端口就只清该端口）
            const orphan = closeOrphanServers(port);
            if (!msg) msg = orphan > 0 ? `已清理 ${orphan} 个遗留监听` : '当前没有运行中的服务器';
            else if (orphan > 0) msg += `（另清理 ${orphan} 个遗留监听）`;
            return msg;
        }

        if (action === 'start') {
            const cur = getCurrent();
            if (cur) return '服务器已在运行，端口 ' + G.__DS_LOCAL_SERVER.port;
            if (!fs.existsSync(dir)) return '错误：目录不存在 ' + dir;

            const server = http.createServer((req, res) => {
                let reqPath = decodeURIComponent(req.url.split('?')[0]);
                if (reqPath === '/') reqPath = '/index.html';
                const filePath = path.join(dir, reqPath);
                
                if (!filePath.startsWith(dir)) {
                    res.writeHead(403); res.end('Forbidden'); return;
                }
                
                fs.readFile(filePath, (err, data) => {
                    if (err) {
                        if (err.code === 'EISDIR' || (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory())) {
                            const idx = path.join(filePath, 'index.html');
                            fs.readFile(idx, (err2, data2) => {
                                if (err2) { res.writeHead(404); res.end('Not Found'); }
                                else { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(data2); }
                            });
                        } else {
                            res.writeHead(404); res.end('Not Found');
                        }
                        return;
                    }
                    const ext = path.extname(filePath).toLowerCase();
                    const mimes = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.json':'application/json' };
                    res.writeHead(200, {'Content-Type': mimes[ext] || 'application/octet-stream'});
                    res.end(data);
                });
            });

            return new Promise((resolve) => {
                server.listen(port, () => {
                    setCurrent(server, port);
                    resolve(`服务器已启动: http://127.0.0.1:${port} (根目录: ${path.basename(dir)})`);
                }).on('error', (err) => {
                    setCurrent(null);
                    resolve('启动失败: ' + err.message);
                });
            });
        }
        return '错误：action 必须是 start 或 stop';
    }
};
