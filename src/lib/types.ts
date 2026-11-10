/** Shared types between client and server */

export type Priority = "low" | "normal" | "high";

export interface PublicUser {
  id: string;
  name: string;
  color: string;
  hasPin: boolean;
  createdAt: string;
}

export interface Reminder {
  id: string;
  userId: string;
  title: string;
  note: string;
  date: string; // YYYY-MM-DD (локальная дата устройства)
  time: string | null; // HH:MM или null
  priority: Priority;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ProjectLink {
  id: string;
  userId: string;
  title: string;
  url: string;
  description: string;
  icon: string; // emoji
  createdAt: string;
}
