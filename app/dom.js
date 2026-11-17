/* The little DOM layer: h() builds an element, svg() an icon, and functions the router and views share
   to set the one page region and to keep the shot flag honest. No framework, no innerHTML for data. */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') el.innerHTML = String(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return add(el, children);
}

function add(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) add(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An inline icon from a viewBox and its path data; stroke only, coloured by currentColor. */
export function svg(viewBox, ...paths) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    el.appendChild(path);
  }
  return el;
}

/** Removes every child, in a loop old enough to be safe in every browser. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replaces the page region's content and returns the node, so a route can keep a handle on it. */
export function mount(node) {
  const view = document.getElementById('view');
  clear(view);
  view.appendChild(node);
  return node;
}

/** The routes that are still loading: the shot flag stays false until every one of them is done. */
let loading = 0;

export function beginLoad() {
  loading += 1;
  window.__shotReady = false;
}

export function endLoad() {
  loading = Math.max(0, loading - 1);
  if (loading === 0) window.__shotReady = true;
}

/** An error a route could not paper over: the flag a screenshot script reads. */
export function failLoad(message, node) {
  window.__error = message;
  if (node) mount(node);
}
