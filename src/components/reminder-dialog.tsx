"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { PRIORITY_META } from "@/lib/client-consts";
import type { Priority, Reminder } from "@/lib/types";
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

interface ReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Если задано — режим редактирования */
  reminder: Reminder | null;
  defaultDate: string;
  userId: string;
  onSaved: (reminder: Reminder) => void;
  onDeleted: (id: string) => void;
}

/** Диалог создания/редактирования напоминания. */
export function ReminderDialog({
  open,
  onOpenChange,
  reminder,
  defaultDate,
  userId,
  onSaved,
  onDeleted,
}: ReminderDialogProps) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(reminder?.title ?? "");
      setNote(reminder?.note ?? "");
      setDate(reminder?.date ?? defaultDate);
      setTime(reminder?.time ?? "");
      setPriority(reminder?.priority ?? "normal");
      setConfirmDelete(false);
    }
  }, [open, reminder, defaultDate]);

  const save = async () => {
    if (!title.trim()) {
      toast.error("Введите название дела");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        userId,
        title: title.trim(),
        note: note.trim(),
        date,
        time: time || null,
        priority,
      };
      const saved = reminder
        ? await api.updateReminder(reminder.id, payload)
        : await api.createReminder(payload);
      onSaved(saved);
      toast.success(reminder ? "Напоминание обновлено" : "Напоминание добавлено");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!reminder) return;
    setSaving(true);
    try {
      await api.deleteReminder(reminder.id, userId);
      onDeleted(reminder.id);
      toast.success("Напоминание удалено");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>{reminder ? "Редактировать дело" : "Новое напоминание"}</DialogTitle>
            <DialogDescription>
              {reminder ? "Измените поля и сохраните" : "Что нужно не забыть?"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rem-title">Название *</Label>
              <Input
                id="rem-title"
                placeholder="Например, позвонить в банк"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus={!reminder}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="rem-date">Дата *</Label>
                <Input
                  id="rem-date"
                  type="date"
                  value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="rem-time">Время</Label>
                <Input id="rem-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Приоритет</Label>
              <div className="flex gap-2" role="radiogroup" aria-label="Приоритет">
                {(Object.keys(PRIORITY_META) as Priority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={priority === p}
                    onClick={() => setPriority(p)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                      priority === p
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <span className={cn("h-2 w-2 rounded-full", PRIORITY_META[p].dot)} />
                    {PRIORITY_META[p].label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="rem-note">Заметка</Label>
              <Textarea
                id="rem-note"
                placeholder="Детали, адрес, телефон…"
                value={note}
                maxLength={2000}
                rows={3}
                onChange={(e) => setNote(e.target.value)}
                className="resize-none"
              />
            </div>
          </div>

          <DialogFooter className={cn("gap-2 sm:justify-between", !reminder && "sm:justify-end")}>
            {reminder && (
              <Button
                variant="destructive"
                className="rounded-2xl"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                <Trash2 className="h-4 w-4" /> Удалить
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
                Отмена
              </Button>
              <Button onClick={save} disabled={saving || !title.trim()} className="rounded-2xl">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Сохранить
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Подтверждение удаления */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить напоминание?</AlertDialogTitle>
            <AlertDialogDescription>
              «{reminder?.title}» будет удалено безвозвратно. Это действие нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={saving}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
