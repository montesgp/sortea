import { buyerSchema } from '@sortea/domain';
import { EMAIL_INVALID, emailValid } from '#lib/email-check.js';

/**
 * The checkout in two steps of one form (S2, S4): step 1 is where the purchase is sent, step 2
 * the last details and the payment. Without JavaScript every field shows in one page; with it the
 * page shows one step at a time, and the step lives in the history entry (SvelteKit shallow
 * routing), so Back and Forward move between the steps without loading the page again.
 */
export type CheckoutStep = 1 | 2;

export const STEP_ONE_FIELDS = ['email', 'firstName', 'lastName'] as const;

/** The buyer field messages, shared by Continuar and the server action. */
export const BUYER_FIELD_MESSAGES: Record<string, string> = {
	documentNumber: 'Ingresá tu número de documento',
	firstName: 'Ingresá tu nombre',
	lastName: 'Ingresá tu apellido',
	email: EMAIL_INVALID,
	country: 'Elegí tu país',
	province: 'Elegí tu provincia',
	city: 'Ingresá tu ciudad'
};

export function stepOfField(name: string): CheckoutStep {
	return (STEP_ONE_FIELDS as readonly string[]).includes(name) ? 1 : 2;
}

type StepOneValues = Partial<Record<(typeof STEP_ONE_FIELDS)[number], string>>;

/** What Continuar checks, with the server's rules and words, in the order of the fields. */
export function stepOneErrors(values: StepOneValues): Record<string, string> {
	const errors: Record<string, string> = {};
	if (!emailValid(values.email ?? '')) errors.email = EMAIL_INVALID;
	if (!buyerSchema.shape.firstName.safeParse(values.firstName ?? '').success) errors.firstName = BUYER_FIELD_MESSAGES.firstName!;
	if (!buyerSchema.shape.lastName.safeParse(values.lastName ?? '').success) errors.lastName = BUYER_FIELD_MESSAGES.lastName!;
	return errors;
}

/**
 * The step the page opens on: a refused submit opens the step that holds a field to fix (step 1
 * first), a refusal without field errors the step with the pay button; a restored draft returns to
 * the step it was in, provided its step 1 is complete.
 */
export function landingStep(input: { errors: Record<string, string>; values: StepOneValues; refused?: boolean; draftStep?: CheckoutStep }): CheckoutStep {
	const fields = Object.keys(input.errors);
	if (fields.length) return fields.some((field) => stepOfField(field) === 1) ? 1 : 2;
	const wanted = input.refused ? 2 : (input.draftStep ?? 1);
	return wanted === 2 && Object.keys(stepOneErrors(input.values)).length === 0 ? 2 : 1;
}

type CheckoutPageState = App.PageState & { checkoutStep?: CheckoutStep };

/** The history entry state of a step, for `pushState`. */
export function stepState(step: CheckoutStep): App.PageState {
	return { checkoutStep: step } as CheckoutPageState;
}

/**
 * The step a history entry shows: the one it was pushed with, or the landing step for the entry the
 * checkout opened on. A legal text opened over the page (its own entry) leaves the step as it is.
 */
export function stepFromState(state: App.PageState, landing: CheckoutStep, current: CheckoutStep): CheckoutStep {
	if (state.legal) return current;
	return (state as CheckoutPageState).checkoutStep ?? landing;
}
