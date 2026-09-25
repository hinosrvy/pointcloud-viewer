/** 小さな DOM ヘルパー（フレームワーク不使用） */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (typeof v === 'boolean') {
      if (v) e.setAttribute(k, '');
    } else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export function section(title: string, open = true): HTMLDetailsElement {
  const d = el('details', open ? { open: true } : {}, el('summary', { text: title }));
  return d;
}

export function slider(label: string, opts: { min: number; max: number; step: number; value: number; format?: (v: number) => string }, onChange: (v: number) => void): HTMLDivElement {
  const input = el('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value });
  const val = el('span', { class: 'val' });
  const fmt = opts.format ?? ((v: number) => String(v));
  val.textContent = fmt(opts.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    onChange(v);
  });
  return el('div', { class: 'row' }, el('label', { text: label }), input, val);
}

export function numberInput(label: string, value: number, onChange: (v: number) => void, step = 0.1): { row: HTMLDivElement; input: HTMLInputElement } {
  const input = el('input', { type: 'number', value, step });
  input.addEventListener('change', () => onChange(Number(input.value)));
  return { row: el('div', { class: 'row' }, el('label', { text: label }), input), input };
}

export function select(label: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void): { row: HTMLDivElement; select: HTMLSelectElement } {
  const s = el('select');
  for (const o of options) s.append(el('option', { value: o.value, text: o.label }));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return { row: el('div', { class: 'row' }, el('label', { text: label }), s), select: s };
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): { row: HTMLDivElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const lab = el('label');
  lab.append(input, ' ', label);
  lab.style.minWidth = '0';
  lab.style.color = 'inherit';
  return { row: el('div', { class: 'row' }, lab), input };
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: cls, text: label });
  b.addEventListener('click', onClick);
  return b;
}

export function fileButton(label: string, accept: string, multiple: boolean, onFiles: (files: File[]) => void, cls = ''): HTMLButtonElement {
  const input = el('input', { type: 'file', accept, multiple });
  input.style.display = 'none';
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  });
  const b = button(label, () => input.click(), cls);
  b.append(input);
  return b;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('ja-JP');
}
