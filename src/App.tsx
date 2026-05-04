import {
  Angry,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Frown,
  Heart,
  ImagePlus,
  Info,
  Laugh,
  Meh,
  Moon,
  PartyPopper,
  Plus,
  Search,
  SlidersHorizontal,
  Smile,
  Sun,
  Target,
  Trash2,
  X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  formatKoreanDate,
  formatShortDate,
  getCalendarDays,
  isSameMonth,
  monthTitle,
  shiftMonth,
  todayKey,
} from "./lib/date";
import {
  clearLocalJournalData,
  getAllEntries,
  getMetaValue,
  getSettings,
  deleteAttachmentsForEntry,
  saveAttachment,
  saveEntry,
  saveSettings,
  setMetaValue,
} from "./lib/storage";
import {
  mergeEntrySnapshots,
  pushEntryToCloud,
  pushTagLibraryToCloud,
  subscribeCloudEntries,
  subscribeCloudTagLibrary,
  syncEntriesWithCloud,
  syncTagLibraryWithCloud,
} from "./lib/cloudSync";
import { deleteAttachmentFiles, uploadAttachmentFile } from "./lib/cloudStorage";
import {
  completeRedirectSignIn,
  isFirebaseConfigured,
  signInWithGoogle,
  signOutFromGoogle,
  subscribeAuth,
} from "./lib/firebase";
import type { AppSettings, AttachmentMeta, AttachmentRecord, JournalEntry, MoodId, SaveState } from "./types";
import type { User } from "firebase/auth";

type PrimaryViewId = "today" | "calendar" | "search";
type ViewId = PrimaryViewId | "profile";

interface MoodOption {
  id: MoodId;
  label: string;
  tone: string;
  icon: typeof Smile;
}

const MOODS: MoodOption[] = [
  { id: "clear", label: "맑음", tone: "mood-clear", icon: Smile },
  { id: "good", label: "좋음", tone: "mood-good", icon: Laugh },
  { id: "excited", label: "신남", tone: "mood-excited", icon: PartyPopper },
  { id: "warm", label: "따뜻함", tone: "mood-warm", icon: Heart },
  { id: "focused", label: "집중", tone: "mood-focused", icon: Target },
  { id: "quiet", label: "고요", tone: "mood-quiet", icon: Cloud },
  { id: "tired", label: "피곤", tone: "mood-tired", icon: Meh },
  { id: "heavy", label: "무거움", tone: "mood-heavy", icon: Frown },
  { id: "angry", label: "날카로움", tone: "mood-angry", icon: Angry },
];

const NAV_ITEMS: Array<{ id: PrimaryViewId; icon: typeof BookOpen }> = [
  { id: "today", icon: BookOpen },
  { id: "calendar", icon: CalendarDays },
  { id: "search", icon: Search },
];

const DRAFT_SHADOW_KEY = "memory-draft-shadow-v1";

interface DraftShadow {
  userId: string;
  entry: JournalEntry;
  savedAt: string;
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

function createEmptyEntry(date: string): JournalEntry {
  const now = new Date().toISOString();
  return {
    id: createId("entry"),
    date,
    title: "",
    body: "",
    activityTags: [],
    tags: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function hasEntryContent(entry: JournalEntry): boolean {
  return Boolean(
    entry.title.trim() ||
      entry.body.trim() ||
      entry.mood ||
      entry.activityTags.length ||
      entry.tags.length ||
      entry.attachments.length
  );
}

function sortEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.slice().sort((a, b) => b.date.localeCompare(a.date));
}

function parseTagInput(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 12);
}

function uniqueTags(values: string[]): string[] {
  return Array.from(new Set(values.map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))).slice(0, 60);
}

