/**
 * Device credentials, persisted in IndexedDB.
 *
 * IndexedDB rather than `localStorage` is not a preference: the service worker
 * has no `localStorage`, and it needs the device token to answer
 * `pushsubscriptionchange` — the browser's only notice that it has rotated a
 * subscription behind your back. Anything stored where the worker cannot read
 * it makes that event unanswerable, and installs then go dark silently.
 */

const DB_NAME = 'poke-me';
const DB_VERSION = 1;
const STORE = 'devices';

/** What the SDK remembers about one app registration on this origin. */
export interface StoredDevice {
  /** Key. The `app_ref` the device was registered against. */
  appRef: string;
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  /**
   * The key the current subscription was created with. The service worker
   * needs it to re-subscribe on `pushsubscriptionchange`, where there is no
   * network call it could make to look it up first.
   */
  vapidPublicKey?: string;
  externalUserId?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'appRef' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export async function loadDevice(appRef: string): Promise<StoredDevice | undefined> {
  const value = await run<StoredDevice | undefined>('readonly', (s) => s.get(appRef));
  return value ?? undefined;
}

/** Every registration on this origin. The service worker has no `appRef` in hand. */
export async function loadAllDevices(): Promise<StoredDevice[]> {
  return run<StoredDevice[]>('readonly', (s) => s.getAll() as IDBRequest<StoredDevice[]>);
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  await run('readwrite', (s) => s.put(device) as IDBRequest<unknown>);
}

export async function patchDevice(
  appRef: string,
  patch: Partial<Omit<StoredDevice, 'appRef'>>,
): Promise<void> {
  const existing = await loadDevice(appRef);
  if (!existing) return;
  await saveDevice({ ...existing, ...patch });
}

export async function deleteDevice(appRef: string): Promise<void> {
  await run('readwrite', (s) => s.delete(appRef) as IDBRequest<unknown>);
}
