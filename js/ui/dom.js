/** Tiny element builder: h('button', { class: 'x', onclick }, 'Text') */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function replace(container, ...children) {
  container.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

/** Copy text; falls back to a selectable textarea when the clipboard API is missing (older Bluefy). */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * A button that needs two taps. Used instead of confirm(), which some iOS
 * in-app browsers (Bluefy is built on WKWebView) may not show at all.
 */
export function confirmButton(label, onConfirm, { class: cls = 'btn', armedLabel = 'Tap again to confirm', ms = 4000 } = {}) {
  let timer = null;
  const btn = h('button', {
    class: cls,
    type: 'button',
    onclick: () => {
      if (btn.dataset.armed) {
        clearTimeout(timer);
        delete btn.dataset.armed;
        btn.textContent = label;
        onConfirm();
        return;
      }
      btn.dataset.armed = '1';
      btn.textContent = armedLabel;
      timer = setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = label;
      }, ms);
    },
  }, label);
  return btn;
}

export function messageBox(app) {
  return [
    app.busy ? h('div', { class: 'msg busy', role: 'status' }, h('span', { class: 'spinner' }), app.busy, app.progress ? h('div', { class: 'sub' }, app.progress) : null) : null,
    app.error ? h('div', { class: 'msg error', role: 'alert' }, app.error) : null,
    app.notice && !app.error ? h('div', { class: 'msg ok' }, app.notice) : null,
  ];
}
