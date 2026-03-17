export type PersistedSessionOperation =
  | {
      kind: 'create-database';
      databaseName: string;
      createdAt: number;
    }
  | {
      kind: 'use-database';
      databaseName: string;
      createdAt: number;
    }
  | {
      kind: 'drop-database';
      databaseName: string;
      createdAt: number;
    }
  | {
      kind: 'sql';
      sql: string;
      repeatCount: number;
      createdAt: number;
    };

type StoredSessionOperation = PersistedSessionOperation & { id?: number };

const DATABASE_NAME = 'sqlcmd-wasm';
const DATABASE_VERSION = 1;
const JOURNAL_STORE_NAME = 'session_journal';

/**
 * IndexedDB-backed append-only journal used to restore session state on reload.
 */
export class PersistenceStore {
  private readonly isSupported = typeof indexedDB !== 'undefined';
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Read all persisted operations in insertion order.
   */
  public async listOperations(): Promise<PersistedSessionOperation[]> {
    if (!this.isSupported) {
      return [];
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(JOURNAL_STORE_NAME, 'readonly');
    const store = transaction.objectStore(JOURNAL_STORE_NAME);
    const records = (await this.requestToPromise(store.getAll())) as StoredSessionOperation[];

    await this.transactionToPromise(transaction);

    return records
      .sort((recordA, recordB) => (recordA.id ?? 0) - (recordB.id ?? 0))
      .map((record) => {
        const { id: _id, ...operation } = record;
        return operation;
      });
  }

  /**
   * Persist one executed operation.
   */
  public async appendOperation(operation: PersistedSessionOperation): Promise<void> {
    if (!this.isSupported) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(JOURNAL_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(JOURNAL_STORE_NAME);

    store.add(operation);

    await this.transactionToPromise(transaction);
  }

  /**
   * Remove all persisted operations.
   */
  public async clearOperations(): Promise<void> {
    if (!this.isSupported) {
      return;
    }

    const db = await this.getDatabase();
    const transaction = db.transaction(JOURNAL_STORE_NAME, 'readwrite');
    transaction.objectStore(JOURNAL_STORE_NAME).clear();
    await this.transactionToPromise(transaction);
  }

  private getDatabase(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(JOURNAL_STORE_NAME)) {
          db.createObjectStore(JOURNAL_STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open IndexedDB database.'));
      };
    });

    return this.dbPromise;
  }

  private requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB request failed.'));
      };
    });
  }

  private transactionToPromise(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onabort = () => {
        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
      };

      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
      };
    });
  }
}
