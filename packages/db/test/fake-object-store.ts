import type { ObjectStore } from '../src/object-store';

/** In-memory bucket with the ObjectStore interface, so file tests need no storage service. */
export function fakeObjectStore(initial: Record<string, Uint8Array> = {}) {
	const objects = new Map(Object.entries(initial));
	const calls: string[] = [];
	const store: ObjectStore = {
		bucket: 'fake-bucket',
		origin: 'https://fake.example.test',
		location: 'fake.example.test/fake-bucket',
		async put(key, bytes, options) {
			calls.push(`put ${key} ${options.contentType}`);
			objects.set(key, new Uint8Array(bytes));
		},
		async putStream(key, chunks, options) {
			const parts: Uint8Array[] = [];
			for await (const chunk of chunks) parts.push(chunk);
			const bytes = Buffer.concat(parts);
			calls.push(`put ${key} ${options.contentType}`);
			objects.set(key, new Uint8Array(bytes));
			return bytes.byteLength;
		},
		async getStream(key) {
			const bytes = objects.get(key);
			if (!bytes) throw Object.assign(new Error(`NoSuchKey ${key}`), { $metadata: { httpStatusCode: 404 } });
			calls.push(`get ${key}`);
			return (async function* () {
				// Two chunks, so readers cannot assume one.
				const half = Math.floor(bytes.byteLength / 2);
				yield bytes.subarray(0, half);
				yield bytes.subarray(half);
			})();
		},
		async exists(key) {
			return objects.has(key);
		},
		async list(prefix) {
			return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
		},
		async remove(keys) {
			calls.push(`remove ${keys.join(',')}`);
			for (const key of keys) objects.delete(key);
		},
		async presignGet(key) {
			return `https://fake.example.test/fake-bucket/${key}`;
		},
		async ensureBucket() {
			return 'exists';
		}
	};
	return { store, objects, calls };
}
