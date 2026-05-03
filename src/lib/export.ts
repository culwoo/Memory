import type { JournalEntry } from "../types";

function downloadBlob(fileName: string, content: BlobPart, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function entryToMarkdown(entry: JournalEntry): string {
  const title = entry.title.trim() || entry.date;
  const frontmatter = [
    "---",
    `date: ${entry.date}`,
    `mood: ${entry.mood ?? ""}`,
    `activities: [${entry.activityTags.join(", ")}]`,
    `tags: [${entry.tags.join(", ")}]`,
    `updatedAt: ${entry.updatedAt}`,
    "---",
  ].join("\n");

  const attachments =
    entry.attachments.length > 0
      ? `\n\n첨부파일:\n${entry.attachments.map((item) => `- ${item.name}`).join("\n")}`
      : "";

  return `${frontmatter}\n\n# ${title}\n\n${entry.body.trim() || "_본문 없음_"}${attachments}\n`;
}

export function exportAsJson(entries: JournalEntry[]): void {
  const createdAt = new Date().toISOString();
  const payload = {
    app: "Memory",
    version: "0.1.0",
    createdAt,
    entryCount: entries.length,
    entries,
  };

  downloadBlob(
    `memory-export-${createdAt.slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    "application/json;charset=utf-8"
  );
}

export function exportAsMarkdown(entries: JournalEntry[]): void {
  const createdAt = new Date().toISOString();
  const content = entries
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(entryToMarkdown)
    .join("\n\n---\n\n");

  downloadBlob(
    `memory-journal-${createdAt.slice(0, 10)}.md`,
    content,
    "text/markdown;charset=utf-8"
  );
}

export function openPrintableArchive(entries: JournalEntry[]): void {
  const sorted = entries.slice().sort((a, b) => a.date.localeCompare(b.date));
  const body = sorted
    .map((entry) => {
      const title = escapeHtml(entry.title.trim() || entry.date);
      const text = escapeHtml(entry.body || "").replaceAll("\n", "<br />");
      const tags = [...entry.activityTags, ...entry.tags].map(escapeHtml).join(", ");

      return `<article>
        <p class="date">${escapeHtml(entry.date)}</p>
        <h2>${title}</h2>
        <p class="meta">${entry.mood ? `기분: ${escapeHtml(entry.mood)} · ` : ""}${tags}</p>
        <div class="body">${text || "<em>본문 없음</em>"}</div>
      </article>`;
    })
    .join("");

  const html = `<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>Memory Archive</title>
        <style>
          body { margin: 48px; font-family: serif; color: #253028; background: #fffdf8; }
          header { border-bottom: 1px solid #ddd5ca; margin-bottom: 32px; padding-bottom: 16px; }
          h1 { font-size: 32px; margin: 0 0 8px; }
          article { break-inside: avoid; margin: 0 0 36px; padding-bottom: 28px; border-bottom: 1px solid #e5ded2; }
          h2 { font-size: 24px; margin: 8px 0 10px; }
          .date, .meta { color: #726b61; font-family: sans-serif; font-size: 13px; }
          .body { font-size: 17px; line-height: 1.75; white-space: normal; }
        </style>
      </head>
      <body>
        <header>
          <h1>Memory Archive</h1>
          <p>${sorted.length}개의 기록 · ${new Date().toLocaleDateString("ko-KR")}</p>
        </header>
        ${body}
        <script>window.addEventListener("load", () => window.print());</script>
      </body>
    </html>`;

  const printWindow = window.open("", "_blank", "noopener,noreferrer");
  if (!printWindow) return;
  printWindow.document.write(html);
  printWindow.document.close();
}

