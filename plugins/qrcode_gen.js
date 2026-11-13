const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
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
    name: 'qrcode_gen',
    description: `
生成二维码图片。基于 Python qrcode 库，会自动安装依赖。
【参数】
- text: 二维码内容（网址、文字等）
- dest: (可选) 保存的文件路径，默认 qrcode.png
【示例】
{"op":"qrcode_gen","text":"https://chat.deepseek.com","dest":"qr.png"}
`,
    execute: async (args) => {
        const text = V(args, 'text');
        const dest = V(args, 'dest') || ('qrcode_' + Date.now() + '.png');
        if (!text) return '错误：缺少 text';
        const dstAbs = path.resolve(process.cwd(), dest);
        const dir = path.dirname(dstAbs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const pyCode = `
import sys
try:
    import qrcode
except ImportError:
    print("NEED_INSTALL")
    sys.exit(0)

try:
    img = qrcode.make(r"""${text.replace(/"""/g, '')}""")
    img.save(r'${dstAbs.replace(/\\/g, '\\\\')}')
    print("OK")
except Exception as e:
    print("ERROR:", str(e))
`;
        const tmpFile = path.join(os.tmpdir(), 'ds_qr_' + Date.now() + '.py');
        fs.writeFileSync(tmpFile, pyCode, 'utf8');

        const runPy = (cmd) => new Promise((resolve) => {
            exec(`${cmd} "${tmpFile}"`, {
                timeout: 30000, windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            }, (err, stdout) => {
                if (err && (err.code === 'ENOENT' || /not recognized/i.test(String(err.message)))) {
                    if (cmd === 'python') return resolve({ retry: 'python3' });
                    return resolve({ err: '未找到 Python 环境' });
                }
                resolve({ out: String(stdout || '').trim() });
            });
        });

        let pyCmd = 'python';
        let r = await runPy(pyCmd);
        if (r.retry) { pyCmd = r.retry; r = await runPy(pyCmd); }
        if (r.err) { try { fs.unlinkSync(tmpFile); } catch {} return r.err; }

        if (r.out === 'NEED_INSTALL') {
            return new Promise((resolve) => {
                exec(`${pyCmd} -m pip install qrcode[pil]`, { timeout: 90000, windowsHide: true }, (err2) => {
                    if (err2) {
                        try { fs.unlinkSync(tmpFile); } catch {}
                        return resolve('自动安装 qrcode 失败，请手动: pip install qrcode[pil]\n' + err2.message);
                    }
                    runPy(pyCmd).then(r2 => {
                        try { fs.unlinkSync(tmpFile); } catch {}
                        if (r2.out === 'OK' || fs.existsSync(dstAbs)) {
                            const kb = (fs.statSync(dstAbs).size / 1024).toFixed(1);
                            resolve(`二维码已生成: ${dest} (${kb}KB)。可用 image 工具查看。`);
                        } else {
                            resolve('生成失败: ' + (r2.out || '未知原因'));
                        }
                    });
                });
            });
        }
        try { fs.unlinkSync(tmpFile); } catch {}
        if (r.out === 'OK' && fs.existsSync(dstAbs)) {
            const kb = (fs.statSync(dstAbs).size / 1024).toFixed(1);
            return `二维码已生成: ${dest} (${kb}KB)。可用 image 工具查看。`;
        }
        return '生成失败: ' + (r.out || '未知');
    }
};
