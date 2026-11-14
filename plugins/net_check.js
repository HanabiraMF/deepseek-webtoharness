const { exec } = require('child_process');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    return '';
};

module.exports = {
    name: 'net_check',
    description: "查看端口占用或网络连接",
    params: [
        { k: "port", cn: "端口", req: false, d: "查指定端口，不传返回监听端口列表" }
    ],
    execute: async (args) => {
        const port = V(args, 'port').replace(/[^0-9]/g, '');
        return new Promise((resolve) => {
            const cmd = port ? `netstat -ano | findstr :${port}` : `netstat -ano | findstr LISTENING`;
            exec(cmd, { timeout: 10000, windowsHide: true }, (err, stdout) => {
                let out = String(stdout || '').trim();
                if (!out) return resolve(port ? `端口 ${port} 未发现监听/连接。` : '未发现监听中的端口。');
                if (!port) {
                    const lines = out.split(/\r?\n/);
                    if (lines.length > 30) out = lines.slice(0, 30).join('\n') + '\n... (共 ' + lines.length + ' 条，已截断)';
                }
                resolve(out);
            });
        });
    }
};
