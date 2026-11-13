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
    return '';
};

let currentServer = null;
let currentPort = 8080;

module.exports = {
    name: 'local_server',
    description: `
在工作区或指定目录启动/停止一个极简的 HTTP 静态文件服务器。
【参数】
- action: 'start' (启动) 或 'stop' (停止)
- port: (可选) 端口号，默认 8080
- dir: (可选) 根目录，默认当前工作区
【示例】
{"op":"local_server","action":"start","port":"8080"}
{"op":"local_server","action":"stop"}
`,
    execute: async (args) => {
        const action = V(args, 'action');
        const port = parseInt(V(args, 'port') || '8080', 10);
        const dir = path.resolve(process.cwd(), V(args, 'dir') || '.');

        if (action === 'stop') {
            if (currentServer) {
                currentServer.close();
                currentServer = null;
                return '服务器已停止';
            }
            return '当前没有运行中的服务器';
        }

        if (action === 'start') {
            if (currentServer) return '服务器已在运行，端口 ' + currentPort;
            if (!fs.existsSync(dir)) return '错误：目录不存在 ' + dir;

            currentServer = http.createServer((req, res) => {
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
                currentServer.listen(port, () => {
                    currentPort = port;
                    resolve(`服务器已启动: http://127.0.0.1:${port} (根目录: ${path.basename(dir)})`);
                }).on('error', (err) => {
                    currentServer = null;
                    resolve('启动失败: ' + err.message);
                });
            });
        }
        return '错误：action 必须是 start 或 stop';
    }
};
