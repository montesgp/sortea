import { describe, expect, it } from 'vitest';
import { sectionScrollTop } from './scroll-to-section.js';

// Owner feedback 2026-11-15d S1: on a phone "Elegir producto y participar" ends with the first
// product's add button on screen, not just the top of the products. Positions are in page pixels.
describe('sectionScrollTop', () => {
	const viewportHeight = 667;

	it('brings the section to the top, below its scroll margin, when nothing has to show', () => {
		expect(sectionScrollTop({ sectionTop: 2000, scrollMarginTop: 80, revealBottom: null, viewportHeight })).toBe(1920);
	});

	it('keeps the section at the top when the element to reveal already fits on that screen', () => {
		expect(sectionScrollTop({ sectionTop: 2000, scrollMarginTop: 80, revealBottom: 1920 + 600, viewportHeight })).toBe(1920);
		// Exactly at the bottom, with its margin.
		expect(sectionScrollTop({ sectionTop: 2000, scrollMarginTop: 80, revealBottom: 1920 + viewportHeight - 16, viewportHeight })).toBe(1920);
	});

	it('scrolls further, just enough to show the element to reveal whole above the bottom margin', () => {
		// Its bottom 120 px below what the section's screen shows: the page goes 136 px (with the margin) further.
		expect(sectionScrollTop({ sectionTop: 2000, scrollMarginTop: 80, revealBottom: 1920 + viewportHeight + 120, viewportHeight })).toBe(1920 + 136);
	});

	it('never scrolls above the top of the page', () => {
		expect(sectionScrollTop({ sectionTop: 30, scrollMarginTop: 80, revealBottom: 400, viewportHeight })).toBe(0);
	});
});
