"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import type { ProjectLink } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ProjectsViewProps {
  userId: string;
}

const EMOJI_SET = [
  "🔗", "📊", "📁", "🛠️", "📚", "🎮", "🏠", "💼",
  "🧠", "⚡", "🌐", "📱", "🎯", "🔧", "📝", "🤖",
];

function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  if (!/^https?:\/\//i.test(v)) return `https://${v}`;
  return v;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Меню со ссылками на другие страницы и проекты. */
export function ProjectsView({ userId }: ProjectsViewProps) {
  const [links, setLinks] = useState<ProjectLink[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectLink | null>(null);
  const [deleting, setDeleting] = useState<ProjectLink | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState(EMOJI_SET[0]);

  const load = useCallback(async () => {
    try {
      setLinks(await api.listLinks(userId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось загрузить ссылки");
      setLinks([]);
    }
  }, [userId]);

  useEffect(() => {
    setLinks(null);
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setTitle("");
    setUrl("");
    setDescription("");
    setIcon(EMOJI_SET[0]);
    setDialogOpen(true);
  };

  const openEdit = (l: ProjectLink) => {
    setEditing(l);
    setTitle(l.title);
    setUrl(l.url);
    setDescription(l.description);
    setIcon(l.icon);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!title.trim() || !url.trim()) {
      toast.error("Заполните название и адрес ссылки");
      return;
    }
    setBusy(true);
    try {
      const normalized = normalizeUrl(url);
      try {
        new URL(normalized);
      } catch {
        toast.error("Некорректный адрес ссылки");
        setBusy(false);
        return;
      }
      const saved = editing
        ? await api.updateLink(editing.id, {
            userId,
            title: title.trim(),
            url: normalized,
            description: description.trim(),
            icon,
          })
        : await api.createLink({
            userId,
            title: title.trim(),
            url: normalized,
            description: description.trim(),
            icon,
          });
      setLinks((list) => {
        const rest = (list ?? []).filter((x) => x.id !== saved.id);
        return [...rest, saved].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      toast.success(editing ? "Ссылка обновлена" : "Ссылка добавлена");
      setDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteLink(deleting.id, userId);
      setLinks((list) => (list ?? []).filter((x) => x.id !== deleting.id));
      toast.success("Ссылка удалена");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const grid = useMemo(() => links ?? [], [links]);

  if (links === null) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-3xl bg-gradient-to-br from-violet-600 to-purple-700 p-4 text-white shadow-lg shadow-purple-900/20">
        <h2 className="text-xl font-bold tracking-tight">Мои проекты</h2>
        <p className="text-sm text-white/80">
          Ссылки на страницы и проекты — добавляйте свои и открывайте в один тап
        </p>
      </div>

      {grid.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed py-12 text-center">
          <span className="text-5xl" aria-hidden="true">
            🧩
          </span>
          <p className="font-medium">Ссылок пока нет</p>
          <p className="max-w-[260px] text-sm text-muted-foreground">
            Добавьте адреса своих проектов, сайтов или часто нужных страниц
          </p>
          <Button onClick={openCreate} className="mt-1 rounded-full">
            <Plus className="h-4 w-4" /> Добавить ссылку
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {grid.map((l) => (
            <li key={l.id}>
              <div className="group relative flex h-full flex-col rounded-2xl border bg-card p-4 shadow-sm transition-all hover:shadow-md">
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-2xl"
                    aria-hidden="true"
                  >
                    {l.icon || "🔗"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{l.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{hostOf(l.url)}</p>
                  </div>
                </div>
                {l.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{l.description}</p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
                    aria-label={`Открыть ${l.title} в новой вкладке`}
                  >
                    <ExternalLink className="h-4 w-4" /> Открыть
                  </a>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-xl"
                    onClick={() => openEdit(l)}
                    aria-label={`Редактировать ${l.title}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleting(l)}
                    aria-label={`Удалить ${l.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {grid.length > 0 && (
        <Button onClick={openCreate} variant="outline" className="rounded-2xl border-dashed">
          <Plus className="h-4 w-4" /> Добавить ссылку
        </Button>
      )}

      {/* Диалог создания/редактирования ссылки */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Редактировать ссылку" : "Новая ссылка"}</DialogTitle>
            <DialogDescription>
              Ссылка на страницу проекта, сайт или любой полезный ресурс
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Значок</Label>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Значок ссылки">
                {EMOJI_SET.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={icon === e}
                    onClick={() => setIcon(e)}
                    className={cn(
                      "flex h-10 w-10 items-center justify-center rounded-xl text-xl transition-colors",
                      icon === e ? "bg-primary/15 ring-2 ring-primary" : "hover:bg-muted"
                    )}
                    aria-label={`Значок ${e}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-title">Название *</Label>
              <Input
                id="link-title"
                placeholder="Например, Дашборд аналитики"
                value={title}
                maxLength={80}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus={!editing}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-url">Адрес (URL) *</Label>
              <Input
                id="link-url"
                inputMode="url"
                placeholder="example.com/my-project"
                value={url}
                maxLength={500}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-desc">Описание</Label>
              <Textarea
                id="link-desc"
                placeholder="Короткое описание, чтобы не забыть, что внутри"
                value={description}
                maxLength={200}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={busy}>
              Отмена
            </Button>
            <Button onClick={save} disabled={busy || !title.trim() || !url.trim()} className="rounded-2xl">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Подтверждение удаления */}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить ссылку?</AlertDialogTitle>
            <AlertDialogDescription>
              «{deleting?.title}» ({deleting ? hostOf(deleting.url) : ""}) будет удалена из меню.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
