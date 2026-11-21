// Keeps the files the user opened last in the browser (IndexedDB), so a reload
// brings back the network and the controller program. Everything stays on
// this computer. Storage can be unavailable (private windows, blocked site
// data): then nothing is remembered and nothing breaks.
import type { UploadedProgram } from './transport';

export interface StoredNetwork {
	name: string;
	inpx: string;
	/** the signal program files (.sig) opened with it */
	sigs: string[];
}

export interface StoredController {
	program: UploadedProgram;
	/** was the controller program running when the page was left? */
	active: boolean;
}

const DB = 'trafficSimulation';
const STORE = 'files';

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
	try {
		const db = await open();
		try {
			return await new Promise<T>((resolve, reject) => {
				const request = action(db.transaction(STORE, mode).objectStore(STORE));
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

export const remember = {
	network: (value: StoredNetwork): Promise<unknown> => run('readwrite', (s) => s.put(value, 'network')),
	controller: (value: StoredController): Promise<unknown> => run('readwrite', (s) => s.put(value, 'controller')),
	forgetController: (): Promise<unknown> => run('readwrite', (s) => s.delete('controller'))
};

export const recall = {
	network: (): Promise<StoredNetwork | undefined> => run<StoredNetwork>('readonly', (s) => s.get('network')),
	controller: (): Promise<StoredController | undefined> => run<StoredController>('readonly', (s) => s.get('controller'))
};
