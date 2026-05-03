import {
  Angry,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Frown,
  ImagePlus,
  Info,
  Laugh,
  Meh,
  Moon,
  Plus,
  Search,
  SlidersHorizontal,
  Smile,
  Sun,
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
  getEntries,
  getAllEntries,
  getMetaValue,
  getSettings,
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
import {
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

function syncErrorMessage(error: unknown): string {
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

  return `Firestore 동기화 실패${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
}

async function makeThumbnail(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/")) return undefined;

  try {
    const bitmap = await createImageBitmap(file);
    const maxSize = 520;
    const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    context?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.78);
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
  const [filterMoods, setFilterMoods] = useState<MoodId[]>([]);
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
  const currentDateRef = useRef(currentDate);
  const dirtyRef = useRef(dirty);
  const syncUserRef = useRef<User | null>(syncUser);
  const tagLibraryRef = useRef<string[]>(tagLibrary);

  const entryByDate = useMemo(() => new Map(entries.map((entry) => [entry.date, entry])), [entries]);
  const activeMood = MOODS.find((mood) => mood.id === draft.mood);

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

  const loadDraftForDate = useCallback(
    (date: string, nextView: ViewId = "today") => {
      const existing = entryByDate.get(date);
      setCurrentDate(date);
      setDraft(existing ?? createEmptyEntry(date));
      setDirty(false);
      setSaveState(existing ? "saved" : "idle");
      setView(nextView);
    },
    [entryByDate]
  );

  const updateDraft = useCallback((updater: (entry: JournalEntry) => JournalEntry) => {
    setDraft((previous) => updater(previous));
    setDirty(true);
    setSaveState("dirty");
  }, []);

  const persistDraft = useCallback(
    async (entry: JournalEntry = draft) => {
      if (!hasEntryContent(entry)) {
        setSaveState("idle");
        return;
      }

      setSaveState("saving");
      const now = new Date().toISOString();
      const nextEntry: JournalEntry = {
        ...entry,
        updatedAt: now,
        version: entry.version + 1,
      };

      try {
        await saveEntry(nextEntry);
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
    [draft]
  );

  useEffect(() => {
    let active = true;

    Promise.all([
      getEntries(),
      getSettings(),
      getMetaValue<string[]>("tagLibrary"),
    ]).then(
      ([storedEntries, storedSettings, storedTagLibrary]) => {
        if (!active) return;
        setEntries(storedEntries);
        setSettingsState(storedSettings);
        document.documentElement.dataset.theme = storedSettings.theme;
        const entryTags = storedEntries.flatMap((entry) => [...entry.tags, ...entry.activityTags]);
        setTagLibrary(uniqueTags([...(storedTagLibrary ?? []), ...entryTags]));

        const existing = storedEntries.find((entry) => entry.date === todayKey());
        setDraft(existing ?? createEmptyEntry(todayKey()));
        setSaveState(existing ? "saved" : "idle");
      }
    );

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;

    return subscribeAuth((user) => {
      setSyncUser(user);
      setAuthReady(true);
      if (user) setSyncError(null);
    });
  }, []);

  useEffect(() => {
    if (!syncUser) return undefined;

    const userId = syncUser.uid;
    let active = true;
    let unsubscribeEntries: (() => void) | undefined;
    let unsubscribeTags: (() => void) | undefined;

    async function startSync() {
      try {
        const [localEntries, storedTagLibrary] = await Promise.all([
          getAllEntries(),
          getMetaValue<string[]>("tagLibrary"),
        ]);
        const lastSyncUserId = await getMetaValue<string>("lastSyncUserId");
        if (lastSyncUserId && lastSyncUserId !== userId) {
          setSyncError("이 기기에는 다른 Google 계정의 로컬 일기가 있습니다. 계정을 확인한 뒤 다시 로그인하세요.");
          void signOutFromGoogle();
          return;
        }
        void setMetaValue("lastSyncUserId", userId);

        const mergedEntries = await syncEntriesWithCloud(userId, localEntries);
        if (!active) return;

        await Promise.all(mergedEntries.map((entry) => saveEntry(entry)));
        const visibleEntries = sortEntries(mergedEntries.filter((entry) => !entry.deletedAt));
        setEntries(visibleEntries);
        setDraft((previous) => {
          if (dirtyRef.current) return previous;
          return visibleEntries.find((entry) => entry.date === currentDateRef.current) ?? previous;
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
            setEntries(nextVisibleEntries);
            setDraft((previous) => {
              if (dirtyRef.current) return previous;
              return nextVisibleEntries.find((entry) => entry.date === currentDateRef.current) ?? previous;
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
  }, [syncUser]);

  useEffect(() => {
    if (!dirty || !settings.autoSaveEnabled) return undefined;
    const timer = window.setTimeout(() => {
      void persistDraft();
    }, 650);

    return () => window.clearTimeout(timer);
  }, [dirty, persistDraft, settings.autoSaveEnabled]);

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
        setView("search");
        window.setTimeout(() => document.getElementById("search-input")?.focus(), 0);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [persistDraft]);

  const searchResults = useMemo(() => {
    const hasTextQuery = !!debouncedQuery;
    const hasTagFilter = filterTags.length > 0;
    const hasMoodFilter = filterMoods.length > 0;
    const hasAnyFilter = hasTextQuery || hasTagFilter || hasMoodFilter;

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
      if (hasMoodFilter) {
        if (!entry.mood || !filterMoods.includes(entry.mood)) return false;
      }
      return true;
    });
  }, [debouncedQuery, entries, filterTags, filterMoods]);

  const calendarDays = useMemo(() => getCalendarDays(monthCursor), [monthCursor]);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;

    for (const file of Array.from(files).slice(0, 6)) {
      const id = createId("attachment");
      const thumbnail = await makeThumbnail(file);
      const createdAt = new Date().toISOString();
      const meta: AttachmentMeta = {
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        thumbnail,
        createdAt,
      };
      const record: AttachmentRecord = {
        ...meta,
        entryId: draft.id,
        blob: file,
      };
      await saveAttachment(record);
      updateDraft((entry) => ({ ...entry, attachments: [...entry.attachments, meta] }));
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
    if (!hasEntryContent(draft)) return;
    const confirmed = window.confirm("현재 기록을 휴지통으로 이동할까요?");
    if (!confirmed) return;
    const now = new Date().toISOString();
    const deletedEntry: JournalEntry = {
      ...draft,
      deletedAt: now,
      updatedAt: now,
      version: draft.version + 1,
    };
    await saveEntry(deletedEntry);
    if (syncUserRef.current) {
      void pushEntryToCloud(syncUserRef.current.uid, deletedEntry).catch((error) => {
        setSyncError(syncErrorMessage(error));
      });
    }
    setEntries((previous) => previous.filter((entry) => entry.id !== draft.id));
    setDraft(createEmptyEntry(currentDate));
    setDirty(false);
    setSaveState("idle");
  }

  const content = {
    today: (
      <TodayView
        draft={draft}
        activeMood={activeMood}
        currentDate={currentDate}
        tagLibrary={tagLibrary}
        onDraftChange={updateDraft}
        onFiles={handleFiles}
        onAddTag={handleAddTag}
        onToggleTag={handleToggleTag}
        onDeleteTag={handleDeleteTag}
        onDelete={() => void handleDeleteCurrent()}
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
        filterMoods={filterMoods}
        onQueryChange={setQuery}
        onToggleTagFilter={(tag) => setFilterTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
        onToggleMoodFilter={(mood) => setFilterMoods((prev) => prev.includes(mood) ? prev.filter((m) => m !== mood) : [...prev, mood])}
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
    } catch {
      setSyncError("Google 로그인을 시작하지 못했습니다. Firebase Auth 설정을 확인하세요.");
    }
  }

  if (!authReady) {
    return <LoginScreen mode="loading" />;
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
              onClick={() => setView(item.id)}
              aria-label={item.id}
            >
              <item.icon aria-hidden="true" />
            </button>
          ))}
        </nav>

        <button
          className={`account-button ${view === "profile" ? "is-active" : ""}`}
          type="button"
          onClick={() => setView("profile")}
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

      <MobileAccountButton user={syncUser} isActive={view === "profile"} onClick={() => setView("profile")} />
      <MobileNav current={view} onChange={setView} />
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
          <button className="text-button danger" type="button" onClick={onDelete}>
            기록 비우기
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
                <figure key={item.id}>
                  {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <div className="file-thumb" />}
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
  filterMoods,
  onQueryChange,
  onToggleTagFilter,
  onToggleMoodFilter,
  onSelectEntry,
}: {
  query: string;
  results: JournalEntry[];
  allTags: string[];
  filterTags: string[];
  filterMoods: MoodId[];
  onQueryChange: (value: string) => void;
  onToggleTagFilter: (tag: string) => void;
  onToggleMoodFilter: (mood: MoodId) => void;
  onSelectEntry: (entry: JournalEntry) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const activeFilterCount = filterTags.length + filterMoods.length;

  return (
    <section className="page unified-width search-page" aria-label="검색">
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
          ) : null}
          <div className="filter-chips mood-filter-row">
            {MOODS.map((mood) => {
              const Icon = mood.icon;
              return (
                <button
                  key={mood.id}
                  className={`filter-chip mood-filter-chip ${mood.tone} ${filterMoods.includes(mood.id) ? "is-selected" : ""}`}
                  type="button"
                  onClick={() => onToggleMoodFilter(mood.id)}
                  aria-label={mood.label}
                >
                  <Icon aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

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
  isActive,
  onClick,
}: {
  user: User;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`mobile-account-button ${isActive ? "is-active" : ""}`}
      type="button"
      onClick={onClick}
      aria-label="나의 페이지"
      title={user.email ?? "나의 페이지"}
    >
      {user.photoURL ? <img src={user.photoURL} alt="" /> : <Cloud aria-hidden="true" />}
    </button>
  );
}

export default App;
