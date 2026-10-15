import { describe, expect, it } from 'vitest';
import { createCartSync } from './cart-sync';

function deferred() {
	let resolve!: (ok: boolean) => void;
	const promise = new Promise<boolean>((done) => (resolve = done));
	return { promise, resolve };
}

describe('createCartSync', () => {
	it('sends one change at a time and the latest quantity per line wins', async () => {
		const sent: [string, number][] = [];
		const answers: ReturnType<typeof deferred>[] = [];
		let settled = 0;
		const sync = createCartSync({
			send: (variantId, quantity) => {
				sent.push([variantId, quantity]);
				const answer = deferred();
				answers.push(answer);
				return answer.promise;
			},
			settle: async () => {
				settled++;
			}
		});

		sync.set('a', 2);
		await Promise.resolve();
		expect(sent).toEqual([['a', 2]]);
		sync.set('a', 3);
		sync.set('b', 1);
		sync.set('a', 4);
		expect(sync.pending('a')).toBe(true);
		expect(sent).toHaveLength(1);

		answers[0]!.resolve(true);
		await expect.poll(() => sent.length).toBe(2);
		answers[1]!.resolve(true);
		await expect.poll(() => sent.length).toBe(3);
		answers[2]!.resolve(true);
		await sync.idle();

		expect(sent).toEqual([
			['a', 2],
			['a', 4],
			['b', 1]
		]);
		expect(settled).toBe(1);
		expect(sync.pending('a')).toBe(false);
	});

	it('reports a failed change and still settles so the page shows the server state', async () => {
		const failures: string[] = [];
		let settled = 0;
		const sync = createCartSync({
			send: async (variantId) => variantId !== 'bad',
			settle: async () => {
				settled++;
			},
			onError: (variantId) => failures.push(variantId)
		});
		sync.set('bad', 1);
		sync.set('good', 1);
		await sync.idle();
		expect(failures).toEqual(['bad']);
		expect(settled).toBe(1);
	});

	it('keeps accepting changes after a refresh fails', async () => {
		const sent: number[] = [];
		let fail = true;
		const sync = createCartSync({
			send: async (_variantId, quantity) => {
				sent.push(quantity);
				return true;
			},
			settle: async () => {
				if (fail) {
					fail = false;
					throw new Error('offline');
				}
			}
		});
		sync.set('a', 1);
		await sync.idle();
		sync.set('a', 2);
		await sync.idle();
		expect(sent).toEqual([1, 2]);
	});

	it('runs changes that arrive while settling before going idle', async () => {
		const sent: number[] = [];
		let settled = 0;
		const sync = createCartSync({
			send: async (_variantId, quantity) => {
				sent.push(quantity);
				return true;
			},
			settle: async () => {
				settled++;
				if (settled === 1) sync.set('a', 9);
			}
		});
		sync.set('a', 1);
		await sync.idle();
		expect(sent).toEqual([1, 9]);
		expect(settled).toBe(2);
	});
});
