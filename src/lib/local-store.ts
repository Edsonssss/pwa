/**
 * Клиентское JSON-хранилище (без сервера).
 * Приложение полностью статическое (GitHub Pages), поэтому все данные —
 * профили, напоминания, ссылки — хранятся в localStorage устройства в виде
 * JSON. PIN-код хешируется SHA-256 + salt через Web Crypto.
 *
 * Структура совпадает с прежним серверным хранилищем, поэтому экспортированный
 * JSON-файл можно перенести на другое устройство через «Импорт данных».
 */
import type { Priority, ProjectLink, PublicUser, Reminder } from "./types";

const DB_KEY = "planner.db.v1";

interface StoredUser {
  id: string;
  name: string;
  color: string;
  pinSalt: string | null;
  pinHash: string | null;
  createdAt: string;
}

interface Database {
  users: StoredUser[];
  reminders: Reminder[];
  links: ProjectLink[];
}

export const USER_COLORS = [
  "#0d9488", // teal
  "#e11d48", // rose
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#059669", // emerald
  "#ea580c", // orange
];

/* ------------------------------- primitives ------------------------------- */

function emptyDb(): Database {
  return { users: [], reminders: [], links: [] };
}

function readDb(): Database {
  if (typeof window === "undefined") return emptyDb();
  try {
    const raw = window.localStorage.getItem(DB_KEY);
    if (!raw) return emptyDb();
    const parsed = JSON.parse(raw) as Partial<Database>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      links: Array.isArray(parsed.links) ? parsed.links : [],
    };
  } catch {
    return emptyDb();
  }
}

function writeDb(db: Database): void {
  window.localStorage.setItem(DB_KEY, JSON.stringify(db));
  changeListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // слушатель (например, автосинхронизация) не должен ломать запись
    }
  });
}

/* ------------------------ уведомления об изменениях ----------------------- */

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

