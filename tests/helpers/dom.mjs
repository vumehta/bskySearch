// Minimal tree semantics for exercising the actual DOM-rendering modules.
export class TestNode {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.attributes = {};
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this._text = '';
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      toggle: (name, active) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (active) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(' ');
      },
    };
  }

  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) {
    this._text = String(value);
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
  }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, reference) {
    if (child.tagName === '#fragment') {
      [...child.children].forEach((item) => this.insertBefore(item, reference));
      return child;
    }
    child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

export function createTestDocument(ids) {
  const elements = Object.fromEntries(ids.map((id) => {
    const node = new TestNode();
    node.id = id;
    return [id, node];
  }));
  const find = (node, id) => node.id === id ? node : node.children.map((child) => find(child, id)).find(Boolean);
  const document = {
    documentElement: new TestNode('html'),
    getElementById: (id) => elements[id] || Object.values(elements).map((node) => find(node, id)).find(Boolean) || null,
    createElement: (tag) => new TestNode(tag),
    createDocumentFragment: () => new TestNode('#fragment'),
    createTextNode: (text) => {
      const node = new TestNode('#text');
      node.textContent = text;
      return node;
    },
  };
  return { document, elements };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
