import { EMAIL_INVALID } from './email-check.js';

/**
 * Site-wide field messages (S8, owner feedback 2026-10-28). When the browser
 * refuses a form, each refused field shows a specific Spanish message under it
 * instead of the browser's generic bubble, which follows the browser language.
 * The pages keep their native constraints (`required`, `type`, `pattern`,
 * `minlength`, `min`...), so without JavaScript the forms still submit and the
 * server answers as before. Forms marked `novalidate` render their own errors
 * from the server and are never touched: the browser does not refuse them.
 */

/** The constraint flags of a field's `ValidityState`. */
export type ValidityFlags = Partial<Record<'valueMissing' | 'typeMismatch' | 'patternMismatch' | 'tooShort' | 'tooLong' | 'rangeUnderflow' | 'rangeOverflow' | 'stepMismatch' | 'badInput' | 'customError', boolean>>;

/** What a message may name about a field. `type` is the element's `type` (`text`, `email`, `select-one`, `textarea`...). */
export type FieldFacts = {
	type: string;
	/** Characters typed. */
	length: number;
	label?: string;
	title?: string;
	hint?: string;
	minLength?: number;
	maxLength?: number;
	min?: string;
	max?: string;
	step?: string;
	/** A message the page set with `setCustomValidity`. */
	custom?: string;
};

const DATE_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);

/** `2026-11-01` (or `2026-11-01T20:00`) as the site shows dates; other values as they are. */
function shownDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function missing(field: FieldFacts): string {
	if (field.type === 'checkbox') return 'Marcá esta casilla para continuar';
	if (field.type === 'file') return 'Elegí un archivo';
	if (field.type === 'radio' || field.type.startsWith('select')) return field.label ? `Elegí una opción en ${field.label}` : 'Elegí una opción';
	return field.label ? `Completá el campo ${field.label}` : 'Completá este campo';
}

function range(field: FieldFacts, bound: 'min' | 'max'): string {
	const value = field[bound] ?? '';
	if (field.type === 'time') return bound === 'min' ? `Elegí una hora desde las ${value}` : `Elegí una hora hasta las ${value}`;
	if (DATE_TYPES.has(field.type)) return bound === 'min' ? `Elegí una fecha desde el ${shownDate(value)}` : `Elegí una fecha hasta el ${shownDate(value)}`;
	return bound === 'min' ? `Ingresá un número mayor o igual a ${value}` : `Ingresá un número menor o igual a ${value}`;
}

