/** Patch a view in place. An editor and its ancestors stay connected during background updates;
 * restoring its value/focus after replacing it would already have cancelled an IME composition. */
const FIELD = "INPUT,TEXTAREA,SELECT".split(",");
const isField = (el) => FIELD.includes(el.nodeName);
const ownKey = (el) => el.nodeType === 1 ? el.hasAttribute("data-composer-key")
  ? `composer:${el.dataset.composerKey}` : el.id ? `id:${el.id}` : "" : "";

export function createRenderer(root) {
  const doc = root.ownerDocument;
  const composing = new WeakSet();
  const defaults = new WeakMap();
  let scope, html;
  root.addEventListener("compositionstart", (e) => composing.add(e.target));
  root.addEventListener("compositionend", (e) => composing.delete(e.target));

  const values = (el) => ({ value: el.value, checked: el.checked });
  function remember(node) {
    if (node.nodeType !== 1) return;
    if (isField(node)) defaults.set(node, values(node));
    for (const field of node.querySelectorAll("input,textarea,select")) defaults.set(field, values(field));
  }

  function updateField(el, wanted) {
    const before = defaults.get(el) || values(el);
    const next = values(wanted);
    const editing = el === doc.activeElement || composing.has(el);
    // Unchanged model values do not overwrite DOM drafts, including unfocused draft fields.
    if (!editing && next.value !== before.value && el.value !== next.value) el.value = next.value;
    if (!editing && next.checked !== before.checked) el.checked = next.checked;
    defaults.set(el, next);
  }

  function patch(el, wanted, anchors) {
    if (el.nodeType !== 1) {
      if (el.nodeValue !== wanted.nodeValue) el.nodeValue = wanted.nodeValue;
      return;
    }
    const field = isField(el);
    if (!field && !el.querySelector("input,textarea,select") && el.isEqualNode(wanted)) return;
    const keepOpen = el.hasAttribute("data-keep-open");
    const skip = (name) => (field && ["value", "checked", "selected"].includes(name)) || (keepOpen && name === "open");
    for (const attr of [...el.attributes]) {
      if (!skip(attr.name) && !wanted.hasAttribute(attr.name)) el.removeAttribute(attr.name);
    }
    for (const attr of wanted.attributes) {
      if (!skip(attr.name) && el.getAttribute(attr.name) !== attr.value) el.setAttribute(attr.name, attr.value);
    }
    // A textarea's text child is its default value; touching it can reset an active composition.
    if (el.nodeName !== "TEXTAREA" && el.nodeName !== "INPUT") {
      const selected = el.nodeName === "SELECT" ? el.value : undefined;
      children(el, wanted, anchors);
      if (selected !== undefined && el.value !== selected && [...el.options].some((option) => option.value === selected)) el.value = selected;
    }
    if (field) updateField(el, wanted);
  }

  function children(parent, wanted, anchors) {
    const old = [...parent.childNodes];
    const used = new Set();
    function keys(node) {
      if (!anchors.has(node)) {
        const fields = node.nodeType === 1 ? [...node.querySelectorAll("input[id],textarea[id],select[id],[data-composer-key],[data-keep-open][id]")] : [];
        anchors.set(node, new Set(fields.map(ownKey)));
      }
      return anchors.get(node);
    }
    const keyed = new Map(), containers = [], plain = new Map();
    const kind = (node) => `${node.nodeType}:${node.nodeName}`;
    const style = (node) => `${kind(node)}:${node.nodeType === 1 ? node.className : ""}`;
    function add(key, node) {
      if (!plain.has(key)) plain.set(key, { nodes: [], index: 0 });
      plain.get(key).nodes.push(node);
    }
    for (const node of old) {
      const key = ownKey(node);
      if (key) keyed.set(key, node);
      else if (keys(node).size) containers.push(node);
      else { add(kind(node), node); add(style(node), node); }
    }
    function take(key) {
      const bucket = plain.get(key);
      if (!bucket) return;
      while (bucket.index < bucket.nodes.length) {
        const node = bucket.nodes[bucket.index++];
        if (!used.has(node)) return node;
      }
    }
    function matching(node) {
      const key = ownKey(node);
      if (key) {
        const found = keyed.get(key);
        return found?.nodeName === node.nodeName && !used.has(found) ? found : undefined;
      }
      const wantedKeys = keys(node);
      if (!wantedKeys.size) return take(style(node)) || take(kind(node));
      // Anonymous wrappers are identified by their editors. Unkeyed event/text lists use
      // queues above so appending SSE output does not scan the whole list for every node.
      let best, rank = 0;
      for (const candidate of containers) {
        if (used.has(candidate) || candidate.nodeName !== node.nodeName) continue;
        const shared = [...keys(candidate)].filter((value) => wantedKeys.has(value)).length;
        if (shared > rank) { best = candidate; rank = shared; }
      }
      return best;
    }
    const next = [...wanted.childNodes].map((node) => {
      const best = matching(node);
      if (!best) { const fresh = node.cloneNode(true); remember(fresh); return fresh; }
      used.add(best);
      patch(best, node, anchors);
      return best;
    });
    for (const node of old) if (!used.has(node)) node.remove();

    // Move siblings around the focused branch, never detach/reinsert that branch itself.
    // insertBefore on an already-connected focused ancestor loses focus in real browsers.
    const fixed = next.findIndex((node) => node === doc.activeElement || node.contains?.(doc.activeElement));
    if (fixed >= 0) {
      let before = next[fixed];
      for (let i = fixed - 1; i >= 0; i--) {
        if (next[i].nextSibling !== before) parent.insertBefore(next[i], before);
        before = next[i];
      }
      let after = next[fixed];
      for (let i = fixed + 1; i < next.length; i++) {
        if (after.nextSibling !== next[i]) parent.insertBefore(next[i], after.nextSibling);
        after = next[i];
      }
    } else {
      let before = null;
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].parentNode !== parent || next[i].nextSibling !== before) parent.insertBefore(next[i], before);
        before = next[i];
      }
    }
  }

  return {
    isComposing: (event) => event.isComposing || event.keyCode === 229 || composing.has(event.target),
    render(nextHtml, nextScope) {
      const reset = nextScope !== scope;
      if (!reset && nextHtml === html) return false;
      const template = doc.createElement("template");
      template.innerHTML = nextHtml;
      if (reset) {
        root.replaceChildren(template.content);
        remember(root);
      } else {
        const scroll = [doc.scrollingElement, root, ...root.querySelectorAll("*")]
          .filter((el) => el && (el.scrollTop || el.scrollLeft))
          .map((el) => [el, el.scrollTop, el.scrollLeft]);
        children(root, template.content, new WeakMap());
        for (const [el, top, left] of scroll) if (el.isConnected) {
          if (el.scrollTop !== top) el.scrollTop = top;
          if (el.scrollLeft !== left) el.scrollLeft = left;
        }
      }
      html = nextHtml; scope = nextScope;
      return true;
    },
  };
}
