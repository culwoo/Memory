import type { AppSettings, AttachmentRecord, JournalEntry } from "../types";

const DB_NAME = "memory-local-db";
const DB_VERSION = 1;
const ENTRY_STORE = "entries";
const ATTACHMENT_STORE = "attachments";
const META_STORE = "meta";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  writingFont: "serif",
  autoSaveEnabled: true,
  aiEnabled: false,
  encryptionEnabled: false,
  syncEnabled: false,
};

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase> | undefined;

export function openMemoryDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(ENTRY_STORE)) {
        const entries = db.createObjectStore(ENTRY_STORE, { keyPath: "id" });
        entries.createIndex("date", "date", { unique: true });
        entries.createIndex("updatedAt", "updatedAt");
        entries.createIndex("mood", "mood");
      }

      if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) {
        const attachments = db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
        attachments.createIndex("entryId", "entryId");
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

export async function getEntries(): Promise<JournalEntry[]> {
  const entries = await getAllEntries();
  return entries.filter((entry) => !entry.deletedAt);
}

export async function getAllEntries(): Promise<JournalEntry[]> {
  const db = await openMemoryDb();
  const tx = db.transaction(ENTRY_STORE, "readonly");
  const entries = await requestToPromise<JournalEntry[]>(tx.objectStore(ENTRY_STORE).getAll());
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

export async function saveEntry(entry: JournalEntry): Promise<void> {
  const db = await openMemoryDb();
  const tx = db.transaction([ENTRY_STORE, META_STORE], "readwrite");
  tx.objectStore(ENTRY_STORE).put(entry);
  tx.objectStore(META_STORE).put({ key: "lastLocalSaveAt", value: entry.updatedAt });
  await txDone(tx);
}

export async function deleteEntry(entry: JournalEntry): Promise<void> {
  const now = new Date().toISOString();
  await saveEntry({ ...entry, deletedAt: now, updatedAt: now, version: entry.version + 1 });
}

export async function saveAttachment(record: AttachmentRecord): Promise<void> {
  const db = await openMemoryDb();
  const tx = db.transaction(ATTACHMENT_STORE, "readwrite");
  tx.objectStore(ATTACHMENT_STORE).put(record);
  await txDone(tx);
}

export async function getAttachmentsForEntry(entryId: string): Promise<AttachmentRecord[]> {
  const db = await openMemoryDb();
  const tx = db.transaction(ATTACHMENT_STORE, "readonly");
  const index = tx.objectStore(ATTACHMENT_STORE).index("entryId");
  return requestToPromise<AttachmentRecord[]>(index.getAll(entryId));
}

export async function getSettings(): Promise<AppSettings> {
  const db = await openMemoryDb();
  const tx = db.transaction(META_STORE, "readonly");
  const result = await requestToPromise<{ key: string; value: AppSettings } | undefined>(
    tx.objectStore(META_STORE).get("settings")
  );
  return { ...DEFAULT_SETTINGS, ...(result?.value ?? {}) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await openMemoryDb();
  const tx = db.transaction(META_STORE, "readwrite");
  tx.objectStore(META_STORE).put({ key: "settings", value: settings });
  await txDone(tx);
}

export async function getMetaValue<T>(key: string): Promise<T | undefined> {
  const db = await openMemoryDb();
  const tx = db.transaction(META_STORE, "readonly");
  const result = await requestToPromise<{ key: string; value: T } | undefined>(
    tx.objectStore(META_STORE).get(key)
  );
  return result?.value;
}

export async function setMetaValue<T>(key: string, value: T): Promise<void> {
  const db = await openMemoryDb();
  const tx = db.transaction(META_STORE, "readwrite");
  tx.objectStore(META_STORE).put({ key, value });
  await txDone(tx);
}