/** The Spanish message for the first problem of a refused field. */
export function fieldMessage(validity: ValidityFlags, field: FieldFacts): string {
	if (validity.valueMissing) return missing(field);
	if (validity.badInput) {
		if (field.type === 'number') return 'Ingresá un número';
		if (field.type === 'datetime-local') return 'Completá la fecha y la hora';
		if (field.type === 'time') return 'Ingresá una hora completa';
		if (DATE_TYPES.has(field.type)) return 'Ingresá una fecha completa';
		return 'Revisá este dato';
	}
	if (validity.typeMismatch) {
		if (field.type === 'email') return EMAIL_INVALID;
		if (field.type === 'url') return 'Ingresá una dirección web válida, por ejemplo https://ejemplo.com';
		return 'Revisá el formato de este dato';
	}
	if (validity.patternMismatch) {
		if (field.title) return field.title;
		if (field.hint) return `Revisá el formato: ${field.hint}`;
		return field.label ? `Revisá el formato del campo ${field.label}` : 'Revisá el formato de este dato';
	}
	if (validity.tooShort) return `Escribí al menos ${field.minLength} caracteres (ahora hay ${field.length})`;
	if (validity.tooLong) return `Escribí como máximo ${field.maxLength} caracteres (ahora hay ${field.length})`;
	if (validity.rangeUnderflow) return range(field, 'min');
	if (validity.rangeOverflow) return range(field, 'max');
	if (validity.stepMismatch) {
		const step = Number(field.step ?? 1);
		return step === 1 ? 'Ingresá un número entero' : `Ingresá un múltiplo de ${field.step}`;
	}
	if (validity.customError && field.custom) return field.custom;
	return 'Revisá este dato';
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isControl(target: EventTarget | null): target is Control {
	return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

/** Visible text of an element without the controls inside it, as a short label. */
function textOf(element: Element | null | undefined): string | undefined {
	if (!element) return undefined;
	const copy = element.cloneNode(true) as Element;
	for (const control of copy.querySelectorAll('input, select, textarea, button')) control.remove();
	const text = (copy.textContent ?? '').replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim();
	return text || undefined;
}

/** The radios that share a name share one message. */
function groupOf(field: Control): Control[] {
	if (!(field instanceof HTMLInputElement) || field.type !== 'radio' || !field.name) return [field];
	const scope: ParentNode = field.form ?? field.ownerDocument;
	return [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((radio) => radio.name === field.name && radio.form === field.form);
}

function hintOf(field: Control): string | undefined {
	const doc = field.ownerDocument;
	for (const id of (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
		const element = doc.getElementById(id);
		if (element?.classList.contains('hint')) return textOf(element);
	}
	return textOf(field.closest('.field')?.querySelector('.hint'));
}

function factsOf(field: Control): FieldFacts {
	const radio = field.type === 'radio';
	const label = radio ? textOf(field.closest('fieldset')?.querySelector('legend')) : (textOf(field.labels?.[0]) ?? field.getAttribute('aria-label') ?? undefined);
	const input = field instanceof HTMLInputElement ? field : undefined;
	const lengths = field instanceof HTMLSelectElement ? {} : { minLength: (field as HTMLInputElement).minLength, maxLength: (field as HTMLInputElement).maxLength };
	return {
		type: field.type,
		length: field.value.length,
		label,
		title: field.title || undefined,
		hint: hintOf(field),
		...lengths,
		min: input?.min,
		max: input?.max,
		step: input?.step || undefined,
		custom: field.validity.customError ? field.validationMessage : undefined
	};
}

/** Where the message goes: last in the field block, after a fieldset of radios, or right after a checkbox's label. */
function place(field: Control, message: HTMLElement) {
	if (field.type === 'radio') {
		const fieldset = field.closest('fieldset');
		if (fieldset) return fieldset.after(message);
		const group = groupOf(field);
		const last = group[group.length - 1]!;
		return (last.closest('label') ?? last).after(message);
	}
	if (field.type === 'checkbox') return (field.closest('label') ?? field).after(message);
	const block = field.closest('.field');
	if (block) return block.append(message);
	(field.closest('label') ?? field).after(message);
}

/**
 * Listens once for the whole document and returns the cleanup. Refused fields
 * get the message under them, `aria-invalid` and `aria-describedby`; the first
 * one of a refused submit takes the focus and its message is announced. A
 * message follows what is typed and goes away when the field is right.
 */
export function installFieldValidation(doc: Document): () => void {
	const view = doc.defaultView ?? window;
	const messages = new WeakMap<Control, HTMLElement>();
	const previous = new WeakMap<Control, string | null>();
	let refused: Control[] = [];
	let count = 0;
	let live: HTMLElement | undefined;

	function show(field: Control) {
		const text = fieldMessage(field.validity, factsOf(field));
		let message = messages.get(field);
		if (!message?.isConnected) {
			message = doc.createElement('p');
			message.id = `field-error-${++count}`;
			message.className = 'error field-validation-error';
			place(field, message);
			for (const member of groupOf(field)) {
				messages.set(member, message);
				if (!previous.has(member)) previous.set(member, member.getAttribute('aria-invalid'));
				member.setAttribute('aria-invalid', 'true');
				const ids = (member.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
				member.setAttribute('aria-describedby', [...ids, message.id].join(' '));
			}
		}
		message.textContent = text;
	}

	function clear(field: Control) {
		const message = messages.get(field);
		if (!message) return;
		for (const member of groupOf(field)) {
			if (messages.get(member) !== message) continue;
			messages.delete(member);
			const before = previous.get(member);
			previous.delete(member);
			if (before === null || before === undefined) member.removeAttribute('aria-invalid');
			else member.setAttribute('aria-invalid', before);
			const ids = (member.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== message.id);
			if (ids.length) member.setAttribute('aria-describedby', ids.join(' '));
			else member.removeAttribute('aria-describedby');
		}
		message.remove();
	}

	function announce(text: string) {
		if (!live?.isConnected) {
			live = doc.createElement('div');
			live.className = 'visually-hidden';
			live.setAttribute('aria-live', 'assertive');
			doc.body.append(live);
		}
		// Emptied first, so the same message is read again on a second refused submit.
		live.textContent = '';
		const region = live;
		view.setTimeout(() => (region.textContent = text), 50);
	}

	// The browser fires `invalid` on every refused field of a submit, in page
	// order, within one task; the first of them is focused once all are shown.
	function settle() {
		const first = refused.find((field) => field.isConnected && !field.disabled);
		refused = [];
		if (!first) return;
		first.focus({ preventScroll: true });
		first.scrollIntoView({ block: 'center' });
		announce(messages.get(first)?.textContent ?? '');
	}

	function onInvalid(event: Event) {
		if (!isControl(event.target)) return;
		event.preventDefault();
		show(event.target);
		if (refused.push(event.target) === 1) view.setTimeout(settle);
	}

	function onEdit(event: Event) {
		const field = event.target;
		if (!isControl(field) || !messages.has(field)) return;
		if (field.validity.valid) clear(field);
		else show(field);
	}

	doc.addEventListener('invalid', onInvalid, true);
	doc.addEventListener('input', onEdit, true);
	doc.addEventListener('change', onEdit, true);
	return () => {
		doc.removeEventListener('invalid', onInvalid, true);
		doc.removeEventListener('input', onEdit, true);
		doc.removeEventListener('change', onEdit, true);
		live?.remove();
	};
}