function readDraftShadow(userId: string): DraftShadow | null {
  try {
    const raw = localStorage.getItem(DRAFT_SHADOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftShadow;
    if (parsed.userId !== userId || !parsed.entry || !hasEntryContent(parsed.entry)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDraftShadow(userId: string | undefined, entry: JournalEntry): void {
  if (!userId) return;

  try {
    if (!hasEntryContent(entry)) {
      clearDraftShadow(userId, entry.id);
      return;
    }

    const savedAt = new Date().toISOString();
    const payload: DraftShadow = {
        userId,
        savedAt,
        entry: {
          ...entry,
          updatedAt: savedAt,
        },
      };

    try {
      localStorage.setItem(DRAFT_SHADOW_KEY, JSON.stringify(payload));
    } catch {
      localStorage.setItem(
        DRAFT_SHADOW_KEY,
        JSON.stringify({
          ...payload,
          entry: {
            ...payload.entry,
            attachments: payload.entry.attachments.map((attachment) => ({
              ...attachment,
              thumbnail: undefined,
            })),
          },
        } satisfies DraftShadow)
      );
    }
  } catch {
    // IndexedDB autosave still runs; this shadow only protects abrupt reloads.
  }
}

function clearDraftShadow(userId?: string, entryId?: string): void {
  try {
    const raw = localStorage.getItem(DRAFT_SHADOW_KEY);
    if (!raw) return;
    if (!userId && !entryId) {
      localStorage.removeItem(DRAFT_SHADOW_KEY);
      return;
    }

    const parsed = JSON.parse(raw) as DraftShadow;
    if ((!userId || parsed.userId === userId) && (!entryId || parsed.entry?.id === entryId)) {
      localStorage.removeItem(DRAFT_SHADOW_KEY);
    }
  } catch {
    localStorage.removeItem(DRAFT_SHADOW_KEY);
  }
}

function syncErrorMessage(error: unknown): string {
  if (error == null) {
    return "작업을 완료하지 못했습니다. 로컬 저장소 또는 네트워크 상태를 확인하세요.";
  }

  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = typeof error === "object" && error && "message" in error ? String(error.message) : "";

  if (code.includes("permission-denied")) {
    return "Firestore 권한이 거부됐습니다. Firestore Rules가 게시됐는지 확인하세요. 현재 규칙은 users/{uid} 아래만 허용해야 합니다.";
  }

  if (code.includes("unavailable")) {
    return "Firestore 서버에 연결하지 못했습니다. 네트워크 상태를 확인하면 자동으로 다시 시도됩니다.";
  }

  if (code.includes("unauthenticated")) {
    return "Google 로그인 세션을 확인하지 못했습니다. 다시 로그인해 주세요.";
  }

  if (code.includes("failed-precondition")) {
    return "Firestore 설정이 완료되지 않았습니다. 데이터베이스 생성 상태와 Rules 게시 상태를 확인하세요.";
  }

  if (code.includes("storage/unauthorized")) {
    return "사진 저장소 권한이 거부됐습니다. Firebase Storage Rules가 users/{uid} 아래만 허용하도록 게시됐는지 확인하세요.";
  }

  if (code.includes("storage/bucket-not-found")) {
    return "Firebase Storage 버킷을 찾지 못했습니다. Firebase 콘솔에서 Storage가 생성됐는지 확인하세요.";
  }

  if (code.includes("storage/")) {
    return `사진 동기화 실패 (${code})${message ? `: ${message}` : ""}`;
  }

  if (message.includes("Firebase Storage")) {
    return `사진 동기화 실패: ${message}`;
  }

  return `Firestore 동기화 실패${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
}

function authErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = typeof error === "object" && error && "message" in error ? String(error.message) : "";

  if (code.includes("unauthorized-domain")) {
    return "현재 배포 도메인이 Firebase Auth 승인 도메인에 없습니다. Firebase Authentication 설정에서 memory-two-steel.vercel.app을 추가하세요.";
  }

  if (code.includes("operation-not-allowed")) {
    return "Google 로그인 제공업체가 꺼져 있습니다. Firebase Authentication의 로그인 방법에서 Google을 활성화하세요.";
  }

  if (code.includes("popup-closed-by-user") || code.includes("cancelled-popup-request")) {
    return "Google 로그인 창이 닫혔습니다. 다시 시도해 주세요.";
  }

  if (code.includes("network-request-failed")) {
    return "네트워크 문제로 Google 로그인을 시작하지 못했습니다.";
  }

  return `Google 로그인을 시작하지 못했습니다${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
}

async function makeThumbnail(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/")) return undefined;

  try {
    const bitmap = await createImageBitmap(file);
    const maxSize = 360;
    const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    context?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(file);
    });
  }
}

function App() {
  const [view, setView] = useState<ViewId>("today");
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [draft, setDraft] = useState<JournalEntry>(() => createEmptyEntry(todayKey()));
  const [currentDate, setCurrentDate] = useState(todayKey());
  const [, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(false);
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [authReady, setAuthReady] = useState(!isFirebaseConfigured);
  const [syncUser, setSyncUser] = useState<User | null>(null);
  const [syncError, setSyncError] = useState<string | null>(() =>
    isFirebaseConfigured ? null : "Firebase 설정이 필요합니다."
  );
  const [settings, setSettingsState] = useState<AppSettings>({
    theme: "light",
    writingFont: "serif",
    autoSaveEnabled: true,
    aiEnabled: false,
    encryptionEnabled: false,
    syncEnabled: false,
  });
  const [tagLibrary, setTagLibrary] = useState<string[]>([]);
  const draftRef = useRef(draft);
  const currentDateRef = useRef(currentDate);
  const dirtyRef = useRef(dirty);
  const syncUserRef = useRef<User | null>(syncUser);
  const tagLibraryRef = useRef<string[]>(tagLibrary);

  const entryByDate = useMemo(() => new Map(entries.map((entry) => [entry.date, entry])), [entries]);
  const activeMood = MOODS.find((mood) => mood.id === draft.mood);

  const resetVisibleJournal = useCallback((date: string = todayKey()) => {
    const emptyEntry = createEmptyEntry(date);
    setEntries([]);
    setTagLibrary([]);
    setCurrentDate(date);
    draftRef.current = emptyEntry;
    setDraft(emptyEntry);
    setDirty(false);
    setSaveState("idle");
  }, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    currentDateRef.current = currentDate;
  }, [currentDate]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    syncUserRef.current = syncUser;
  }, [syncUser]);

  useEffect(() => {
    tagLibraryRef.current = tagLibrary;
  }, [tagLibrary]);

  const updateSettings = useCallback((next: Partial<AppSettings>) => {
    setSettingsState((previous) => {
      const merged = { ...previous, ...next };
      void saveSettings(merged);
      document.documentElement.dataset.theme = merged.theme;
      return merged;
    });
  }, []);


  const flushDraftToEntries = useCallback(() => {
    const current = draftRef.current;
    if (!hasEntryContent(current)) return;
    const now = new Date().toISOString();
    const flushed: JournalEntry = {
      ...current,
      updatedAt: now,
      version: current.version + 1,
    };
    draftRef.current = flushed;
    setDraft(flushed);
    setEntries((previous) => {
      const withoutCurrent = previous.filter(
        (item) => item.id !== flushed.id && item.date !== flushed.date
      );
      return sortEntries([flushed, ...withoutCurrent]);
    });
    setDirty(false);
    setSaveState("saved");
    void saveEntry(flushed).then(() => {
      clearDraftShadow(syncUserRef.current?.uid, flushed.id);
    });
    if (syncUserRef.current) {
      void pushEntryToCloud(syncUserRef.current.uid, flushed).catch((error) => {
        setSyncError(syncErrorMessage(error));
      });
    }
  }, []);

  const commitDraft = useCallback((updater: (entry: JournalEntry) => JournalEntry): JournalEntry => {
    const nextDraft = updater(draftRef.current);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    setSaveState("dirty");
    writeDraftShadow(syncUserRef.current?.uid, nextDraft);
    return nextDraft;
  }, []);

  const updateDraft = useCallback((updater: (entry: JournalEntry) => JournalEntry) => {
    commitDraft(updater);
  }, [commitDraft]);

  const persistDraft = useCallback(
    async (entry?: JournalEntry) => {
      const sourceEntry = entry ?? draftRef.current;
      if (!hasEntryContent(sourceEntry)) {
        setSaveState("idle");
        return;
      }

      setSaveState("saving");
      const now = new Date().toISOString();
      const nextEntry: JournalEntry = {
        ...sourceEntry,
        updatedAt: now,
        version: sourceEntry.version + 1,
      };

      try {
        await saveEntry(nextEntry);
        clearDraftShadow(syncUserRef.current?.uid, nextEntry.id);
        draftRef.current = nextEntry;
        setDraft(nextEntry);
        setEntries((previous) => {
          const withoutCurrent = previous.filter((item) => item.id !== nextEntry.id && item.date !== nextEntry.date);
          return sortEntries([nextEntry, ...withoutCurrent]);
        });
        setDirty(false);
        setSaveState("saved");
        if (syncUserRef.current) {
          void pushEntryToCloud(syncUserRef.current.uid, nextEntry).catch((error) => {
            setSyncError(syncErrorMessage(error));
          });
        }
      } catch {
        setSaveState("error");
      }
    },
    []
  );

  const loadDraftForDate = useCallback(
    (date: string, nextView: ViewId = "today") => {
      if (draftRef.current.date === date) {
        if (dirtyRef.current) flushDraftToEntries();
        setView(nextView);
        return;
      }

      if (dirtyRef.current) {
        flushDraftToEntries();
      }

      const existing = entryByDate.get(date);
      setCurrentDate(date);
      const nextDraft = existing ?? createEmptyEntry(date);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setDirty(false);
      setSaveState(existing ? "saved" : "idle");
      setView(nextView);
    },
    [entryByDate, flushDraftToEntries]
  );

  const handleViewChange = useCallback(
    (nextView: ViewId) => {
      if (view === "today" && nextView !== "today" && dirtyRef.current) {
        flushDraftToEntries();
      }
      setView(nextView);
    },
    [view, flushDraftToEntries]
  );

  useEffect(() => {
    let active = true;

    getSettings().then((storedSettings) => {
      if (!active) return;
      setSettingsState(storedSettings);
      document.documentElement.dataset.theme = storedSettings.theme;
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;

    let active = true;
    let unsubscribe: () => void = () => undefined;

    async function startAuth() {
      try {
        await completeRedirectSignIn();
      } catch (error) {
        if (active) setSyncError(authErrorMessage(error));
      }

      if (!active) return;

      unsubscribe = subscribeAuth((user) => {
        if ((syncUserRef.current?.uid ?? null) !== (user?.uid ?? null)) {
          const shadow = user ? readDraftShadow(user.uid) : null;
          if (shadow) {
            setEntries([]);
            setTagLibrary([]);
            setCurrentDate(shadow.entry.date);
            draftRef.current = shadow.entry;
            setDraft(shadow.entry);
            setDirty(true);
            setSaveState("dirty");
          } else {
            resetVisibleJournal();
          }
        }
        setSyncUser(user);
        setAuthReady(true);
        if (user) setSyncError(null);
      });
    }

    void startAuth();

    return () => {
      active = false;
      unsubscribe();
    };
  }, [resetVisibleJournal]);

  useEffect(() => {
    if (!syncUser) return undefined;

    const userId = syncUser.uid;
    let active = true;
    let unsubscribeEntries: (() => void) | undefined;
    let unsubscribeTags: (() => void) | undefined;

    async function startSync() {
      try {
        let [localEntries, storedTagLibrary] = await Promise.all([
          getAllEntries(),
          getMetaValue<string[]>("tagLibrary"),
        ]);
        const lastSyncUserId = await getMetaValue<string>("lastSyncUserId");
        if (lastSyncUserId && lastSyncUserId !== userId) {
          await clearLocalJournalData();
          clearDraftShadow(lastSyncUserId);
          if (!active) return;
          localEntries = [];
          storedTagLibrary = [];
          resetVisibleJournal(currentDateRef.current);
        }
        await setMetaValue("lastSyncUserId", userId);

        const shadow = readDraftShadow(userId);
        if (shadow) {
          const shadowEntry: JournalEntry = {
            ...shadow.entry,
            updatedAt: shadow.savedAt,
            version: shadow.entry.version + 1,
          };
          const withoutShadowDate = localEntries.filter((entry) => entry.date !== shadowEntry.date);
          localEntries = sortEntries([shadowEntry, ...withoutShadowDate]);
          await saveEntry(shadowEntry);
          if (!active) return;
          setCurrentDate(shadowEntry.date);
          draftRef.current = shadowEntry;
          setDraft(shadowEntry);
          setDirty(true);
          setSaveState("dirty");
        }

        const mergedEntries = await syncEntriesWithCloud(userId, localEntries);
        if (!active) return;

        await Promise.all(mergedEntries.map((entry) => saveEntry(entry)));
        const visibleEntries = sortEntries(mergedEntries.filter((entry) => !entry.deletedAt));
        setEntries(visibleEntries);
        setDraft((previous) => {
          if (dirtyRef.current) return previous;
          const nextDraft = visibleEntries.find((entry) => entry.date === currentDateRef.current) ?? previous;
          draftRef.current = nextDraft;
          return nextDraft;
        });

        const localTags = uniqueTags([
          ...(storedTagLibrary ?? []),
          ...visibleEntries.flatMap((entry) => [...entry.tags, ...entry.activityTags]),
        ]);
        const mergedTags = await syncTagLibraryWithCloud(userId, localTags);
        if (!active) return;

        const normalizedTags = uniqueTags(mergedTags);
        setTagLibrary(normalizedTags);
        void setMetaValue("tagLibrary", normalizedTags);

        unsubscribeEntries = subscribeCloudEntries(
          userId,
          async (remoteEntries) => {
            const latestLocalEntries = await getAllEntries();
            const merged = mergeEntrySnapshots(latestLocalEntries, remoteEntries);
            await Promise.all(merged.map((entry) => saveEntry(entry)));
            if (!active) return;

            const nextVisibleEntries = sortEntries(merged.filter((entry) => !entry.deletedAt));

            // Protect the current draft: if it has content that isn't yet
            // reflected in the merged result, inject it so the calendar
            // and search views never lose a locally-written entry.
            const currentDraft = draftRef.current;
            if (hasEntryContent(currentDraft)) {
              const alreadyIncluded = nextVisibleEntries.some(
                (e) => e.date === currentDraft.date && e.updatedAt >= currentDraft.updatedAt
              );
              if (!alreadyIncluded) {
                const withoutDraftDate = nextVisibleEntries.filter((e) => e.date !== currentDraft.date);
                setEntries(sortEntries([currentDraft, ...withoutDraftDate]));
              } else {
                setEntries(nextVisibleEntries);
              }
            } else {
              setEntries(nextVisibleEntries);
            }

            setDraft((previous) => {
              if (dirtyRef.current) return previous;
              const nextDraft = nextVisibleEntries.find((entry) => entry.date === currentDateRef.current) ?? previous;
              draftRef.current = nextDraft;
              return nextDraft;
            });
          },
          (error) => setSyncError(syncErrorMessage(error))
        );

        unsubscribeTags = subscribeCloudTagLibrary(
          userId,
          (remoteTags) => {
            const merged = uniqueTags([...tagLibraryRef.current, ...remoteTags]);
            setTagLibrary(merged);
            void setMetaValue("tagLibrary", merged);
          },
          (error) => setSyncError(syncErrorMessage(error))
        );
      } catch (error) {
        if (active) {
          setSyncError(syncErrorMessage(error));
        }
      }
    }

    void startSync();

    return () => {
      active = false;
      unsubscribeEntries?.();
      unsubscribeTags?.();
    };
  }, [resetVisibleJournal, syncUser]);

  useEffect(() => {
    if (!dirty || !settings.autoSaveEnabled) return undefined;
    const timer = window.setTimeout(() => {
      void persistDraft();
    }, 650);

    return () => window.clearTimeout(timer);
  }, [dirty, draft, persistDraft, settings.autoSaveEnabled]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void persistDraft();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        handleViewChange("search");
        window.setTimeout(() => document.getElementById("search-input")?.focus(), 0);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [persistDraft, handleViewChange]);

  const searchResults = useMemo(() => {
    const hasTextQuery = !!debouncedQuery;
    const hasTagFilter = filterTags.length > 0;
    const hasAnyFilter = hasTextQuery || hasTagFilter;

    if (!hasAnyFilter) return entries.slice(0, 20);

    return entries.filter((entry) => {
      if (hasTextQuery) {
        const haystack = [
          entry.title,
          entry.body,
          entry.date,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(debouncedQuery)) return false;
      }
      if (hasTagFilter) {
        const entryTags = [...entry.tags, ...entry.activityTags];
        if (!filterTags.some((tag) => entryTags.includes(tag))) return false;
      }
      return true;
    });
  }, [debouncedQuery, entries, filterTags]);

  const calendarDays = useMemo(() => getCalendarDays(monthCursor), [monthCursor]);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;

    for (const file of Array.from(files).slice(0, 6)) {
      const user = syncUserRef.current;
      const id = createId("attachment");
      const thumbnail = await makeThumbnail(file);
      const createdAt = new Date().toISOString();
      const meta: AttachmentMeta = {
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        thumbnail,
        uploadState: user ? "uploading" : "local",
        createdAt,
      };
      const record: AttachmentRecord = {
        ...meta,
        entryId: draftRef.current.id,
        blob: file,
      };
      await saveAttachment(record);
      const entryWithAttachment = commitDraft((entry) => ({ ...entry, attachments: [...entry.attachments, meta] }));

      if (!user) continue;

      try {
        const storagePath = await uploadAttachmentFile(user.uid, entryWithAttachment.date, id, file);
        if (draftRef.current.id !== entryWithAttachment.id) {
          await deleteAttachmentFiles([{ ...meta, storagePath, uploadState: "uploaded" }]);
          continue;
        }

        const uploadedEntry = commitDraft((entry) => ({
          ...entry,
          attachments: entry.attachments.map((attachment) =>
            attachment.id === id ? { ...attachment, storagePath, uploadState: "uploaded" } : attachment
          ),
        }));
        void persistDraft(uploadedEntry);
      } catch (error) {
        if (draftRef.current.id === entryWithAttachment.id) {
          commitDraft((entry) => ({
            ...entry,
            attachments: entry.attachments.map((attachment) =>
              attachment.id === id ? { ...attachment, uploadState: "failed" } : attachment
            ),
          }));
        }
        setSyncError(syncErrorMessage(error));
      }
    }
  }

  function persistTagLibrary(nextTags: string[]) {
    const normalized = uniqueTags(nextTags);
    setTagLibrary(normalized);
    void setMetaValue("tagLibrary", normalized);
    if (syncUserRef.current) {
      void pushTagLibraryToCloud(syncUserRef.current.uid, normalized).catch((error) => {
        setSyncError(syncErrorMessage(error));
      });
    }
  }

  function handleAddTag(value: string) {
    const [tag] = parseTagInput(value);
    if (!tag) return;
    const nextLibrary = uniqueTags([...tagLibrary, tag]);
    persistTagLibrary(nextLibrary);
    updateDraft((entry) => ({
      ...entry,
      tags: entry.tags.includes(tag) ? entry.tags : [...entry.tags, tag],
    }));
  }

  function handleToggleTag(tag: string) {
    updateDraft((entry) => ({
      ...entry,
      tags: entry.tags.includes(tag) ? entry.tags.filter((item) => item !== tag) : [...entry.tags, tag],
    }));
  }

  function handleDeleteTag(tag: string) {
    persistTagLibrary(tagLibrary.filter((item) => item !== tag));
    updateDraft((entry) => ({ ...entry, tags: entry.tags.filter((item) => item !== tag) }));
  }

  async function handleDeleteCurrent() {
    const entryToDelete = draftRef.current;
    if (!hasEntryContent(entryToDelete)) return;
    const now = new Date().toISOString();
    const deletedEntry: JournalEntry = {
      ...entryToDelete,
      deletedAt: now,
      updatedAt: now,
      version: entryToDelete.version + 1,
    };
    await saveEntry(deletedEntry);

    const user = syncUserRef.current;
    let cloudDeleteSynced = false;
    if (user) {
      try {
        await pushEntryToCloud(user.uid, deletedEntry);
        cloudDeleteSynced = true;
      } catch (error) {
        setSyncError(syncErrorMessage(error));
      }
    }

    if (user && cloudDeleteSynced && entryToDelete.attachments.length > 0) {
      try {
        await deleteAttachmentFiles(entryToDelete.attachments);
      } catch (error) {
        setSyncError(syncErrorMessage(error));
      }
    }

    await deleteAttachmentsForEntry(entryToDelete.id);
    setEntries((previous) => previous.filter((entry) => entry.id !== entryToDelete.id));
    const emptyEntry = createEmptyEntry(currentDate);
    draftRef.current = emptyEntry;
    setDraft(emptyEntry);
    setDirty(false);
    setSaveState("idle");
  }

  async function handleConfirmDeleteCurrent() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      await handleDeleteCurrent();
      setDeleteConfirmOpen(false);
    } catch (error) {
      setSyncError(syncErrorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  const content = {
    today: (
      <TodayView
        draft={draft}
        activeMood={activeMood}
        currentDate={currentDate}
        canDelete={hasEntryContent(draft)}
        tagLibrary={tagLibrary}
        onDraftChange={updateDraft}
        onFiles={handleFiles}
        onAddTag={handleAddTag}
        onToggleTag={handleToggleTag}
        onDeleteTag={handleDeleteTag}
        onDelete={() => setDeleteConfirmOpen(true)}
      />
    ),
    calendar: (
      <CalendarView
        monthCursor={monthCursor}
        days={calendarDays}
        entryByDate={entryByDate}
        onShiftMonth={(delta) => setMonthCursor((current) => shiftMonth(current, delta))}
        onSelectDate={(date) => loadDraftForDate(date)}
      />
    ),
    search: (
      <SearchView
        query={query}
        results={searchResults}
        allTags={tagLibrary}
        filterTags={filterTags}
        onQueryChange={setQuery}
        onToggleTagFilter={(tag) => setFilterTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
        onSelectEntry={(entry) => loadDraftForDate(entry.date)}
      />
    ),
    profile: (
      <ProfileView
        user={syncUser}
        entryCount={entries.length}
        tagCount={tagLibrary.length}
        syncError={syncError}
        onSignOut={() => void signOutFromGoogle()}
      />
    ),
  } satisfies Record<ViewId, ReactElement>;

  async function handleGoogleSignIn() {
    try {
      setSyncError(null);
      await signInWithGoogle();
    } catch (error) {
      setSyncError(authErrorMessage(error));
    }
  }

  if (!authReady) {
    return <AuthLoadingScreen />;
  }

  if (!syncUser) {
    return (
      <LoginScreen
        mode={isFirebaseConfigured ? "ready" : "missing-config"}
        error={syncError}
        onSignIn={() => void handleGoogleSignIn()}
      />
    );
  }

  return (
    <div className={`app-shell font-${settings.writingFont}`}>
      <aside className="sidebar">
        <nav className="nav-list" aria-label="주요 화면">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-button ${view === item.id ? "is-active" : ""}`}
              type="button"
              onClick={() => handleViewChange(item.id)}
              aria-label={item.id}
            >
              <item.icon aria-hidden="true" />
            </button>
          ))}
        </nav>

        <button
          className={`account-button ${view === "profile" ? "is-active" : ""}`}
          type="button"
          onClick={() => handleViewChange("profile")}
          aria-label="나의 페이지"
          title={syncUser.email ?? "나의 페이지"}
        >
          {syncUser.photoURL ? <img src={syncUser.photoURL} alt="" /> : <Cloud aria-hidden="true" />}
        </button>

        <button
          className="theme-toggle"
          type="button"
          onClick={() => updateSettings({ theme: settings.theme === "light" ? "dark" : "light" })}
          aria-label="테마 전환"
        >
          {settings.theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
        </button>
      </aside>

      <main className="main-panel">{content[view]}</main>

      {deleteConfirmOpen ? (
        <DeleteEntryDialog
          date={currentDate}
          isBusy={deleteBusy}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={() => void handleConfirmDeleteCurrent()}
        />
      ) : null}

      <MobileAccountButton
        user={syncUser}
        isProfileActive={view === "profile"}
        onClick={() => handleViewChange("profile")}
      />
      <MobileThemeButton
        theme={settings.theme}
        onClick={() => updateSettings({ theme: settings.theme === "light" ? "dark" : "light" })}
      />
      <MobileNav current={view} onChange={handleViewChange} />
    </div>
  );
}

function LoginScreen({
  mode,
  error,
  onSignIn,
}: {
  mode: "loading" | "ready" | "missing-config";
  error?: string | null;
  onSignIn?: () => void;
}) {
  return (
    <main className="login-shell">
      <section className="login-card" aria-label="Memory 로그인">
        <div className="login-mark">
          <BookOpen aria-hidden="true" />
        </div>
        <div>
          <h1>Memory</h1>
          <p>노트북에서 쓰고, 모바일에서 바로 이어보세요.</p>
        </div>
        {mode === "loading" ? (
          <span className="login-muted">로그인 상태를 확인하는 중입니다.</span>
        ) : (
          <button
            className="google-button"
            type="button"
            onClick={onSignIn}
            disabled={mode === "missing-config"}
          >
            <Cloud aria-hidden="true" />
            <span>Google로 계속하기</span>
          </button>
        )}
        {mode === "missing-config" ? (
          <span className="login-error">Firebase 환경변수가 설정되지 않았습니다.</span>
        ) : null}
        {error ? <span className="login-error">{error}</span> : null}
      </section>
    </main>
  );
}

function AuthLoadingScreen() {
  return (
    <main className="auth-loading-shell" aria-label="로그인 상태 확인">
      <div className="auth-loading-mark">
        <BookOpen aria-hidden="true" />
      </div>
    </main>
  );
}

function DeleteEntryDialog({
  date,
  isBusy,
  onCancel,
  onConfirm,
}: {
  date: string;
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isBusy) onCancel();
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [isBusy, onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => !isBusy && onCancel()}>
      <div
        className="delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="delete-dialog-mark">
          <Trash2 aria-hidden="true" />
        </div>
        <h2 id="delete-dialog-title">이 일기를 삭제할까요?</h2>
        <p id="delete-dialog-description">
          {formatKoreanDate(date)} 기록은 이 기기와 동기화된 기기에서 보이지 않아요.
        </p>
        <div className="delete-dialog-actions">
          <button className="dialog-action secondary" type="button" onClick={onCancel} disabled={isBusy}>
            취소
          </button>
          <button className="dialog-action danger" type="button" onClick={onConfirm} disabled={isBusy}>
            <Trash2 aria-hidden="true" />
            {isBusy ? "삭제 중" : "삭제"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileView({
  user,
  entryCount,
  tagCount,
  syncError,
  onSignOut,
}: {
  user: User | null;
  entryCount: number;
  tagCount: number;
  syncError?: string | null;
  onSignOut: () => void;
}) {
  return (
    <section className="page profile-page" aria-label="나의 페이지">
      <div className="profile-hero">
        <div className="profile-avatar">
          {user?.photoURL ? <img src={user.photoURL} alt="" /> : <Cloud aria-hidden="true" />}
        </div>
        <div>
          <h1>나의 페이지</h1>
          <p>{user?.displayName || "Google 계정"}</p>
        </div>
      </div>

      <div className="profile-grid">
        <section className="profile-card">
          <span>현재 Google 계정</span>
          <strong>{user?.email ?? "계정 정보를 불러오는 중"}</strong>
        </section>
        <section className="profile-card">
          <span>동기화 범위</span>
          <strong>일기 {entryCount.toLocaleString("ko-KR")}개</strong>
        </section>
        <section className="profile-card">
          <span>태그</span>
          <strong>{tagCount.toLocaleString("ko-KR")}개</strong>
        </section>
      </div>

      {syncError ? <p className="profile-error">{syncError}</p> : null}

      <button className="signout-button" type="button" onClick={onSignOut}>
        Google 계정 로그아웃
      </button>
    </section>
  );
}

function TodayView({
  draft,
  activeMood,
  currentDate,
  canDelete,
  tagLibrary,
  onDraftChange,
  onFiles,
  onAddTag,
  onToggleTag,
  onDeleteTag,
  onDelete,
}: {
  draft: JournalEntry;
  activeMood?: MoodOption;
  currentDate: string;
  canDelete: boolean;
  tagLibrary: string[];
  onDraftChange: (updater: (entry: JournalEntry) => JournalEntry) => void;
  onFiles: (files: FileList | null) => void;
  onAddTag: (value: string) => void;
  onToggleTag: (tag: string) => void;
  onDeleteTag: (tag: string) => void;
  onDelete: () => void;
}) {
  const charCount = draft.body.trim().length;
  const [moodOpen, setMoodOpen] = useState(false);

  return (
    <div className="workspace">
      <section className="editor-panel" aria-label="오늘 일기 작성">
        <header className="editor-header">
          <div>
            <h1>{formatKoreanDate(currentDate)}</h1>
          </div>
        </header>

        <input
          className="title-input"
          value={draft.title}
          onChange={(event) => onDraftChange((entry) => ({ ...entry, title: event.target.value }))}
          placeholder="오늘의 제목은 비워도 괜찮아요"
          aria-label="일기 제목"
        />

        <textarea
          className="journal-editor"
          value={draft.body}
          onChange={(event) => onDraftChange((entry) => ({ ...entry, body: event.target.value }))}
          placeholder="오늘 있었던 일, 계속 생각나는 장면, 사소한 감정부터 적어보세요."
          aria-label="일기 본문"
          spellCheck="false"
        />

        <footer className="editor-footer">
          <span>{charCount.toLocaleString("ko-KR")}자</span>
          <button
            className="icon-button delete-entry-button"
            type="button"
            onClick={onDelete}
            disabled={!canDelete}
            aria-label="일기 삭제"
            title="일기 삭제"
          >
            <Trash2 aria-hidden="true" />
          </button>
        </footer>
      </section>

      <aside className="inspector-panel" aria-label="빠른 기록과 상태">
        <section className="tool-section">
          <div className="section-heading">
            <span>기분</span>
          </div>
          <MoodSelect
            activeMood={activeMood}
            isOpen={moodOpen}
            onOpenChange={setMoodOpen}
            onSelect={(mood) => {
              onDraftChange((entry) => ({ ...entry, mood }));
              setMoodOpen(false);
            }}
          />
        </section>

        <section className="tool-section">
          <div className="section-heading">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>태그</span>
              <button
                type="button"
                className="info-button"
                onClick={() => window.alert("추가된 태그를 꾹 누르면 삭제할 수 있습니다.")}
                aria-label="태그 삭제 방법"
              >
                <Info aria-hidden="true" />
              </button>
            </div>
            <small>{draft.tags.length}개 선택</small>
          </div>
          <TagSelector
            tags={tagLibrary}
            selected={draft.tags}
            onAdd={onAddTag}
            onToggle={onToggleTag}
            onDelete={onDeleteTag}
          />
        </section>

        <section className="tool-section photo-section">
          <div className="section-heading">
            <span>사진</span>
            <small>{draft.attachments.length}개</small>
          </div>
          <label className="upload-box">
            <ImagePlus aria-hidden="true" />
            <span>사진 추가</span>
            <input type="file" accept="image/*" multiple onChange={(event) => onFiles(event.target.files)} />
          </label>
          {draft.attachments.length > 0 ? (
            <div className="attachment-grid">
              {draft.attachments.map((item) => (
                <figure key={item.id} className={`attachment-card ${item.uploadState ? `is-${item.uploadState}` : ""}`}>
                  {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <div className="file-thumb" />}
                  {item.uploadState === "uploading" || item.uploadState === "failed" ? (
                    <span
                      className="attachment-state"
                      aria-label={item.uploadState === "uploading" ? "사진 업로드 중" : "사진 업로드 실패"}
                      title={item.uploadState === "uploading" ? "사진 업로드 중" : "사진 업로드 실패"}
                    />
                  ) : null}
                  <figcaption>{item.name}</figcaption>
                </figure>
              ))}
            </div>
          ) : null}
        </section>
      </aside>
    </div>
  );
}

function MoodSelect({
  activeMood,
  isOpen,
  onOpenChange,
  onSelect,
}: {
  activeMood?: MoodOption;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (mood: MoodId) => void;
}) {
  const ActiveIcon = activeMood?.icon ?? Smile;

  return (
    <>
      <button
        className={`mood-trigger ${activeMood?.tone ?? ""}`}
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label={activeMood ? activeMood.label : "기분 선택"}
        title={activeMood ? activeMood.label : "기분 선택"}
      >
        <ActiveIcon aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => onOpenChange(false)}>
          <div
            className="mood-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="기분 선택"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <strong>오늘 기분</strong>
              <button className="icon-button compact" type="button" onClick={() => onOpenChange(false)} aria-label="닫기">
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="mood-icon-grid">
              {MOODS.map((mood) => {
                const Icon = mood.icon;
                return (
                  <button
                    key={mood.id}
                    className={`mood-icon-button ${mood.tone} ${activeMood?.id === mood.id ? "is-selected" : ""}`}
                    type="button"
                    onClick={() => onSelect(mood.id)}
                    aria-label={mood.label}
                  >
                    <Icon aria-hidden="true" />
                    <span className="sr-only">{mood.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function TagSelector({
  tags,
  selected,
  onAdd,
  onToggle,
  onDelete,
}: {
  tags: string[];
  selected: string[];
  onAdd: (tag: string) => void;
  onToggle: (tag: string) => void;
  onDelete: (tag: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const longPressTimer = useRef<number | null>(null);

  function submitTag() {
    const tag = inputValue.trim();
    if (!tag) return;
    onAdd(tag);
    setInputValue("");
  }

  function startLongPress(tag: string) {
    longPressTimer.current = window.setTimeout(() => {
      const confirmed = window.confirm(`"${tag}" 태그를 삭제할까요?\n삭제하면 태그 라이브러리에서 제거됩니다.`);
      if (confirmed) onDelete(tag);
      longPressTimer.current = null;
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  return (
    <div className="tag-selector">
      <div className="tag-add-row">
        <input
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitTag();
            }
          }}
          placeholder="태그 추가"
          aria-label="태그 추가"
        />
        <button type="button" onClick={submitTag} aria-label="태그 추가">
          <Plus aria-hidden="true" />
        </button>
      </div>

      <div className="tag-choice-grid" role="group" aria-label="태그 선택">
        {tags.length ? (
          tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`tag-choice ${selected.includes(tag) ? "is-selected" : ""}`}
              onClick={() => onToggle(tag)}
              onPointerDown={() => startLongPress(tag)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onContextMenu={(event) => event.preventDefault()}
            >
              #{tag}
            </button>
          ))
        ) : (
          <small>자주 쓰는 태그를 추가해두면 다음 일기부터 터치 한 번으로 선택할 수 있어요.</small>
        )}
      </div>
    </div>
  );
}

function MoodDot({ moodId }: { moodId?: MoodId }) {
  const mood = MOODS.find((item) => item.id === moodId);
  if (!mood) return null;
  const Icon = mood.icon;
  return <Icon className={`mood-calendar-icon ${mood.tone}`} aria-label={mood.label} />;
}

function CalendarView({
  monthCursor,
  days,
  entryByDate,
  onShiftMonth,
  onSelectDate,
}: {
  monthCursor: Date;
  days: string[];
  entryByDate: Map<string, JournalEntry>;
  onShiftMonth: (delta: number) => void;
  onSelectDate: (date: string) => void;
}) {
  return (
    <section className="page unified-width calendar-page" aria-label="캘린더">
      <header className="page-header">
        <div>
          <h1>{monthTitle(monthCursor)}</h1>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={() => onShiftMonth(-1)} aria-label="이전 달">
            <ChevronLeft aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={() => onShiftMonth(1)} aria-label="다음 달">
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="weekday-row" aria-hidden="true">
        {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="calendar-grid">
        {days.map((day) => {
          const entry = entryByDate.get(day);
          return (
            <button
              key={day}
              className={`calendar-day ${isSameMonth(day, monthCursor) ? "" : "is-muted"} ${
                entry ? "has-entry" : ""
              } ${todayKey() === day ? "is-today" : ""}`}
              type="button"
              onClick={() => onSelectDate(day)}
            >
              <span>{new Date(`${day}T00:00:00`).getDate()}</span>
              <MoodDot moodId={entry?.mood} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SearchView({
  query,
  results,
  allTags,
  filterTags,
  onQueryChange,
  onToggleTagFilter,
  onSelectEntry,
}: {
  query: string;
  results: JournalEntry[];
  allTags: string[];
  filterTags: string[];
  onQueryChange: (value: string) => void;
  onToggleTagFilter: (tag: string) => void;
  onSelectEntry: (entry: JournalEntry) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const activeFilterCount = filterTags.length;

  return (
    <section className="page unified-width search-page" aria-label="검색">
      <div className={`search-control ${filterOpen ? "is-open" : ""}`}>
        <div className="search-bar-row">
          <div className="search-box">
            <Search aria-hidden="true" />
            <input
              id="search-input"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="본문, 날짜로 검색"
              aria-label="일기 검색"
            />
          </div>
          <button
            className={`filter-toggle ${filterOpen || activeFilterCount > 0 ? "is-active" : ""}`}
            type="button"
            onClick={() => setFilterOpen((prev) => !prev)}
            aria-label="필터"
          >
            <SlidersHorizontal aria-hidden="true" />
            {activeFilterCount > 0 ? <span className="filter-badge">{activeFilterCount}</span> : null}
          </button>
        </div>

        {filterOpen ? (
          <div className="filter-panel">
            {allTags.length > 0 ? (
              <div className="filter-chips">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    className={`filter-chip ${filterTags.includes(tag) ? "is-selected" : ""}`}
                    type="button"
                    onClick={() => onToggleTagFilter(tag)}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            ) : (
              <small style={{ color: "var(--muted)", fontSize: 12 }}>
                일기에 태그를 추가하면 여기서 필터로 사용할 수 있어요.
              </small>
            )}
          </div>
        ) : null}
      </div>

      <div className="result-list">
        {results.length ? (
          results.map((entry) => (
            <button key={entry.id} className="entry-row" type="button" onClick={() => onSelectEntry(entry)}>
              <span>{formatShortDate(entry.date)}</span>
              <strong>{entry.title || entry.body.slice(0, 44) || "제목 없는 기록"}</strong>
              <small>{entry.body.slice(0, 130) || "본문 없이 빠른 기록만 남겨졌어요."}</small>
            </button>
          ))
        ) : (
          <EmptyState title="검색 결과가 없습니다" text="필터를 조정하거나 다른 단어로 다시 찾아보세요." />
        )}
      </div>
    </section>
  );
}





function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <BookOpen aria-hidden="true" />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function MobileNav({ current, onChange }: { current: ViewId; onChange: (view: ViewId) => void }) {
  return (
    <nav className="mobile-nav" aria-label="모바일 주요 화면">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          className={current === item.id ? "is-active" : ""}
          type="button"
          onClick={() => onChange(item.id)}
          aria-label={item.id}
        >
          <item.icon aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}

function MobileAccountButton({
  user,
  isProfileActive,
  onClick,
}: {
  user: User;
  isProfileActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`mobile-account-button ${isProfileActive ? "is-active" : ""}`}
      type="button"
      onClick={onClick}
      aria-label="나의 페이지"
      title={user.email ?? "나의 페이지"}
    >
      {user.photoURL ? <img src={user.photoURL} alt="" /> : <Cloud aria-hidden="true" />}
    </button>
  );
}

function MobileThemeButton({
  theme,
  onClick,
}: {
  theme: AppSettings["theme"];
  onClick: () => void;
}) {
  return (
    <button className="mobile-theme-button" type="button" onClick={onClick} aria-label="테마 전환" title="테마 전환">
      {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
    </button>
  );
}

export default App;
