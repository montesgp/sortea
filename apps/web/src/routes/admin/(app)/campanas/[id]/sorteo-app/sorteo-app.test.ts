import { describe, expect, it } from 'vitest';

// odd/tasks/draw-room.md T5: the old presentation screen of the in-app draw sends every link
// and bookmark to the draw room of the same campaign, where tiradas are run and replayed.
const { load } = await import('./+page.server');

describe('the old in-app draw screen', () => {
	it('redirects to the draw room of the campaign, permanently and for any method', async () => {
		let thrown: unknown;
		try {
			await load({ params: { id: 'c1' } } as never);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ status: 308, location: '/admin/sala-de-sorteo/c1' });
	});
});
