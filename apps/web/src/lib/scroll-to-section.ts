/**
 * Same-page links such as "Ver los productos" glide to their section instead of jumping, and the
 * section fades in softly, so the visitor sees they are still on the same page (owner feedback
 * 2026-11-11b S6). With reduced motion the browser's plain jump stays.
 */
export function scrollToSection(event: MouseEvent) {
	const link = event.currentTarget;
	if (!(link instanceof HTMLAnchorElement) || !link.hash) return;
	const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
	if (!target || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	event.preventDefault();
	target.scrollIntoView({ behavior: 'smooth', block: 'start' });
	target.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' });
	// Keyboard and screen reader users continue from the section they asked for.
	if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
	target.focus({ preventScroll: true });
}
