/**
 * Единая точка доступа к данным. Приложение статическое (GitHub Pages) —
 * сервера нет, поэтому все операции выполняются локально в localStorage
 * устройства через local-store. Интерфейс сохранён прежним, компоненты
 * не изменились.
 */
import type { ProjectLink, PublicUser, Reminder } from "./types";
import {
  createUser as lsCreateUser,
  createLink as lsCreateLink,
  createReminder as lsCreateReminder,
  deleteLink as lsDeleteLink,
  deleteReminder as lsDeleteReminder,
  deleteUser as lsDeleteUser,
  getUser as lsGetUser,
  listLinks as lsListLinks,
  listReminders as lsListReminders,
  listUsers as lsListUsers,
  updateLink as lsUpdateLink,
  updateReminder as lsUpdateReminder,
  updateUser as lsUpdateUser,
  verifyPin,
} from "./local-store";

export const api = {
  listUsers: () => lsListUsers(),

  getUser: (id: string) => lsGetUser(id),

  createUser: (name: string, color?: string, pin?: string) => {
    const trimmed = name?.trim();
    if (!trimmed) return Promise.reject(new Error("Укажите имя профиля"));
    if (pin && !/^\d{4}$/.test(pin)) {
      return Promise.reject(new Error("PIN-код должен состоять из 4 цифр"));
    }
    return lsCreateUser(trimmed, color, pin || null);
  },

  updateUser: (
    id: string,
    patch: { name?: string; color?: string; pin?: string | null }
  ) => lsUpdateUser(id, patch),

  deleteUser: (id: string) => lsDeleteUser(id).then(() => ({ ok: true as const })),

  login: (userId: string, pin?: string) =>
    verifyPin(userId, pin ?? "").then((user) => {
      if (!user) throw new Error("Неверный PIN-код");
      return user;
    }),

  /* ------------------------------- reminders ------------------------------ */

  listReminders: (userId: string) => lsListReminders(userId),

  createReminder: (input: {
    userId: string;
    title: string;
    note?: string;
    date: string;
    time?: string | null;
    priority?: Reminder["priority"];
  }) => lsCreateReminder(input.userId, input),

  updateReminder: (
    id: string,
    input: Partial<{
      userId: string;
      title: string;
      note: string;
      date: string;
      time: string | null;
      priority: Reminder["priority"];
      completed: boolean;
    }>
  ) =>
    lsUpdateReminder(id, input).then((reminder) => {
      if (!reminder) throw new Error("Напоминание не найдено");
      return reminder;
    }),

  deleteReminder: (id: string, _userId: string) =>
    lsDeleteReminder(id).then((ok) => ({ ok })),

  /* --------------------------------- links -------------------------------- */

  listLinks: (userId: string) => lsListLinks(userId),

  createLink: (input: {
    userId: string;
    title: string;
    url: string;
    description?: string;
    icon?: string;
  }) => lsCreateLink(input.userId, input),

  updateLink: (
    id: string,
    input: Partial<{
      userId: string;
      title: string;
      url: string;
      description: string;
      icon: string;
    }>
  ) =>
    lsUpdateLink(id, input).then((link) => {
      if (!link) throw new Error("Ссылка не найдена");
      return link;
    }),

  deleteLink: (id: string, _userId: string) => lsDeleteLink(id).then((ok) => ({ ok })),
};
