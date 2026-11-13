const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.DS_AGENT_PORT || '39999', 10);
let _cache = { cwd: null, ts: 0 };
const TTL = 800;

function fetchWorkspace() {
    return new Promise((resolve) => {
        let req;
        try {
            req = http.get({ host: '127.0.0.1', port: PORT, path: '/workspace', timeout: 2000 }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const j = JSON.parse(data);
                        resolve(j && typeof j.cwd === 'string' ? j.cwd : null);
                    } catch (e) { resolve(null); }
                });
            });
        } catch (e) { return resolve(null); }
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    });
}

async function getWorkspace() {
    const now = Date.now();
    if (_cache.cwd && now - _cache.ts < TTL) return _cache.cwd;
    const cwd = await fetchWorkspace();
    if (cwd) { _cache = { cwd, ts: now }; return cwd; }
    return _cache.cwd || process.cwd();
}

async function resolveWsPath(p) {
    if (p == null || p === '') return await getWorkspace();
    if (path.isAbsolute(p)) return p;
    const ws = await getWorkspace();
    return path.resolve(ws, String(p));
}

module.exports = { getWorkspace, resolveWsPath };
