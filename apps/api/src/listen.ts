/**
 * Listens on `::`, which takes IPv6 and IPv4 alike: Railway's private network
 * (`<service>.railway.internal`) is IPv6, while local tools and other hosts
 * use IPv4. A host without IPv6 refuses `::`, so it falls back to `0.0.0.0`.
 * `API_HOST` names one address instead, used as given. Returns the host.
 */
export async function listenDualStack(app: { listen(options: { port: number; host: string }): Promise<unknown> }, port: number, host?: string): Promise<string> {
	if (host) {
		await app.listen({ port, host });
		return host;
	}
	try {
		await app.listen({ port, host: '::' });
		return '::';
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL') throw error;
		await app.listen({ port, host: '0.0.0.0' });
		return '0.0.0.0';
	}
}
