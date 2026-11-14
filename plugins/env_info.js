const { resolveWsPath, getWorkspace } = require('./_workspace');
const os = require('os');
const { execSync } = require('child_process');
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

module.exports = {
    name: 'env_info',
    description: "获取系统软硬件、Node/Python 版本等环境信息",
    params: [],
    execute: async (args) => {
        let res = '=== 系统环境信息 ===\n';
        res += `平台: ${os.platform()} ${os.arch()}\n`;
        res += `主机名: ${os.hostname()}\n`;
        res += `CPU 核心: ${os.cpus().length}\n`;
        res += `内存: ${(os.totalmem()/1024/1024/1024).toFixed(1)}GB 总 / ${(os.freemem()/1024/1024/1024).toFixed(1)}GB 空闲\n`;
        res += `Node 版本: ${process.version}\n`;
        
        try {
            const py = execSync('python --version', { encoding: 'utf8', windowsHide: true });
            res += `Python 版本: ${py.trim()}\n`;
        } catch (e) {
            try {
                const py3 = execSync('python3 --version', { encoding: 'utf8', windowsHide: true });
                res += `Python 版本: ${py3.trim()}\n`;
            } catch (e2) {
                res += `Python 版本: 未安装或不在 PATH 中\n`;
            }
        }

        res += `当前工作目录: ${await getWorkspace()}\n`;
        res += '\n=== 关键环境变量 ===\n';
        const keys = ['PATH', 'PYTHON_HOME', 'NODE_ENV', 'NPM_CONFIG_PREFIX', 'JAVA_HOME'];
        for (const k of keys) {
            if (process.env[k]) {
                let val = process.env[k];
                if (k === 'PATH' && val.length > 300) {
                    val = val.split(path.delimiter).slice(0, 5).join(path.delimiter) + path.delimiter + '...(已截断)';
                }
                res += `${k}: ${val}\n`;
            }
        }
        return res;
    }
};
