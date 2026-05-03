export function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatKoreanDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

export function formatShortDate(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function monthTitle(date: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
  }).format(date);
}

export function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

export function getCalendarDays(month: Date): string[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(firstDay);
  start.setDate(firstDay.getDate() - firstDay.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return todayKey(day);
  });
}

export function isSameMonth(dateKey: string, month: Date): boolean {
  const date = new Date(`${dateKey}T00:00:00`);
  return date.getMonth() === month.getMonth() && date.getFullYear() === month.getFullYear();
}

export function relativeSavedTime(iso?: string): string {
  if (!iso) return "아직 저장되지 않음";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "방금 저장됨";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전 저장됨`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전 저장됨`;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

