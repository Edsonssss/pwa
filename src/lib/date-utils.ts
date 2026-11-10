/** Хелперы работы с датами (локальная зона устройства, формат YYYY-MM-DD). */

export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

export function todayISO(): string {
  return toLocalISODate(new Date());
}

export function addDaysISO(s: string, delta: number): string {
  const d = parseISODate(s);
  d.setDate(d.getDate() + delta);
  return toLocalISODate(d);
}

export function daysBetween(a: string, b: string): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function weekdayShort(s: string): string {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(parseISODate(s));
}

export function monthYearTitle(s: string): string {
  const d = parseISODate(s);
  const month = new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(d);
  const cap = month.charAt(0).toUpperCase() + month.slice(1);
  return `${cap} ${d.getFullYear()}`;
}

export function fullDateTitle(s: string): string {
  const str = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "short",
  }).format(parseISODate(s));
  return str;
}

export function shortDateTitle(s: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(
    parseISODate(s)
  );
}

/** «Сегодня», «Завтра», «Вчера» или короткая дата. */
export function relativeDayLabel(s: string): string {
  const diff = daysBetween(todayISO(), s);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Завтра";
  if (diff === -1) return "Вчера";
  const d = parseISODate(s);
  const wd = new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(d);
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)}, ${shortDateTitle(s)}`;
}

/** Дата в прошлом (просрочено, если напоминание не выполнено). */
export function isPastDate(s: string): boolean {
  return daysBetween(todayISO(), s) < 0;
}

export function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
