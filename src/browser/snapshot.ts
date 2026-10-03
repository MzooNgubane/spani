import { createHash } from 'node:crypto';
import type { Page, Frame } from 'playwright';
import { z } from 'zod';

/**
 * The single most important cost decision in the project.
 *
 * A real application page is 150-400 KB of HTML. Sending that to Claude costs
 * ~50-100k tokens per page and would exhaust a Pro plan in a handful of
 * applications. Instead we walk the DOM ourselves and emit a compact semantic
 * description of the FORM ONLY - typically 1-3 KB.
 *
 * Everything the model needs to map a field (its label, kind, options,
 * constraints) survives. Everything it does not need (layout, styling,
 * scripts, nav chrome, analytics) is dropped before it costs anything.
 */

export const FieldKind = z.enum([
  'text', 'email', 'tel', 'number', 'date', 'url', 'password',
  'textarea', 'select', 'radio', 'checkbox', 'file', 'hidden', 'button', 'unknown',
]);

export const FieldSchema = z.object({
  ref: z.string(),
  label: z.string(),
  kind: FieldKind,
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  maxLength: z.number().optional(),
  /** name/id/autocomplete: weak hints, useful when the visible label is poor. */
  hints: z.array(z.string()).optional(),
  /** Validation or helper text rendered next to the field. */
  note: z.string().optional(),
  group: z.string().optional(),
  frame: z.string().optional(),
  disabled: z.boolean().optional(),
});

export type Field = z.infer<typeof FieldSchema>;

export interface PageSnapshot {
  url: string;
  title: string;
  heading: string | null;
  fields: Field[];
  buttons: Array<{ ref: string; label: string; kind: string }>;
  errors: string[];
  stepIndicator: string | null;
  /** Stable across visits with the same form; the fieldmap cache key. */
  signature: string;
  /** Rough token estimate, so we can log what we are actually spending. */
  approxTokens: number;
}

