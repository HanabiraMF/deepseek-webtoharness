const { resolveWsPath, getWorkspace } = require('./_workspace');
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
    name: 'pdf_tool',
    description: `
提取 PDF 文件的纯文本内容。如果缺少依赖库会自动尝试安装。
【参数】
- path: PDF 文件的相对路径。
【示例】
{"op":"pdf_tool","path":"document.pdf"}
`,
    execute: async (args) => {
        const p = V(args, 'path');
        if (!p) return '错误：缺少 path';
        const abs = await resolveWsPath(p);
        if (!fs.existsSync(abs)) return '错误：文件不存在 ' + p;

        const pyCode = `
import sys
try:
    from pypdf import PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        print("ERROR_MISSING_LIB")
        sys.exit(0)

try:
    reader = PdfReader(r'${abs.replace(/\\/g, '\\\\')}')
    text = []
    for page in reader.pages:
        t = page.extract_text()
        if t: text.append(t)
    print('\\n--- 分页 ---\\n'.join(text))
except Exception as e:
    print("ERROR_EXTRACT:", str(e))
`;
        const tmpFile = path.join(os.tmpdir(), 'ds_pdf_' + Date.now() + '.py');
        fs.writeFileSync(tmpFile, pyCode, 'utf8');

        const runPy = (cmd) => new Promise((resolve) => {
            exec(`${cmd} "${tmpFile}"`, { 
                timeout: 30000, 
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            }, (err, stdout, stderr) => {
                if (err && (err.code === 'ENOENT' || /not recognized/i.test(String(err.message)))) {
                    if (cmd === 'python') return resolve({ ok: false, retry: 'python3' });
                    return resolve({ ok: false, msg: '错误：未找到 Python 环境' });
                }
                let out = String(stdout || '').trim();
                resolve({ ok: true, out });
            });
        });

        let pyCmd = 'python';
        let res = await runPy(pyCmd);
        if (res.retry) {
            pyCmd = res.retry;
            res = await runPy(pyCmd);
        }
        if (!res.ok) {
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            return res.msg;
        }

        if (res.out === 'ERROR_MISSING_LIB') {
            // 自动安装依赖
            return new Promise((resolve) => {
                exec(`${pyCmd} -m pip install pypdf`, { timeout: 60000, windowsHide: true }, (err2, stdout2, stderr2) => {
                    if (err2) {
                        try { fs.unlinkSync(tmpFile); } catch (e) {}
                        return resolve('提取失败，且自动安装 pypdf 失败: ' + (stderr2 || err2.message) + '\n请尝试手动执行: pip install pypdf');
                    }
                    // 安装成功后，重新执行提取
                    runPy(pyCmd).then(res2 => {
                        try { fs.unlinkSync(tmpFile); } catch (e) {}
                        if (!res2.ok) return resolve(res2.msg);
                        if (res2.out.startsWith('ERROR_EXTRACT:')) return resolve('提取出错: ' + res2.out.slice(14));
                        resolve(res2.out || '(未提取到文本内容)');
                    });
                });
            });
        }

        try { fs.unlinkSync(tmpFile); } catch (e) {}
        if (res.out.startsWith('ERROR_EXTRACT:')) return '提取出错: ' + res.out.slice(14);
        return res.out || '(未提取到文本内容)';
    }
};
