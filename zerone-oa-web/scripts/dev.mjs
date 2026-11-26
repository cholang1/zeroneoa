import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = resolve(root, 'apps/web');
const requireWeb = createRequire(resolve(web, 'package.json'));
const vite = resolve(dirname(requireWeb.resolve('vite/package.json')), 'bin/vite.js');
// 直接管理两个 node 子进程，Windows 上无需通过 npm.cmd 再启动孙进程。
const children = [];
let closing = false;

function stop(code) {
    if (closing) return;
    closing = true;
    process.exitCode = code;
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
}

for (const [name, entry, cwd] of [
    ['API', 'src/main.mjs', resolve(root, 'apps/api')],
    ['Web', vite, web]
]) {
    const child = spawn(process.execPath, [entry], {cwd, stdio: 'inherit'});
    children.push(child);
    child.once('error', (error) => {
        console.error(`${name} 启动失败：${error.message}`);
        stop(1);
    });
    child.once('exit', (code) => {
        if (!closing) {
            console.error(`${name} 已退出，正在关闭工作区。`);
            stop(code ?? 1);
        }
    });
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
