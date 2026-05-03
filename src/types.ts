export type MoodId = "clear" | "good" | "tired" | "heavy" | "angry" | "quiet";

export interface AttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  thumbnail?: string;
  createdAt: string;
}

export interface AttachmentRecord extends AttachmentMeta {
  entryId: string;
  blob: Blob;
}

export interface JournalEntry {
  id: string;
  date: string;
  title: string;
  body: string;
  mood?: MoodId;
  activityTags: string[];
  tags: string[];
  attachments: AttachmentMeta[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  version: number;
}

export interface AppSettings {
  theme: "light" | "dark";
  writingFont: "sans" | "serif";
  autoSaveEnabled: boolean;
  aiEnabled: boolean;
  encryptionEnabled: boolean;
  syncEnabled: boolean;
}

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

