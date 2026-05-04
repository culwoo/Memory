import { deleteObject, ref, uploadBytes } from "firebase/storage";

import type { AttachmentMeta } from "../types";
import { firebaseStorage } from "./firebase";

function safeFileName(name: string): string {
  const fallback = "photo";
  const normalized = name
    .trim()
    .replace(/[\\/#?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);

  return normalized || fallback;
}

function attachmentPath(userId: string, entryDate: string, attachmentId: string, fileName: string): string {
  return `users/${userId}/entries/${entryDate}/attachments/${attachmentId}-${safeFileName(fileName)}`;
}

export async function uploadAttachmentFile(
  userId: string,
  entryDate: string,
  attachmentId: string,
  file: File
): Promise<string> {
  const storage = firebaseStorage;
  if (!storage) throw new Error("Firebase Storage is not configured.");

  const path = attachmentPath(userId, entryDate, attachmentId, file.name);
  await uploadBytes(ref(storage, path), file, {
    contentType: file.type || "application/octet-stream",
    customMetadata: {
      entryDate,
      attachmentId,
    },
  });

  return path;
}

export async function deleteAttachmentFiles(attachments: AttachmentMeta[]): Promise<void> {
  const storage = firebaseStorage;
  if (!storage) return;

  const paths = attachments
    .map((attachment) => attachment.storagePath)
    .filter((path): path is string => Boolean(path));
  await Promise.all(
    paths.map(async (path) => {
      try {
        await deleteObject(ref(storage, path));
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
        if (!code.includes("object-not-found")) throw error;
      }
    })
  );
}
