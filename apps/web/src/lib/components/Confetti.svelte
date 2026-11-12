<script lang="ts">
	import { onDestroy, untrack } from 'svelte';

	/**
	 * A one-shot confetti burst on a canvas, fired each time `burst` changes to
	 * a positive number (`pieces` pieces). Pieces fall and turn slowly: no
	 * flashing, and nothing moves under reduced motion (the page never fires it).
	 */
	let { burst = 0, pieces = 180, colors }: { burst?: number; pieces?: number; colors: string[] } = $props();
	let canvas: HTMLCanvasElement | undefined = $state();
	let frame = 0;

	interface Piece {
		x: number;
		y: number;
		vx: number;
		vy: number;
		size: number;
		angle: number;
		spin: number;
		flip: number;
		color: string;
	}
	let flying: Piece[] = [];
	let last = 0;

	$effect(() => {
		if (burst > 0 && canvas) untrack(() => fire(pieces));
	});

	function fire(count: number) {
		const target = canvas!;
		const ratio = window.devicePixelRatio || 1;
		target.width = target.clientWidth * ratio;
		target.height = target.clientHeight * ratio;
		const width = target.clientWidth;
		const height = target.clientHeight;
		for (let index = 0; index < count; index++) {
			const direction = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
			const speed = 380 + Math.random() * 620;
			flying.push({
				x: width / 2 + (Math.random() - 0.5) * width * 0.2,
				y: height * 0.55,
				vx: Math.cos(direction) * speed,
				vy: Math.sin(direction) * speed,
				size: 7 + Math.random() * 9,
				angle: Math.random() * Math.PI,
				// At most 1.5 turns per second: pieces turn, they never strobe.
				spin: (Math.random() - 0.5) * 3 * Math.PI,
				flip: Math.random() * Math.PI,
				color: colors[index % colors.length]!
			});
		}
		cancelAnimationFrame(frame);
		last = performance.now();
		frame = requestAnimationFrame(step);
	}

	function step(now: number) {
		const target = canvas;
		if (!target) return;
		const context = target.getContext('2d')!;
		const ratio = window.devicePixelRatio || 1;
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		const height = target.clientHeight;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, target.clientWidth, height);
		flying = flying.filter((piece) => piece.y < height + 40);
		for (const piece of flying) {
			piece.vy += 900 * dt;
			piece.vx *= 1 - 1.4 * dt;
			piece.vy *= 1 - 0.9 * dt;
			piece.x += piece.vx * dt;
			piece.y += piece.vy * dt;
			piece.angle += piece.spin * dt;
			piece.flip += piece.spin * 0.5 * dt;
			context.save();
			context.translate(piece.x, piece.y);
			context.rotate(piece.angle);
			context.scale(1, Math.max(0.25, Math.abs(Math.cos(piece.flip))));
			context.fillStyle = piece.color;
			context.fillRect(-piece.size / 2, -piece.size / 3, piece.size, (piece.size * 2) / 3);
			context.restore();
		}
		if (flying.length) frame = requestAnimationFrame(step);
	}

	onDestroy(() => {
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
	});
</script>

<canvas bind:this={canvas} class="confetti" aria-hidden="true"></canvas>

<style>
	.confetti {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
</style>
