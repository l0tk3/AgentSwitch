import path from 'node:path';
import { performance } from 'node:perf_hooks';

const MASK_COLOR = '#172a3a';
const MASK_RGB = [23, 42, 58];
const REGION_LABELS = {
  'normal text': '普通文本', 'pattern email': '规则匹配的邮箱',
  'visible password input': '明文显示的密码框', 'dynamic node': '异步插入的节点',
  'shadow DOM': 'Shadow DOM 节点', iframe: 'iframe 内的节点', 'entire canvas': '整块画布',
  'public action': '正常操作按钮', 'public label': '正常标签', 'synthetic watermark': '虚构数据水印',
};

// All values on this page are deliberately fictional. This is a coverage fixture,
// not a claim that arbitrary sensitive data can be discovered by selectors.
const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Secret gate mask demo — synthetic data</title>
<style>
* { box-sizing: border-box; } body { margin: 0; padding: 32px; background: #edf2f7; color: #172a3a; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 1120px; margin: 0 auto; } .watermark { color: #9b2c2c; font-weight: 800; letter-spacing: 1px; }
h1 { margin: 8px 0; font-size: 30px; } .intro { margin: 0 0 24px; color: #526273; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.card { background: white; border: 1px solid #d3dde7; border-radius: 12px; padding: 20px; min-height: 146px; }
h2 { font-size: 15px; margin: 0 0 14px; color: #526273; }
.private { display: inline-block; padding: 8px 12px; background: #fff6d9; border: 1px solid #ead9a5; border-radius: 4px; font-family: ui-monospace, monospace; }
input { font: 15px ui-monospace, monospace; padding: 9px; border: 1px solid #b1bfce; border-radius: 4px; width: 100%; }
button { font: inherit; border: 0; border-radius: 6px; padding: 9px 18px; background: #17766b; color: white; cursor: pointer; }
.toolbar { display: flex; align-items: center; gap: 18px; padding: 18px 0; }
.tag { font-size: 13px; color: #526273; } iframe { width: 100%; height: 70px; border: 0; } canvas { display: block; width: 440px; height: 70px; max-width: 100%; }
</style></head><body><main>
<div class="watermark">SYNTHETIC DEMO · NO REAL ACCOUNTS OR PERSONAL DATA</div>
<h1>Screenshot masking, without changing the page</h1>
<p class="intro">Labels and actions stay visible. Selected values are hidden only in the captured image.</p>
<div class="grid">
  <section class="card"><h2 id="public-label">01 · Known selector / normal text node</h2><span id="known" class="private" data-demo-private>DEMO-ACCOUNT-0042</span></section>
  <section class="card"><h2>02 · Pattern match in an allowlisted region</h2><span id="pattern" class="private" data-contact>demo.user@example.invalid</span></section>
  <section class="card"><h2>03 · Input in “show password” mode</h2><label class="tag" for="editable">Fixture password</label><input id="editable" type="password" autocomplete="off"><button id="show-password" style="margin-top:8px">Show password</button></section>
  <section class="card"><h2>04 · Asynchronously inserted content</h2><div id="dynamic-root"></div></section>
  <section class="card"><h2>05 · Open Shadow DOM</h2><div id="shadow-host"></div></section>
  <section class="card"><h2>06 · Isolated iframe</h2><iframe id="demo-frame" title="Synthetic iframe" sandbox="allow-same-origin"></iframe></section>
  <section class="card"><h2>07 · Canvas (mask the entire surface)</h2><canvas id="private-canvas" width="440" height="70"></canvas></section>
  <section class="card"><h2>08 · Unmasked application controls</h2><button id="public-action">Save demo record</button><p class="tag">The button and its label remain readable.</p></section>
</div><div class="toolbar"><span class="tag">Before: fixture values visible · After: opaque masks at screenshot time</span></div>
</main><script>
document.querySelector('#show-password').onclick = () => { document.querySelector('#editable').type = 'text'; };
const shadow = document.querySelector('#shadow-host').attachShadow({mode:'open'});
shadow.innerHTML = '<style>span { display:inline-block; padding:8px 12px; background:#fff6d9; border:1px solid #ead9a5; font:15px monospace; }</style><span id="shadow-private">DEMO-SHADOW-SECRET</span>';
document.querySelector('#demo-frame').srcdoc = '<!doctype html><style>body{margin:4px;font:15px monospace;color:#172a3a}span{display:inline-block;padding:10px;background:#fff6d9;border:1px solid #ead9a5}</style><span id="frame-private">frame.demo@example.invalid</span>';
const ctx = document.querySelector('#private-canvas').getContext('2d');
ctx.fillStyle = '#fff6d9'; ctx.fillRect(0, 0, 440, 70); ctx.fillStyle = '#172a3a'; ctx.font = '17px monospace'; ctx.fillText('DEMO-CANVAS-ONLY-VALUE', 14, 42);
setTimeout(() => { const item = document.createElement('span'); item.id = 'dynamic-private'; item.className = 'private'; item.textContent = 'DEMO-ASYNC-9381'; document.querySelector('#dynamic-root').append(item); }, 25);
</script></body></html>`;

async function currentFieldState(page, selector, history) {
  const current = await page.locator(selector).evaluateAll(elements => {
    if (elements.length !== 1) return 'unknown';
    const element = elements[0];
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return 'unknown';
    return element.value.length === 0 ? 'empty' : 'nonempty';
  });
  return { current, attempted: history.attempted, filled: history.filled };
}

async function pageState(page) {
  const main = await page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    values: Array.from(document.querySelectorAll('input,textarea')).map(element => ({
      id: element.id, type: element.type, value: element.value,
    })),
    shadow: document.querySelector('#shadow-host').shadowRoot.innerHTML,
    canvas: document.querySelector('#private-canvas').toDataURL(),
  }));
  const frame = await page.frameLocator('#demo-frame').locator('html').evaluate(element => element.outerHTML);
  return JSON.stringify({ main, frame });
}

// Use the browser's native PNG decoder in an unrelated blank page. No image
// dependencies are installed and no inspection script is injected into the fixture.
async function comparePixels(inspector, before, after, regions) {
  return inspector.evaluate(async ({ before, after, regions, rgb }) => {
    async function decode(base64) {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    }
    const [original, masked] = await Promise.all([decode(before), decode(after)]);
    return regions.map(region => {
      // Bounding boxes can have fractional CSS-pixel edges. Check every interior
      // pixel at deviceScaleFactor 1, excluding only the rounding boundary.
      const x0 = Math.max(0, Math.ceil(region.box.x) + 1);
      const y0 = Math.max(0, Math.ceil(region.box.y) + 1);
      const x1 = Math.min(masked.width, Math.floor(region.box.x + region.box.width) - 1);
      const y1 = Math.min(masked.height, Math.floor(region.box.y + region.box.height) - 1);
      let total = 0; let opaque = 0; let changed = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const offset = (y * masked.width + x) * 4;
        total++;
        if (masked.data[offset] === rgb[0] && masked.data[offset + 1] === rgb[1] && masked.data[offset + 2] === rgb[2] && masked.data[offset + 3] === 255) opaque++;
        if ([0, 1, 2, 3].some(channel => masked.data[offset + channel] !== original.data[offset + channel])) changed++;
      }
      return { name: region.name, masked: region.masked, total, opaque, changed };
    });
  }, { before: before.toString('base64'), after: after.toString('base64'), regions, rgb: MASK_RGB });
}

export async function runMaskDemo({ browser, outDir }) {
  const started = performance.now();
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  const context = await browser.newContext({ viewport: { width: 1240, height: 1100 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    // An offline fixture: all browser content is created locally in memory.
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(FIXTURE);
    await page.locator('#dynamic-private').waitFor({ state: 'visible' });
    await page.frameLocator('#demo-frame').locator('#frame-private').waitFor({ state: 'visible' });

    const history = { attempted: false, filled: false };
    let state = await currentFieldState(page, '#editable', history);
    check('初始字段为空，且没有填写历史', state.current === 'empty' && !state.attempted && !state.filled);
    history.attempted = true;
    await page.locator('#editable').fill('NOT-A-REAL-PASSWORD-2468');
    history.filled = true;
    state = await currentFieldState(page, '#editable', history);
    check('填写成功后当前状态为非空，填写历史独立记录', state.current === 'nonempty' && state.attempted && state.filled);
    await page.locator('#editable').fill('');
    state = await currentFieldState(page, '#editable', history);
    check('清空后当前状态为空，历史填充记录不会误报非空', state.current === 'empty' && state.filled);
    await page.locator('#editable').fill('NOT-A-REAL-PASSWORD-2468');
    await page.locator('#editable').evaluate(element => { const replacement = element.cloneNode(); replacement.value = ''; element.replaceWith(replacement); });
    state = await currentFieldState(page, '#editable', history);
    check('节点替换后读取新节点状态，不沿用旧填写状态', state.current === 'empty' && state.filled);
    state = await currentFieldState(page, '#missing-field', history);
    check('字段不存在时返回未知', state.current === 'unknown');
    state = await currentFieldState(page, '#public-label', history);
    check('目标不是输入框时返回未知', state.current === 'unknown');
    await page.locator('#editable').fill('NOT-A-REAL-PASSWORD-2468');
    await page.locator('#show-password').click();
    check('截图遮罩前，测试密码框确实处于明文显示模式', await page.locator('#editable').getAttribute('type') === 'text');

    // Discovery is intentionally constrained to fixture policy selectors. The
    // pattern test applies only inside an allowlisted contact region.
    const patternCandidate = page.locator('[data-contact]');
    const patternMatched = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(await patternCandidate.innerText());
    check('在指定区域内按规则匹配虚构邮箱', patternMatched);
    const targets = [
      { name: 'normal text', locator: page.locator('[data-demo-private]') },
      ...(patternMatched ? [{ name: 'pattern email', locator: patternCandidate }] : []),
      { name: 'visible password input', locator: page.locator('#editable') },
      { name: 'dynamic node', locator: page.locator('#dynamic-private') },
      { name: 'shadow DOM', locator: page.locator('#shadow-host #shadow-private') },
      { name: 'iframe', locator: page.frameLocator('#demo-frame').locator('#frame-private') },
      { name: 'entire canvas', locator: page.locator('#private-canvas') },
    ];
    const regions = [];
    for (const target of targets) {
      const box = await target.locator.boundingBox();
      if (!box) throw new Error(`Fixture mask target is not visible: ${target.name}`);
      regions.push({ name: target.name, box, masked: true });
    }
    for (const [name, selector] of [['public action', '#public-action'], ['public label', '#public-label'], ['synthetic watermark', '.watermark']]) {
      const box = await page.locator(selector).boundingBox();
      if (!box) throw new Error(`Fixture public target is not visible: ${name}`);
      regions.push({ name, box, masked: false });
    }
    // Move the cursor off controls before comparing pixels (hover effects, if
    // added to the fixture later, must not be confused with screenshot masks).
    await page.mouse.move(1, 1);
    await page.locator('#editable').blur();
    const stateBefore = await pageState(page);
    // No field is focused. Keep caret handling untouched as Playwright's caret
    // hiding can leave an empty style attribute on an otherwise unstyled input.
    const before = await page.screenshot({ path: path.join(outDir, 'mask-before.png'), fullPage: true, animations: 'disabled', caret: 'initial' });
    const after = await page.screenshot({ path: path.join(outDir, 'mask-after.png'), fullPage: true, animations: 'disabled', caret: 'initial', mask: targets.map(target => target.locator), maskColor: MASK_COLOR });
    const stateAfter = await pageState(page);
    check('截图前后 DOM、输入值、Shadow DOM、iframe 和画布保持一致', stateBefore === stateAfter);
    const inspector = await context.newPage();
    const pixels = await comparePixels(inspector, before, after, regions);
    for (const region of pixels) {
      if (region.masked) {
        check(`不透明像素覆盖：${REGION_LABELS[region.name]}`, region.total > 0 && region.opaque === region.total && region.changed > 0, `${region.opaque}/${region.total} 个内部像素为不透明遮罩色`);
      } else {
        check(`公开内容保持不变：${REGION_LABELS[region.name]}`, region.total > 0 && region.changed === 0, `已比较 ${region.total} 个内部像素`);
      }
    }
    return {
      name: '截图遮罩与字段实时状态',
      checks,
      artifacts: { before: 'mask-before.png', after: 'mask-after.png' },
      metrics: { '耗时（毫秒）': Math.round(performance.now() - started), '遮罩区域数': targets.length, '验证的遮罩内部像素数': pixels.filter(region => region.masked).reduce((sum, region) => sum + region.total, 0), '遮罩颜色': MASK_COLOR },
      limitations: [
        '仅验证虚构页面的指定选择器，以及指定区域内的模式匹配；不代表能够自动识别任意个人敏感信息。',
        '覆盖开放的 Shadow DOM 和本地同源 iframe；封闭的 Shadow DOM、跨域或持续变化的页面仍需单独接入 gate，并在无法保证遮挡时拒绝截图。',
        '画布采用整块遮挡，没有通过 OCR 识别图片中的局部秘密。',
        '原生截图遮罩保留页面原值；DOM 快照、网络响应和其他工具仍需各自的输出保护。',
        '异步测试节点在截图前已稳定；本 demo 不保证发现目标到截图之间任意页面变更的安全性。',
      ],
    };
  } finally {
    await context.close();
  }
}
