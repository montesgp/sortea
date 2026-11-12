import { tickTone } from './app-draw';

/**
 * The sound of the in-app draw screen (ADR 0024 §5), generated with the Web
 * Audio API: no audio files. Browsers only start audio after a user gesture,
 * so `createDrawSound` is called from the click on "Sortear" or "Ver la
 * animación". Muting silences the master gain at once.
 */
export interface DrawSound {
	/** A short click as a row crosses the centre; `speed` from 0 to 1. */
	tick(speed: number): void;
	/** A rising tone under the deceleration, `seconds` long. */
	tension(seconds: number): void;
	/** Stops the tension tone (the reel stopped or the screen left). */
	stopTension(): void;
	/** A bright major chord when the reel stops. */
	fanfare(): void;
	setMuted(muted: boolean): void;
	close(): void;
}

export const SOUND_STORAGE_KEY = 'sortea:sorteo-app:sonido';

/** The stored choice: `true` muted, `false` with sound, `null` never chosen. */
export function storedMuted(storage: Pick<Storage, 'getItem'> | undefined): boolean | null {
	const value = storage?.getItem(SOUND_STORAGE_KEY);
	return value === 'off' ? true : value === 'on' ? false : null;
}

export function storeMuted(storage: Pick<Storage, 'setItem'> | undefined, muted: boolean): void {
	try {
		storage?.setItem(SOUND_STORAGE_KEY, muted ? 'off' : 'on');
	} catch {
		// Private mode or full storage: the choice lasts for this page only.
	}
}

export function createDrawSound(muted: boolean): DrawSound | null {
	const Context = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Context) return null;
	const context = new Context();
	void context.resume();
	const master = context.createGain();
	master.gain.value = muted ? 0 : 0.8;
	master.connect(context.destination);
	let lastTick = 0;
	let tension: { oscillator: OscillatorNode; gain: GainNode } | null = null;

	function envelope(gain: GainNode, at: number, peak: number, attack: number, release: number) {
		gain.gain.setValueAtTime(0.0001, at);
		gain.gain.exponentialRampToValueAtTime(peak, at + attack);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + release);
	}

	return {
		tick(speed) {
			const now = context.currentTime;
			// At full speed rows cross faster than ears can split clicks: at most one every 25 ms.
			if (now - lastTick < 0.025) return;
			lastTick = now;
			const tone = tickTone(speed);
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			oscillator.type = 'square';
			oscillator.frequency.value = tone.frequency;
			envelope(gain, now, tone.gain, 0.002, 0.03);
			oscillator.connect(gain).connect(master);
			oscillator.start(now);
			oscillator.stop(now + 0.05);
		},
		tension(seconds) {
			this.stopTension();
			const now = context.currentTime;
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			oscillator.type = 'sawtooth';
			oscillator.frequency.setValueAtTime(110, now);
			oscillator.frequency.exponentialRampToValueAtTime(440, now + seconds);
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(0.07, now + seconds * 0.85);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
			const filter = context.createBiquadFilter();
			filter.type = 'lowpass';
			filter.frequency.setValueAtTime(400, now);
			filter.frequency.exponentialRampToValueAtTime(2400, now + seconds);
			oscillator.connect(filter).connect(gain).connect(master);
			oscillator.start(now);
			oscillator.stop(now + seconds + 0.05);
			tension = { oscillator, gain };
		},
		stopTension() {
			if (!tension) return;
			const now = context.currentTime;
			tension.gain.gain.cancelScheduledValues(now);
			tension.gain.gain.setValueAtTime(Math.max(tension.gain.gain.value, 0.0001), now);
			tension.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
			tension.oscillator.stop(now + 0.1);
			tension = null;
		},
		fanfare() {
			const now = context.currentTime;
			// C major, arpeggiated then held: C5 E5 G5 C6.
			[523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
				const at = now + index * 0.09;
				for (const [type, level] of [
					['triangle', 0.16],
					['square', 0.03]
				] as const) {
					const oscillator = context.createOscillator();
					const gain = context.createGain();
					oscillator.type = type;
					oscillator.frequency.value = frequency;
					envelope(gain, at, level, 0.02, 1.6 - index * 0.09);
					oscillator.connect(gain).connect(master);
					oscillator.start(at);
					oscillator.stop(at + 1.8);
				}
			});
		},
		setMuted(next) {
			master.gain.setTargetAtTime(next ? 0 : 0.8, context.currentTime, 0.01);
		},
		close() {
			void context.close();
		}
	};
}