/** Runs inside the page. Must be self-contained - no imports, no closures. */
/* c8 ignore start */
function extract(): Omit<PageSnapshot, 'signature' | 'approxTokens' | 'frame'> {
  const clean = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' &&
      (r.width > 0 || r.height > 0 || (el as HTMLInputElement).type === 'hidden');
  };

  /** Label resolution, most reliable source first. */
  const labelFor = (el: HTMLElement): string => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;

    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) { const t = clean(l.textContent); if (t) return t; }
    }
    const wrap = el.closest('label');
    if (wrap) { const t = clean(wrap.textContent); if (t) return t; }

    // Fieldset legend, for radio/checkbox groups.
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) { const t = clean(legend.textContent); if (t) return t; }

    // Nearest preceding text node in the same block - covers hand-rolled forms.
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const text = Array.from(node.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => clean(n.textContent)).filter(Boolean).join(' ');
      if (text.length > 2) return text;
    }
    return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name')) || '';
  };

  const kindOf = (el: HTMLElement): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type.toLowerCase();
      return ['text', 'email', 'tel', 'number', 'date', 'url', 'password',
        'radio', 'checkbox', 'file', 'hidden'].includes(t) ? t : 'text';
    }
    if (el.getAttribute('contenteditable') === 'true') return 'textarea';
    return 'unknown';
  };

  const fields: any[] = [];
  const seenRadioGroups = new Set<string>();
  let i = 0;

  const nodes = document.querySelectorAll<HTMLElement>(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="radiogroup"]',
  );

  for (const el of nodes) {
    const kind = kindOf(el);
    if (kind === 'hidden') continue;
    if (!visible(el)) continue;

    const input = el as HTMLInputElement;
    const name = input.name || '';

    // Collapse a radio group into ONE field with options, not N booleans.
    if (kind === 'radio') {
      const gk = name || labelFor(el);
      if (seenRadioGroups.has(gk)) continue;
      seenRadioGroups.add(gk);
      const members = Array.from(
        document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`),
      );
      const legend = el.closest('fieldset')?.querySelector('legend');
      fields.push({
        ref: `f${++i}`,
        label: clean(legend?.textContent) || labelFor(el) || name,
        kind: 'radio',
        required: members.some((m) => m.required),
        options: members.map((m) => labelFor(m) || m.value).filter(Boolean),
        value: members.find((m) => m.checked)?.value,
        hints: [name].filter(Boolean),
        disabled: members.every((m) => m.disabled),
      });
      continue;
    }

    const f: any = {
      ref: `f${++i}`,
      label: labelFor(el),
      kind,
      required: input.required || el.getAttribute('aria-required') === 'true',
      hints: [name, el.id, el.getAttribute('autocomplete')].filter(Boolean).slice(0, 3),
    };

    if (kind === 'select') {
      f.options = Array.from((el as unknown as HTMLSelectElement).options)
        .map((o) => clean(o.textContent) || o.value)
        .filter((t) => t && !/^(please )?select|^choose|^--/i.test(t))
        .slice(0, 60);
      f.value = (el as unknown as HTMLSelectElement).value || undefined;
    } else if (kind === 'checkbox') {
      f.value = input.checked ? 'true' : 'false';
    } else if (kind !== 'file') {
      f.value = clean(input.value) || undefined;
      if (input.maxLength && input.maxLength > 0) f.maxLength = input.maxLength;
      const ph = clean(el.getAttribute('placeholder'));
      if (ph) f.placeholder = ph;
    }

    const described = el.getAttribute('aria-describedby');
    if (described) {
      const note = described.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent))
        .filter(Boolean).join(' ');
      if (note) f.note = note;
    }
    if (input.disabled) f.disabled = true;
    fields.push(f);
  }

  const buttons = Array.from(document.querySelectorAll<HTMLElement>(
    'button, input[type="submit"], input[type="button"], [role="button"], a.btn',
  )).filter(visible).slice(0, 25).map((b, n) => ({
    ref: `b${n + 1}`,
    label: clean(b.textContent) || clean(b.getAttribute('value')) || clean(b.getAttribute('aria-label')),
    kind: (b as HTMLInputElement).type === 'submit' || /submit|apply|send/i.test(b.textContent ?? '')
      ? 'submit' : 'button',
  })).filter((b) => b.label);

  const errors = Array.from(document.querySelectorAll(
    '[role="alert"], .error, .invalid-feedback, .field-error, [aria-invalid="true"], .help-block.error',
  )).map((e) => clean(e.textContent)).filter((t) => t.length > 2).slice(0, 15);

  const stepEl = document.querySelector('[class*="step"], [class*="progress"], [aria-label*="step" i]');

  return {
    url: location.href,
    title: clean(document.title),
    heading: clean(document.querySelector('h1')?.textContent) || null,
    fields,
    buttons,
    errors: [...new Set(errors)],
    stepIndicator: stepEl ? clean(stepEl.textContent).slice(0, 80) || null : null,
  } as any;
}
/* c8 ignore stop */

/**
 * Signature = the form's SHAPE, ignoring values and ordering noise.
 * Two visits to the same form produce the same signature, so the cached
 * fieldmap applies. A site redesign changes it, which invalidates the cache
 * and triggers exactly one re-map.
 */
export function signatureOf(fields: Field[], url: string): string {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const shape = fields
    .map((f) => `${f.kind}:${f.label.toLowerCase().replace(/\s+/g, ' ').slice(0, 60)}:${f.required ? 1 : 0}`)
    .sort()
    .join('|');
  return createHash('sha256').update(`${host}##${shape}`).digest('hex').slice(0, 32);
}

/**
 * esbuild (via tsx) rewrites named functions with a `__name(fn, "name")`
 * helper for stack traces. That helper lives in the Node module scope, so a
 * function serialized into the page references an undefined `__name` and
 * throws. Defining a no-op shim in the page first is the least invasive fix -
 * evaluated as a string so it cannot itself be rewritten.
 */
const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f)';

async function ensureShim(target: Page | Frame): Promise<void> {
  await target.evaluate(NAME_SHIM);
}

export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  await page.waitForLoadState('domcontentloaded');
  await ensureShim(page);
  const main = (await page.evaluate(extract)) as Omit<PageSnapshot, 'signature' | 'approxTokens'>;

  // Same-origin iframes: many ATS forms (SuccessFactors especially) live in one.
  const frames = page.frames().filter((f: Frame) => f !== page.mainFrame());
  for (const [n, frame] of frames.entries()) {
    try {
      await ensureShim(frame);
      const sub = (await frame.evaluate(extract)) as Omit<PageSnapshot, 'signature' | 'approxTokens'>;
      if (!sub.fields.length) continue;
      const tag = `if${n + 1}`;
      for (const f of sub.fields) { f.ref = `${tag}.${f.ref}`; f.frame = tag; }
      main.fields.push(...sub.fields);
      main.errors.push(...sub.errors);
    } catch {
      // Cross-origin frame: inaccessible by design. Recorded, not fatal.
      main.errors.push(`[frame ${n + 1} not accessible]`);
    }
  }

  const parsed = z.array(FieldSchema).safeParse(main.fields);
  if (!parsed.success) {
    main.fields = main.fields.filter((f) => FieldSchema.safeParse(f).success);
  }

  const signature = signatureOf(main.fields, main.url);
  const approxTokens = Math.ceil(JSON.stringify(main).length / 3.6);
  return { ...main, signature, approxTokens };
}

/** The exact text handed to Claude. Kept minimal on purpose. */
export function snapshotForPrompt(s: PageSnapshot): string {
  return JSON.stringify({
    title: s.title,
    heading: s.heading,
    step: s.stepIndicator,
    errors: s.errors.length ? s.errors : undefined,
    fields: s.fields.map((f) => ({
      ref: f.ref, label: f.label, kind: f.kind,
      required: f.required || undefined,
      options: f.options?.length ? f.options : undefined,
      maxLength: f.maxLength,
      note: f.note,
      hints: f.hints?.length ? f.hints : undefined,
    })),
    buttons: s.buttons.map((b) => ({ ref: b.ref, label: b.label, kind: b.kind })),
  });
}