/** Подписка на изменения локальной базы (используется автосинхронизацией GitHub). */
export function subscribeDataChanges(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

/** Количество записей в локальной базе (для решения конфликтов синхронизации). */
export async function statsAll(): Promise<{ users: number; reminders: number; links: number }> {
  const db = readDb();
  return { users: db.users.length, reminders: db.reminders.length, links: db.links.length };
}

/** Последовательная очередь записи: исключает гонки read-modify-write. */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newSalt(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toPublic(u: StoredUser): PublicUser {
  return {
    id: u.id,
    name: u.name,
    color: u.color,
    hasPin: !!u.pinHash,
    createdAt: u.createdAt,
  };
}

/* --------------------------------- users ---------------------------------- */

export async function listUsers(): Promise<PublicUser[]> {
  return readDb()
    .users.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toPublic);
}

export async function getUser(id: string): Promise<PublicUser | null> {
  const u = readDb().users.find((x) => x.id === id);
  return u ? toPublic(u) : null;
}

export async function createUser(
  name: string,
  color?: string,
  pin?: string | null
): Promise<PublicUser> {
  return enqueue(async () => {
    const db = readDb();
    const user: StoredUser = {
      id: uid(),
      name: name.trim().slice(0, 40),
      color: color ?? USER_COLORS[db.users.length % USER_COLORS.length],
      pinSalt: null,
      pinHash: null,
      createdAt: new Date().toISOString(),
    };
    if (pin) {
      user.pinSalt = newSalt();
      user.pinHash = await hashPin(pin, user.pinSalt);
    }
    db.users.push(user);
    writeDb(db);
    return toPublic(user);
  });
}

export interface UserPatch {
  name?: string;
  color?: string;
  /** строка из 4 цифр — установить PIN; null/"" — снять */
  pin?: string | null;
}

export async function updateUser(id: string, patch: UserPatch): Promise<PublicUser | null> {
  return enqueue(async () => {
    const db = readDb();
    const u = db.users.find((x) => x.id === id);
    if (!u) return null;
    if (patch.name !== undefined) u.name = patch.name.trim().slice(0, 40) || u.name;
    if (patch.color !== undefined) u.color = patch.color;
    if (patch.pin !== undefined) {
      if (patch.pin) {
        u.pinSalt = newSalt();
        u.pinHash = await hashPin(patch.pin, u.pinSalt);
      } else {
        u.pinSalt = null;
        u.pinHash = null;
      }
    }
    writeDb(db);
    return toPublic(u);
  });
}

export async function deleteUser(id: string): Promise<boolean> {
  return enqueue(async () => {
    const db = readDb();
    const next = db.users.filter((x) => x.id !== id);
    if (next.length === db.users.length) return false;
    db.users = next;
    db.reminders = db.reminders.filter((r) => r.userId !== id);
    db.links = db.links.filter((l) => l.userId !== id);
    writeDb(db);
    return true;
  });
}

export async function verifyPin(userId: string, pin: string): Promise<PublicUser | null> {
  const u = readDb().users.find((x) => x.id === userId);
  if (!u) return null;
  if (!u.pinHash) return toPublic(u); // PIN не установлен — вход без кода
  return (await hashPin(pin, u.pinSalt ?? "")) === u.pinHash ? toPublic(u) : null;
}

/* ------------------------------- reminders -------------------------------- */

export interface ReminderInput {
  title: string;
  note?: string;
  date: string;
  time?: string | null;
  priority?: Priority;
}

export async function listReminders(userId: string): Promise<Reminder[]> {
  return readDb()
    .reminders.filter((r) => r.userId === userId)
    .sort((a, b) => (a.date + (a.time ?? "~")).localeCompare(b.date + (b.time ?? "~")));
}

export async function createReminder(userId: string, input: ReminderInput): Promise<Reminder> {
  return enqueue(() => {
    const db = readDb();
    const now = new Date().toISOString();
    const item: Reminder = {
      id: uid(),
      userId,
      title: input.title.trim().slice(0, 200),
      note: (input.note ?? "").trim().slice(0, 2000),
      date: input.date,
      time: input.time || null,
      priority: input.priority ?? "normal",
      completed: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    db.reminders.push(item);
    writeDb(db);
    return item;
  });
}

export interface ReminderPatch {
  title?: string;
  note?: string;
  date?: string;
  time?: string | null;
  priority?: Priority;
  completed?: boolean;
}

export async function updateReminder(
  id: string,
  patch: ReminderPatch
): Promise<Reminder | null> {
  return enqueue(() => {
    const db = readDb();
    const item = db.reminders.find((r) => r.id === id);
    if (!item) return null;
    if (patch.title !== undefined) item.title = patch.title.trim().slice(0, 200) || item.title;
    if (patch.note !== undefined) item.note = patch.note.trim().slice(0, 2000);
    if (patch.date !== undefined) item.date = patch.date;
    if (patch.time !== undefined) item.time = patch.time || null;
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.completed !== undefined) {
      item.completed = patch.completed;
      item.completedAt = patch.completed ? new Date().toISOString() : null;
    }
    item.updatedAt = new Date().toISOString();
    writeDb(db);
    return item;
  });
}

export async function deleteReminder(id: string): Promise<boolean> {
  return enqueue(() => {
    const db = readDb();
    const next = db.reminders.filter((r) => r.id !== id);
    if (next.length === db.reminders.length) return false;
    db.reminders = next;
    writeDb(db);
    return true;
  });
}

/* --------------------------------- links ---------------------------------- */

export interface LinkInput {
  title: string;
  url: string;
  description?: string;
  icon?: string;
}

export async function listLinks(userId: string): Promise<ProjectLink[]> {
  return readDb()
    .links.filter((l) => l.userId === userId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createLink(userId: string, input: LinkInput): Promise<ProjectLink> {
  return enqueue(() => {
    const db = readDb();
    const item: ProjectLink = {
      id: uid(),
      userId,
      title: input.title.trim().slice(0, 80),
      url: input.url.trim().slice(0, 500),
      description: (input.description ?? "").trim().slice(0, 200),
      icon: (input.icon ?? "🔗").slice(0, 8),
      createdAt: new Date().toISOString(),
    };
    db.links.push(item);
    writeDb(db);
    return item;
  });
}

export interface LinkPatch {
  title?: string;
  url?: string;
  description?: string;
  icon?: string;
}

export async function updateLink(id: string, patch: LinkPatch): Promise<ProjectLink | null> {
  return enqueue(() => {
    const db = readDb();
    const item = db.links.find((l) => l.id === id);
    if (!item) return null;
    if (patch.title !== undefined) item.title = patch.title.trim().slice(0, 80) || item.title;
    if (patch.url !== undefined) item.url = patch.url.trim().slice(0, 500);
    if (patch.description !== undefined) item.description = patch.description.trim().slice(0, 200);
    if (patch.icon !== undefined) item.icon = patch.icon.slice(0, 8) || "🔗";
    writeDb(db);
    return item;
  });
}

export async function deleteLink(id: string): Promise<boolean> {
  return enqueue(() => {
    const db = readDb();
    const next = db.links.filter((l) => l.id !== id);
    if (next.length === db.links.length) return false;
    db.links = next;
    writeDb(db);
    return true;
  });
}

/* ----------------------------- экспорт/импорт ------------------------------ */

export interface ExportPayload {
  app: "ezhednik";
  version: 1;
  exportedAt: string;
  data: Database;
}

/** Полный снимок данных устройства (без PIN-хешей они не нужны, но безвредны). */
export async function exportAll(): Promise<ExportPayload> {
  const db = readDb();
  return {
    app: "ezhednik",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: db,
  };
}

/** Заменяет все данные устройства содержимым файла резервной копии. */
export async function importAll(payload: unknown): Promise<{ users: number; reminders: number; links: number }> {
  const p = payload as Partial<ExportPayload> | null;
  const data = (p?.data ?? p) as Partial<Database> | null;
  if (!data || typeof data !== "object") throw new Error("Файл повреждён: нет данных");
  const users = Array.isArray(data.users) ? data.users : [];
  const reminders = Array.isArray(data.reminders) ? data.reminders : [];
  const links = Array.isArray(data.links) ? data.links : [];
  return enqueue(() => {
    writeDb({ users, reminders, links });
    return { users: users.length, reminders: reminders.length, links: links.length };
  });
}
