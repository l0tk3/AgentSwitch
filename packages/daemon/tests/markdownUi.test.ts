/** The console's Markdown (docs/ui-v0.md §7.4, 2026-10-01): what agents write, drawn safely. */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const UI = resolve(import.meta.dirname, "..", "ui");
const { md, mdInline, mdTyped } = await import(join(UI, "lib/markdown.js"));

describe("console markdown", () => {
  it("escapes everything that is not Markdown: no raw HTML, no script links", () => {
    expect(md("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(mdInline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(mdInline('[docs](https://example.com/a?b=1&c="2")')).toBe('<a href="https://example.com/a?b=1&amp;c=&quot;2&quot;" target="_blank" rel="noopener noreferrer">docs</a>');
  });

  it("inline: code kept whole, bold, italic with asterisks only, strike-through", () => {
    expect(mdInline("运行 `rm -rf **build**` 之前")).toBe("运行 <code>rm -rf **build**</code> 之前");
    expect(mdInline("**注意** 与 *提示* 与 ~~旧的~~")).toBe("<strong>注意</strong> 与 <em>提示</em> 与 <del>旧的</del>");
    // Underscores in paths and names stay as they are.
    expect(mdInline("~/Library/Application_Support/my_file_name")).toBe("~/Library/Application_Support/my_file_name");
    expect(mdInline("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("a result as an agent writes it: a paragraph, a list with code, a table, a fence", () => {
    const html = md([
      "本轮只读排查完成：找到一处 Java 运行时。",
      "",
      "- 路径：`/Users/u/Library/Application Support/PrismLauncher/java/bin/java`",
      "- 版本：OpenJDK 25.0.1",
      "  - 来源：`java -version`",
      "",
      "| 项 | 值 |",
      "|---|---|",
      "| JAVA_HOME | 空 |",
      "",
      "```sh",
      "java -version <x>",
      "```",
    ].join("\n"));
    expect(html).toBe([
      "<p>本轮只读排查完成：找到一处 Java 运行时。</p>",
      "<ul><li>路径：<code>/Users/u/Library/Application Support/PrismLauncher/java/bin/java</code></li><li>版本：OpenJDK 25.0.1<ul><li>来源：<code>java -version</code></li></ul></li></ul>",
      '<div class="mdt"><table><thead><tr><th>项</th><th>值</th></tr></thead><tbody><tr><td>JAVA_HOME</td><td>空</td></tr></tbody></table></div>',
      '<pre><code data-lang="sh">java -version &lt;x&gt;</code></pre>',
    ].join(""));
  });

  it("headings stay small, quotes and ordered lists, lines of a paragraph kept apart", () => {
    expect(md("# 结论\n## 细节")).toBe('<h3 class="mdh">结论</h3><h4 class="mdh">细节</h4>');
    expect(md("> 原话\n> 第二行")).toBe("<blockquote><p>原话<br>第二行</p></blockquote>");
    expect(md("3. 第三\n4. 第四")).toBe('<ol start="3"><li>第三</li><li>第四</li></ol>');
    expect(md("第一行\n第二行")).toBe("<p>第一行<br>第二行</p>");
  });
});

// What a person typed (2026-10-03, user: dispatch里加上代码块支持吧，这样看着太难受了): only its code is read, the rules the
// apps use (DispatchCodeTests / MarkdownCodeTests, the same cases).
describe("console typed text", () => {
  it("splits only at fences; the rest is escaped as typed", () => {
    expect(mdTyped("跑一下这两条：\n```bash\ngit status --short\n<b>x</b>\n```\n\n然后告诉我结果")).toBe(
      '<span class="typed">跑一下这两条：</span><pre><code data-lang="bash">git status --short\n&lt;b&gt;x&lt;/b&gt;</code></pre><span class="typed">然后告诉我结果</span>');
    const typed = "# 不是标题\n- 不是列表\n*星号* 和 _下划线_ 原样\n\n\n空行也在";
    expect(mdTyped(typed)).toBe(`<span class="typed">${typed}</span>`);
    expect(mdTyped("")).toBe("");
  });

  it("fences: open runs to the end, ```ls``` is a span, only a bare fence as long closes, indentation comes off", () => {
    expect(mdTyped("看这个：\n~~~\nls -la")).toBe('<span class="typed">看这个：</span><pre><code>ls -la</code></pre>');
    expect(mdTyped("```ls``` 是行内代码")).toBe('<span class="typed"><code>ls</code> 是行内代码</span>');
    expect(mdTyped("````md\n```bash\nls\n```\n````")).toBe('<pre><code data-lang="md">```bash\nls\n```</code></pre>');
    expect(mdTyped("- 步骤：\n  ```sh\n  make\n    make install\n done\n  ```")).toBe(
      '<span class="typed">- 步骤：</span><pre><code data-lang="sh">make\n  make install\ndone</code></pre>');
  });

  it("code spans stay on one line; a run with no partner stays as typed", () => {
    expect(mdTyped("运行 `npm test` 和 ``a`b``，*星号* 不变，`没闭合")).toBe(
      '<span class="typed">运行 <code>npm test</code> 和 <code>a`b</code>，*星号* 不变，`没闭合</span>');
    expect(mdTyped("` padded ` and `<i>`")).toBe('<span class="typed"><code>padded</code> and <code>&lt;i&gt;</code></span>');
    expect(mdTyped("`a\nb`")).toBe('<span class="typed">`a\nb`</span>');
  });
});
