import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";

import type { JournalEntry } from "../types";
import { firestoreDb } from "./firebase";

type CloudJournalEntry = Omit<JournalEntry, "activityTags" | "tags" | "attachments"> & {
  activityTags?: string[];
  tags?: string[];
  attachments?: JournalEntry["attachments"];
  syncedAt?: unknown;
};

function entriesCollection(userId: string) {
  if (!firestoreDb) throw new Error("Firestore is not configured.");
  return collection(firestoreDb, "users", userId, "entries");
}

function entryDocument(userId: string, date: string) {
  if (!firestoreDb) throw new Error("Firestore is not configured.");
  return doc(firestoreDb, "users", userId, "entries", date);
}

function tagLibraryDocument(userId: string) {
  if (!firestoreDb) throw new Error("Firestore is not configured.");
  return doc(firestoreDb, "users", userId, "meta", "tagLibrary");
}

function normalizeEntry(data: CloudJournalEntry, fallbackDate: string): JournalEntry {
  return {
    id: data.id || `entry-${fallbackDate}`,
    date: data.date || fallbackDate,
    title: data.title ?? "",
    body: data.body ?? "",
    mood: data.mood,
    activityTags: data.activityTags ?? [],
    tags: data.tags ?? [],
    attachments: data.attachments ?? [],
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    deletedAt: data.deletedAt,
    version: data.version ?? 0,
  };
}

function mergeByDate(localEntries: JournalEntry[], remoteEntries: JournalEntry[]): JournalEntry[] {
  const merged = new Map<string, JournalEntry>();

  for (const entry of localEntries) {
    merged.set(entry.date, entry);
  }

  for (const remote of remoteEntries) {
    const local = merged.get(remote.date);
    if (!local || remote.updatedAt >= local.updatedAt) {
      merged.set(remote.date, { ...remote, id: local?.id ?? remote.id });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.date.localeCompare(a.date));
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

type CloudAttachmentPayload = Partial<JournalEntry["attachments"][number]> & {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
};

type CloudEntryPayload = Partial<Omit<JournalEntry, "attachments">> & {
  attachments: CloudAttachmentPayload[];
};

function serializeEntryForCloud(entry: JournalEntry): CloudEntryPayload {
  const payload = {
    id: entry.id,
    date: entry.date,
    title: entry.title,
    body: entry.body,
    mood: entry.mood,
    activityTags: entry.activityTags,
    tags: entry.tags,
    attachments: entry.attachments.map((attachment) => compactObject({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        thumbnail: attachment.thumbnail,
        storagePath: attachment.storagePath,
        uploadState: attachment.uploadState,
        createdAt: attachment.createdAt,
      }) as CloudAttachmentPayload),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
    version: entry.version,
  };

  return compactObject(payload) as CloudEntryPayload;
}

export async function pushEntryToCloud(userId: string, entry: JournalEntry): Promise<void> {
  await setDoc(
    entryDocument(userId, entry.date),
    {
      ...serializeEntryForCloud(entry),
      syncedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function pushTagLibraryToCloud(userId: string, tags: string[]): Promise<void> {
  await setDoc(
    tagLibraryDocument(userId),
    {
      tags,
      updatedAt: new Date().toISOString(),
      syncedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function syncEntriesWithCloud(userId: string, localEntries: JournalEntry[]): Promise<JournalEntry[]> {
  const snapshot = await getDocs(entriesCollection(userId));
  const remoteEntries = snapshot.docs.map((item) => normalizeEntry(item.data() as CloudJournalEntry, item.id));
  const merged = mergeByDate(localEntries, remoteEntries);
  const remoteByDate = new Map(remoteEntries.map((entry) => [entry.date, entry]));

  await Promise.all(
    localEntries.map((entry) => {
      const remote = remoteByDate.get(entry.date);
      if (remote && remote.updatedAt >= entry.updatedAt) return undefined;
      return pushEntryToCloud(userId, entry);
    })
  );

  return merged;
}

export async function syncTagLibraryWithCloud(userId: string, localTags: string[]): Promise<string[]> {
  const snapshot = await getDocs(collection(firestoreDb!, "users", userId, "meta"));
  const tagDoc = snapshot.docs.find((item) => item.id === "tagLibrary");
  const remoteTags = Array.isArray(tagDoc?.data().tags) ? (tagDoc?.data().tags as string[]) : [];
  const merged = Array.from(new Set([...remoteTags, ...localTags].map((tag) => tag.trim()).filter(Boolean)));

  if (merged.length || localTags.length) {
    await pushTagLibraryToCloud(userId, merged);
  }

  return merged;
}

export function subscribeCloudEntries(
  userId: string,
  onEntries: (entries: JournalEntry[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(entriesCollection(userId), (snapshot) => {
    onEntries(snapshot.docs.map((item) => normalizeEntry(item.data() as CloudJournalEntry, item.id)));
  }, onError);
}

export function subscribeCloudTagLibrary(
  userId: string,
  onTags: (tags: string[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(tagLibraryDocument(userId), (snapshot) => {
    const tags = snapshot.exists() && Array.isArray(snapshot.data().tags) ? (snapshot.data().tags as string[]) : [];
    onTags(tags);
  }, onError);
}

export function mergeEntrySnapshots(localEntries: JournalEntry[], remoteEntries: JournalEntry[]): JournalEntry[] {
  return mergeByDate(localEntries, remoteEntries);
}
