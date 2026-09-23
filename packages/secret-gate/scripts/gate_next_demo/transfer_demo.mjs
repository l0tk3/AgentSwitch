import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

// Explicitly fictional data, kept in the trusted driver and local fixture only.
const VALUES = { email: 'alice.demo@example.test', phone: '202-555-0147' };
const LABELS = { email: '联系邮箱', phone: '联系电话' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (title, step, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#eff4f1;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#233d33}main{max-width:830px;margin:55px auto;background:white;border:1px solid #d8e4da;border-radius:20px;padding:38px}header{display:flex;justify-content:space-between;color:#44715a;font-size:13px}h1{font-size:31px;margin:30px 0 10px}p{color:#62756a}section,form{margin-top:32px;padding:25px;background:#f7faf7;border-radius:14px}label{display:block;color:#63766a;font-size:13px;margin-bottom:20px}input,.value{display:block;font:18px/1.5 ui-monospace,monospace;color:#253c30;background:white;border:1px solid #cfddd2;border-radius:8px;width:100%;padding:12px;margin-top:8px}button{padding:12px 22px;border:0;border-radius:8px;background:#26684f;color:white;font:inherit}.note{border-top:1px solid #e1e9e2;margin-top:30px;padding-top:20px;font-size:13px}.pill{border:1px solid #d2e3d5;background:#eaf4ec;border-radius:20px;padding:3px 11px}
</style><main><header><strong>AgentSwitch / 页面数据搬运</strong><span class="pill">全部为虚构数据</span></header><h1>${title}</h1><p>${step}</p>${body}<p class="note">独立浏览器 · 仅本机页面 · 无真实账号或模型调用</p></main></html>`;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function html(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
  res.end(body);
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}

export async function runTransferDemo({ browser, gate, outDir }) {
  const started = performance.now();
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  let source, destination, context;
  let receipt = null;
  let gateCalls = 0;
  const call = async (action, args) => { gateCalls++; return gate.call(action, args); };
  const must = async (action, args) => {
    const result = await call(action, args);
    if (!result.ok) throw new Error(`Demo gate ${action}: ${result.code}`);
    return result;
  };
  try {
    source = await listen((req, res) => {
      if (req.method !== 'GET' || req.url !== '/') return html(res, 'Not found', 404);
      html(res, shell('来源：本地客户记录', '01 / 驱动读取指定字段；原页面保留原值。', `<section>${Object.entries(VALUES).map(([key, value]) => `<label>${LABELS[key]}<span class="value" data-field="${key}">${escape(value)}</span></label>`).join('')}</section>`));
    });
    destination = await listen((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        return html(res, shell('目标：本地登记表单', '02 / 模拟执行者只提供短引用；驱动校验目的地后填入。', `<form method="post" action="/submit">${Object.keys(VALUES).map(key => `<label>${LABELS[key]}<input name="${key}" type="${key === 'email' ? 'email' : 'tel'}" autocomplete="off" required></label>`).join('')}<button type="submit">提交虚构记录</button></form>`));
      }
      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          const fields = new URLSearchParams(body);
          receipt = {
            matchesExpected: Object.entries(VALUES).every(([key, value]) => fields.get(key) === value),
            fieldCount: [...fields.keys()].length,
            receivedReference: [...fields.values()].some(value => value.includes('enc:ref:') || value.includes('enc:v1:')),
          };
          html(res, shell('接收完成', '03 / 目标服务已收到本次虚构记录。', '<section><strong id="accepted">本地表单提交成功</strong><p>报告只记录比对结果，不回显收到的字段值。</p></section>'));
        });
        return;
      }
      html(res, 'Not found', 404);
    });
    const targetHost = new URL(destination.origin).host;
    context = await browser.newContext({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const allowed = new Set([source.origin, destination.origin]);
    await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const sourcePage = await context.newPage();
    await sourcePage.goto(source.origin);
    const sourceBefore = await sourcePage.content();
    const captured = await sourcePage.locator('[data-field]').evaluateAll(nodes => nodes.map(node => ({ field: node.dataset.field, value: node.textContent })));
    const scope = 'page-transfer/execution-1';
    const entries = [];
    for (const field of captured) {
      const registered = await must('register', { scope, value: field.value, label: `page/${field.field}`, host: targetHost });
      entries.push({ field: field.field, label: LABELS[field.field], ...registered });
    }
    const snapshot = {
      fictionalDemo: true,
      note: '模拟模型工具输出；字段原值仅经受控驱动与 gate 的内部管道。',
      source: source.origin,
      authorizedDestination: destination.origin,
      fields: entries.map(({ field, label, ref }) => ({ field, label, ref })),
    };
    const snapshotText = JSON.stringify(snapshot, null, 2);
    await writeFile(path.join(outDir, 'model-snapshot.json'), snapshotText + '\n');
    check('模型快照只有短引用，不含字段原值', Object.values(VALUES).every(value => !snapshotText.includes(value)) && snapshot.fields.every(field => /^enc:ref:[\w-]{16}$/.test(field.ref)));
    check('采集和加密不修改来源页面 DOM', sourceBefore === await sourcePage.content());
    check('来源页与目标页使用不同本地端口', source.origin !== destination.origin);
    await sourcePage.screenshot({ path: path.join(outDir, 'transfer-source.png'), fullPage: true, caret: 'initial' });
    const targetPage = await context.newPage();
    await targetPage.goto(destination.origin);
    const wrongHost = await call('resolve', { scope, ref: entries[0].ref, host: new URL(source.origin).host, use: 'http' });
    check('错误目的地（同 IP、不同端口）被拒绝', !wrongHost.ok && wrongHost.code === 'policy_denied');
    const wrongScope = await call('resolve', { scope: 'another-task', ref: entries[0].ref, host: targetHost, use: 'http' });
    check('另一个任务不能使用此引用', !wrongScope.ok && wrongScope.code === 'scope_mismatch');
    const wrongUse = await call('resolve', { scope, ref: entries[0].ref, host: targetHost, use: 'exec' });
    check('未授权用途被拒绝', !wrongUse.ok && wrongUse.code === 'policy_denied');
    for (const { field, ref } of snapshot.fields) {
      // Trusted driver checks both current page and form destination before
      // requesting plaintext. Never expose resolve replies to a model.
      if (new URL(targetPage.url()).origin !== destination.origin) throw new Error('Unexpected demo destination');
      const action = await targetPage.locator('form').evaluate(form => form.action);
      if (new URL(action).origin !== destination.origin) throw new Error('Unexpected demo form action');
      const resolved = await must('resolve', { scope, ref, host: new URL(targetPage.url()).host, use: 'http' });
      await targetPage.locator(`input[name="${field}"]`).fill(resolved.value);
    }
    check('目标字段收到原值而非密文或引用', (await Promise.all(Object.entries(VALUES).map(async ([key, value]) => await targetPage.locator(`[name="${key}"]`).inputValue() === value))).every(Boolean));
    await targetPage.locator('button').focus();
    const beforeScreenshot = await targetPage.locator('input').evaluateAll(nodes => nodes.map(node => node.value));
    await targetPage.screenshot({ path: path.join(outDir, 'transfer-target.png'), fullPage: true, caret: 'initial', mask: [targetPage.locator('input')], maskColor: '#243d33' });
    check('目标截图遮罩后，表单值保持不变', JSON.stringify(beforeScreenshot) === JSON.stringify(await targetPage.locator('input').evaluateAll(nodes => nodes.map(node => node.value))));
    await targetPage.getByRole('button', { name: '提交虚构记录' }).click();
    await targetPage.locator('#accepted').waitFor();
    check('真实浏览器 POST 到本地目标服务，值比对一致', receipt?.matchesExpected && receipt.fieldCount === 2 && !receipt.receivedReference);
    const released = await must('release', { scope });
    check('执行结束释放本次全部引用', released.released === entries.length);
    const expired = await call('resolve', { scope, ref: entries[0].ref, host: targetHost, use: 'http' });
    check('释放后引用不可继续填入', !expired.ok && expired.code === 'scope_released');
    return {
      name: '页面数据 → 短引用 → 另一个表单',
      description: '真实浏览器在两个本地页面之间搬运虚构邮箱和电话。模型边界以只含引用的模拟快照表示。',
      checks,
      artifacts: { before: 'transfer-source.png', after: 'transfer-target.png', beforeLabel: '来源页面 · 虚构数据', afterLabel: '目标页面 · 已填入并遮罩', snapshot: 'model-snapshot.json' },
      metrics: { '搬运字段': entries.length, '密文总字符': entries.reduce((sum, entry) => sum + entry.tokenLength, 0), '引用总字符': entries.reduce((sum, entry) => sum + entry.refLength, 0), '内部 gate 调用': gateCalls, '本地耗时（ms）': Math.round(performance.now() - started) },
      limitations: [
        '受控驱动使用已指定的字段和目的地；本例没有自动推断任意页面的 PII 或业务含义。',
        '没有真实模型调用；模拟快照证明输出边界，不能证明执行者在复杂任务中的行为。',
        '本地表单没有第三方脚本；复杂站点的导航竞态、iframe 和出站数据通道需要正式 gate 集成。',
      ],
    };
  } finally {
    try { await context?.close(); }
    finally { await Promise.all([closeServer(source?.server), closeServer(destination?.server)]); }
  }
}
