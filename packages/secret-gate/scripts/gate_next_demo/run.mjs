#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { runMaskDemo } from './mask_demo.mjs';
import { runTransferDemo } from './transfer_demo.mjs';
import { renderReport } from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const exists = async file => access(file).then(() => true, () => false);
const execute = promisify(execFile);

async function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    const modulePath = path.resolve(process.env.PLAYWRIGHT_MODULE);
    return { api: require(modulePath), version: require(path.join(modulePath, 'package.json')).version };
  }
  try { return { api: require('playwright'), version: require('playwright/package.json').version }; } catch {}
  // Reuse an already installed npm-cache package; this never installs anything.
  const cache = path.join(os.homedir(), '.npm', '_npx');
  const candidates = [];
  for (const entry of await readdir(cache).catch(() => [])) {
    const modulePath = path.join(cache, entry, 'node_modules', 'playwright');
    try { candidates.push({ modulePath, version: JSON.parse(await readFile(path.join(modulePath, 'package.json'), 'utf8')).version }); } catch {}
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!candidates.length) throw new Error('Playwright 未安装；请将 PLAYWRIGHT_MODULE 设为现有 playwright 包目录。');
  return { api: require(candidates[0].modulePath), version: candidates[0].version };
}

function createGate(python) {
  const child = spawn(python, [path.join(here, 'gate_demo.py'), '--server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0, failure = null;
  const fail = error => { failure = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const closed = new Promise(resolve => child.once('close', resolve));
  child.once('error', () => fail(new Error('无法启动 demo gate Python 进程')));
  child.once('close', () => fail(new Error('Demo gate 已关闭')));
  child.stderr.resume(); // Never copy trusted-driver outputs to logs.
  child.stdin.on('error', () => fail(new Error('Demo gate 管道已关闭')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const reply = JSON.parse(line);
      const item = pending.get(reply.id);
      if (item) { clearTimeout(item.timer); pending.delete(reply.id); item.resolve(reply); }
    } catch { fail(new Error('Demo gate 返回了无效 JSON')); }
  });
  return {
    call(action, args) {
      if (failure) return Promise.reject(failure);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Demo gate ${action} 超时`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...args, id, action }) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await closed; } finally { clearTimeout(timer); lines.close(); }
    },
  };
}

const REF_NAMES = {
  same_label_has_distinct_random_references: '同名字段使用不同随机引用',
  same_label_does_not_mix_values: '同名字段不会串值',
  wrong_scope_is_denied: '错误任务范围被拒绝', wrong_host_is_denied: '错误站点被拒绝', wrong_port_is_denied: '错误端口被拒绝', wrong_use_is_denied: '错误用途被拒绝',
  metadata_correction_preserves_reference_and_ciphertext: '修正显示标签保留引用及密文身份', metadata_correction_does_not_change_permission: '修正标签不会扩大权限', metadata_contains_no_value_or_ciphertext: '描述信息不泄露原值或密文',
  random_reference_is_shorter_than_ciphertext: '短引用小于完整密文', uses_real_authenticated_sealed_box: '使用真实 authenticated sealed-box 加密', different_ephemeral_key_cannot_restore: '另一把临时密钥无法恢复密文', tampered_ciphertext_is_rejected: '篡改密文被拒绝',
  released_scope_is_unusable: '释放后的任务范围不可用', released_scope_cannot_be_reopened: '已释放的任务范围不能重新打开', releasing_reference_does_not_revoke_original_ciphertext: '明确区分引用释放与密文撤销', trusted_restore_supports_continuation: '受控恢复允许在新范围续跑', restoration_retains_original_policy: '恢复保留原始权限限制', releasing_one_scope_does_not_affect_another: '释放一个范围不影响其他范围', error_output_does_not_echo_arguments: '错误响应不回显输入内容',
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('node scripts/gate_next_demo/run.mjs [--out <新的输出目录>]'); return; }
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('仅支持 --out <新的输出目录>');
  const outDir = path.resolve(args[1] ?? path.join(os.homedir(), 'Desktop/WorkSpace/Scratch', `agentswitch-gate-next-demo-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir); // Refuse to overwrite previous experiment artifacts.
  const python = process.env.DEMO_PYTHON || path.resolve(here, '../../.venv/bin/python');
  const { api, version } = await playwright();
  await execute(python, [path.join(here, 'gate_demo.py'), '--self-test', '--out', path.join(outDir, 'refs-summary.json')], { timeout: 30000, maxBuffer: 256000 });
  const refs = JSON.parse(await readFile(path.join(outDir, 'refs-summary.json'), 'utf8'));
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.DEMO_CHROMIUM || (await exists(chrome) ? chrome : undefined);
  const browser = await api.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const gate = createGate(python);
  try {
    const demos = [{ name: '任务作用域内的随机短引用', description: '显示名称和引用身份分开；策略继续封在真实密文里，短引用负责查找及任务隔离。', checks: refs.checks.map(check => ({ ...check, name: REF_NAMES[check.name] || check.name })), metrics: { '引用字符': refs.measurements.referenceCharacters, '样例密文字符': refs.measurements.ciphertextCharacters, '字符减少': `${Math.round((1 - refs.measurements.referenceCharacters / refs.measurements.ciphertextCharacters) * 100)}%` }, limitations: ['释放短引用不会让已经导出的原始密文失效；需要真正撤销时要另外设计撤销机制。', '本 demo 只演示同一临时密钥存活期间的恢复，不包含跨进程持久化。'] }];
    console.log(`短引用 ${refs.checks.filter(check => check.passed).length}/${refs.checks.length}`);
    const mask = await runMaskDemo({ browser, outDir });
    mask.name = '截图不透明遮罩与字段实时状态';
    mask.description = '真实浏览器截图遮挡指定元素；像素校验覆盖普通文字、显示密码、动态节点、Shadow DOM、iframe 和整个 canvas。';
    mask.limitations = ['本例使用已知选择器和指定区域内的模式匹配，未实现通用 PII 识别。', '覆盖开放 Shadow DOM、本地同源 iframe 和已稳定的动态内容；跨域或持续变化页面需要另外验证。', 'canvas 整块遮挡，没有 OCR；截图遮罩不代替 DOM 快照和其他工具的输出控制。'];
    demos.push(mask);
    console.log(`截图与状态 ${mask.checks.filter(check => check.passed).length}/${mask.checks.length}`);
    const transfer = await runTransferDemo({ browser, gate, outDir });
    demos.push(transfer);
    console.log(`页面数据搬运 ${transfer.checks.filter(check => check.passed).length}/${transfer.checks.length}`);
    const report = { title: '凭据层的三个小实验', generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' CST', environment: { node: process.version, playwright: version, browser: browser.version() }, demos, limitations: ['未修改运行中的 daemon、gate 配置或任何真实任务，也未调用模型。', '这些结果支持评估机制是否值得接入；正式 MCP、代理和生命周期集成仍需独立实现。'] };
    await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    const reportPath = path.join(outDir, 'report.html');
    await writeFile(reportPath, renderReport(report));
    // Check the delivered artifact in the same isolated browser, including its
    // relative images and interaction, and keep a compact visual preview.
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(pathToFileURL(reportPath).href);
    await page.locator('.artifacts').first().scrollIntoViewIfNeeded();
    await page.locator('.artifacts').last().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    const firstArtifact = page.locator('.artifacts').first();
    await firstArtifact.locator('[data-view="after"]').click();
    if (await firstArtifact.getAttribute('data-mode') !== 'after') throw new Error('报告图片切换校验失败');
    await firstArtifact.locator('[data-view="compare"]').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outDir, 'report-preview.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (pageErrors.length || overflow) throw new Error('报告浏览器校验失败');
    await page.close();
    const failed = demos.flatMap(demo => demo.checks).filter(check => !check.passed);
    console.log(JSON.stringify({ outDir, checks: demos.reduce((sum, demo) => sum + demo.checks.length, 0), failed: failed.length, reportBrowserCheck: 'passed' }, null, 2));
    if (failed.length) process.exitCode = 1;
  } finally {
    await Promise.all([gate.close(), browser.close()]);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
