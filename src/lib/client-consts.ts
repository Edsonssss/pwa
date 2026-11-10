/** Палитра цветов профилей. */
export const USER_COLORS_CLIENT = [
  "#0d9488", // teal
  "#e11d48", // rose
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#059669", // emerald
  "#ea580c", // orange
] as const;

/** Приоритеты напоминаний. */
export const PRIORITY_META = {
  low: { label: "Низкий", dot: "bg-sky-400", chip: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" },
  normal: { label: "Обычный", dot: "bg-slate-400", chip: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  high: { label: "Высокий", dot: "bg-rose-500", chip: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
} as const;
