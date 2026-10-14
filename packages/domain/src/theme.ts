import { z } from 'zod';

/**
 * Tenant theming (FR-ORG-05, AC-10). Every tenant ships design tokens, never
 * CSS. Tokens are validated (hex colors, allow-listed fonts) so a theme cannot
 * inject styles, and each text/background pair is checked against WCAG AA;
 * failing pairs fall back to the platform default instead of shipping
 * unreadable text.
 */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb color');

export const paletteSchema = z.object({
	bg: hex,
	surface: hex,
	surface2: hex,
	text: hex,
	muted: hex,
	border: hex,
	accent: hex,
	accentText: hex,
	success: hex,
	warning: hex,
	danger: hex
});
export type Palette = z.infer<typeof paletteSchema>;

export const fontFamilies = ['archivo', 'big-shoulders', 'inter-tight', 'system'] as const;
export type FontFamily = (typeof fontFamilies)[number];

export const themeTokensSchema = z.object({
	defaultMode: z.enum(['dark', 'light']),
	dark: paletteSchema,
	light: paletteSchema,
	radius: z.number().int().min(0).max(32),
	fontDisplay: z.enum(fontFamilies),
	fontBody: z.enum(fontFamilies),
	density: z.enum(['comfortable', 'compact'])
});
export type ThemeTokens = z.infer<typeof themeTokensSchema>;

export const themeOverridesSchema = z.object({
	defaultMode: z.enum(['dark', 'light']).optional(),
	dark: paletteSchema.partial().optional(),
	light: paletteSchema.partial().optional(),
	radius: z.number().int().min(0).max(32).optional(),
	fontDisplay: z.enum(fontFamilies).optional(),
	fontBody: z.enum(fontFamilies).optional(),
	density: z.enum(['comfortable', 'compact']).optional()
});
export type ThemeOverrides = z.infer<typeof themeOverridesSchema>;

/** Platform default, taken from docs/spec/DESIGN.md. */
export const platformTheme: ThemeTokens = {
	defaultMode: 'dark',
	dark: {
		bg: '#090B10',
		surface: '#151923',
		surface2: '#1D2330',
		text: '#F5F7FB',
		muted: '#AAB4C5',
		border: '#2A3242',
		accent: '#F04438',
		accentText: '#FFFFFF',
		success: '#25C89A',
		warning: '#F0B449',
		danger: '#FF6B5E'
	},
	light: {
		bg: '#F7F8FA',
		surface: '#FFFFFF',
		surface2: '#EEF1F5',
		text: '#10141C',
		muted: '#4F5B6E',
		border: '#D5DBE4',
		accent: '#C8281C',
		accentText: '#FFFFFF',
		success: '#0F7A5C',
		warning: '#8A5A00',
		danger: '#B42318'
	},
	radius: 16,
	fontDisplay: 'inter-tight',
	fontBody: 'inter-tight',
	density: 'comfortable'
};

export interface ContrastIssue {
	readonly mode: 'dark' | 'light';
	readonly pair: string;
	readonly ratio: number;
	readonly required: number;
}

export interface ResolvedTheme {
	readonly tokens: ThemeTokens;
	readonly issues: readonly ContrastIssue[];
}

const contrastRules: readonly { fg: keyof Palette; bg: keyof Palette; min: number }[] = [
	{ fg: 'text', bg: 'bg', min: 4.5 },
	{ fg: 'text', bg: 'surface', min: 4.5 },
	{ fg: 'muted', bg: 'bg', min: 4.5 },
	{ fg: 'muted', bg: 'surface', min: 4.5 },
	{ fg: 'accentText', bg: 'accent', min: 4.5 },
	{ fg: 'accent', bg: 'bg', min: 3 }
];

export function resolveTheme(overrides: ThemeOverrides | null | undefined, base: ThemeTokens = platformTheme): ResolvedTheme {
	const parsed = themeOverridesSchema.parse(overrides ?? {});
	const issues: ContrastIssue[] = [];
	const resolvePalette = (mode: 'dark' | 'light'): Palette => {
		const palette: Palette = { ...base[mode], ...parsed[mode] };
		for (const rule of contrastRules) {
			const ratio = contrastRatio(palette[rule.fg], palette[rule.bg]);
			if (ratio < rule.min) {
				issues.push({ mode, pair: `${rule.fg}/${rule.bg}`, ratio: round(ratio), required: rule.min });
				palette[rule.fg] = base[mode][rule.fg];
				palette[rule.bg] = base[mode][rule.bg];
			}
		}
		return palette;
	};

	return {
		tokens: {
			defaultMode: parsed.defaultMode ?? base.defaultMode,
			dark: resolvePalette('dark'),
			light: resolvePalette('light'),
			radius: parsed.radius ?? base.radius,
			fontDisplay: parsed.fontDisplay ?? base.fontDisplay,
			fontBody: parsed.fontBody ?? base.fontBody,
			density: parsed.density ?? base.density
		},
		issues
	};
}

export function contrastRatio(foreground: string, background: string): number {
	const a = relativeLuminance(foreground);
	const b = relativeLuminance(background);
	const [lighter, darker] = a > b ? [a, b] : [b, a];
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
	const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
	const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
		number,
		number,
		number
	];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

const fontStacks: Record<FontFamily, string> = {
	archivo: "'Archivo Variable', 'Archivo', system-ui, sans-serif",
	'big-shoulders': "'Big Shoulders Display Variable', 'Big Shoulders Display', 'Arial Narrow', sans-serif",
	'inter-tight': "'Inter Tight Variable', 'Inter Tight', system-ui, sans-serif",
	system: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
};

function paletteToCss(palette: Palette): string {
	return [
		`--bg:${palette.bg}`,
		`--surface:${palette.surface}`,
		`--surface-2:${palette.surface2}`,
		`--text:${palette.text}`,
		`--muted:${palette.muted}`,
		`--border:${palette.border}`,
		`--accent:${palette.accent}`,
		`--accent-text:${palette.accentText}`,
		`--success:${palette.success}`,
		`--warning:${palette.warning}`,
		`--danger:${palette.danger}`
	].join(';');
}

/**
 * Emits the CSS custom properties for a resolved theme. All values were
 * validated by the schema, so they are safe to inline in a <style> tag.
 */
export function themeToCss(tokens: ThemeTokens): string {
	const other = tokens.defaultMode === 'dark' ? 'light' : 'dark';
	const shared = [
		`--radius:${tokens.radius}px`,
		`--radius-sm:${Math.round(tokens.radius / 2)}px`,
		`--font-display:${fontStacks[tokens.fontDisplay]}`,
		`--font-body:${fontStacks[tokens.fontBody]}`,
		`--space-unit:${tokens.density === 'compact' ? 6 : 8}px`
	].join(';');
	return [
		`:root{color-scheme:${tokens.defaultMode};${shared};${paletteToCss(tokens[tokens.defaultMode])}}`,
		`:root[data-mode="${other}"]{color-scheme:${other};${paletteToCss(tokens[other])}}`
	].join('\n');
}
