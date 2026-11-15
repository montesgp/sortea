/**
 * Where a section link scrolls the page: the section at the top, below its scroll margin (the
 * sticky header), unless that leaves the element the section asks to reveal below the screen; then
 * just far enough that it shows whole above a small margin (owner feedback 2026-11-15d S1).
 * Positions are page pixels.
 */
export function sectionScrollTop({
	sectionTop,
	scrollMarginTop,
	revealBottom,
	viewportHeight,
	bottomMargin = 16
}: {
	sectionTop: number;
	scrollMarginTop: number;
	revealBottom: number | null;
	viewportHeight: number;
	bottomMargin?: number;
}): number {
	const top = sectionTop - scrollMarginTop;
	const reveal = revealBottom === null ? top : revealBottom + bottomMargin - viewportHeight;
	return Math.max(0, top, reveal);
}

/**
 * Same-page links such as "Ver los productos" glide to their section instead of jumping, and the
 * section fades in softly, so the visitor sees they are still on the same page (owner feedback
 * 2026-11-11b S6). With reduced motion the browser's plain jump stays.
 *
 * A section may mark one element with `data-reveal` (the shop's first add button): the page then
 * scrolls far enough to show it whole, also with reduced motion (without the glide), and the
 * element gets a `reveal` event, so an invitation next to it can play again (2026-11-15d S1, S2).
 */
export function scrollToSection(event: MouseEvent) {
	const link = event.currentTarget;
	if (!(link instanceof HTMLAnchorElement) || !link.hash) return;
	const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
	if (!target) return;
	const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const reveal = target.querySelector<HTMLElement>('[data-reveal]');
	if (reduced && !reveal) return;
	event.preventDefault();
	const top = sectionScrollTop({
		sectionTop: target.getBoundingClientRect().top + window.scrollY,
		scrollMarginTop: parseFloat(getComputedStyle(target).scrollMarginTop) || 0,
		revealBottom: reveal ? reveal.getBoundingClientRect().bottom + window.scrollY : null,
		viewportHeight: window.innerHeight
	});
	window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
	if (!reduced) target.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' });
	// Keyboard and screen reader users continue from the section they asked for.
	if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
	target.focus({ preventScroll: true });
	reveal?.dispatchEvent(new CustomEvent('reveal', { bubbles: true }));
}
