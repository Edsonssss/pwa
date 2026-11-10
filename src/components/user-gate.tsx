"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { USER_COLORS_CLIENT } from "@/lib/client-consts";
import type { PublicUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PinPad } from "./pin-pad";
import { UserAvatar } from "./user-avatar";

const COLORS = USER_COLORS_CLIENT;

interface UserGateProps {
  onLogin: (user: PublicUser) => void;
}

/** Экран выбора/создания профиля — поддерживает несколько пользователей. */
export function UserGate({ onLogin }: UserGateProps) {
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [pinUser, setPinUser] = useState<PublicUser | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [newPin, setNewPin] = useState("");
  const [saving, setSaving] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось загрузить профили");
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const openUser = (u: PublicUser) => {
    if (u.hasPin) {
      setPinUser(u);
      setPinError(null);
    } else {
      void finishLogin(u.id, "");
    }
  };

  const finishLogin = async (userId: string, pinCode: string) => {
    setChecking(true);
    try {
      const user = await api.login(userId, pinCode);
      onLogin(user);
    } catch (e) {
      setPinError(e instanceof Error ? e.message : "Ошибка входа");
    } finally {
      setChecking(false);
    }
  };

  const submitPin = async (code: string) => {
    if (!pinUser || checking) return;
    setPinError(null);
    setChecking(true);
    try {
      const user = await api.login(pinUser.id, code);
      onLogin(user);
    } catch (e) {
      setPinError(e instanceof Error ? e.message : "Ошибка входа");
      setChecking(false);
    }
  };

  const createProfile = async () => {
    if (!name.trim()) {
      toast.error("Введите имя профиля");
      return;
    }
    if (newPin && !/^\d{4}$/.test(newPin)) {
      toast.error("PIN-код должен состоять из 4 цифр");
      return;
    }
    setSaving(true);
    try {
      const user = await api.createUser(name.trim(), color, newPin || undefined);
      toast.success(`Профиль «${user.name}» создан`);
      setCreateOpen(false);
      onLogin(user);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось создать профиль");
    } finally {
      setSaving(false);
    }
  };

  const resetCreate = () => {
    setName("");
    setColor(COLORS[0]);
    setNewPin("");
    setSaving(false);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-teal-700 via-teal-800 to-slate-900 px-4 pt-safe pb-safe">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 py-10">
        {/* Логотип */}
        <div className="flex flex-col items-center gap-3 text-white">
          <div className="flex h-24 w-24 items-center justify-center rounded-[28px] bg-gradient-to-b from-teal-500 to-emerald-700 shadow-2xl shadow-black/30">
            <span className="text-5xl" role="img" aria-label="Ежедневник">
              ✅
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Ежедневник</h1>
          <p className="text-center text-sm text-white/70">
            Напоминания и проекты — прямо на этом устройстве
          </p>
        </div>

        {/* Список профилей */}
        <div className="w-full rounded-3xl bg-white/95 p-4 shadow-xl shadow-black/20 dark:bg-card/95">
          <p className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Кто сегодня планирует?
          </p>
          {users === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : users.length === 0 ? (
            <p className="px-1 py-4 text-center text-sm text-muted-foreground">
              Пока нет ни одного профиля — создайте первый
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {users.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => openUser(u)}
                    className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-colors hover:bg-muted active:bg-muted"
                  >
                    <UserAvatar name={u.name} color={u.color} size="lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{u.name}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {u.hasPin ? (
                          <>
                            <ShieldCheck className="h-3 w-3" /> Защищён PIN-кодом
                          </>
                        ) : (
                          "Войти без кода"
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Button
            onClick={() => setCreateOpen(true)}
            variant="outline"
            className="mt-3 w-full rounded-2xl border-dashed"
          >
            <Plus className="h-4 w-4" /> Новый профиль
          </Button>
        </div>

        <p className="text-center text-xs text-white/50">
          Данные каждого профиля хранятся на устройстве отдельно
        </p>
      </div>

      {/* Ввод PIN */}
      <Dialog open={!!pinUser} onOpenChange={(open) => !open && setPinUser(null)}>
        <DialogContent className="max-w-xs rounded-3xl">
          <DialogHeader className="items-center text-center">
            <DialogTitle className="flex flex-col items-center gap-2">
              <UserAvatar name={pinUser?.name ?? "?"} color={pinUser?.color ?? "#0d9488"} size="lg" />
              Введите PIN-код
            </DialogTitle>
            <DialogDescription>Профиль «{pinUser?.name}»</DialogDescription>
          </DialogHeader>
          <PinPad key={pinUser?.id ?? "pin"} onComplete={submitPin} disabled={checking} error={pinError} />
        </DialogContent>
      </Dialog>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreate();
        }}
      >
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>Новый профиль</DialogTitle>
            <DialogDescription>
              Профиль нужен, чтобы у каждого были свои напоминания и ссылки
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="gate-name">Имя</Label>
              <Input
                id="gate-name"
                placeholder="Например, Анна"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Цвет</Label>
              <div className="flex gap-2" role="radiogroup" aria-label="Цвет профиля">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={color === c}
                    onClick={() => setColor(c)}
                    className={cn(
                      "h-9 w-9 rounded-full transition-transform",
                      color === c ? "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:scale-105"
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`Цвет ${c}`}
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="gate-pin">PIN-код (необязательно)</Label>
              <Input
                id="gate-pin"
                inputMode="numeric"
                placeholder="4 цифры — защита профиля"
                value={newPin}
                maxLength={4}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={createProfile} disabled={saving || !name.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />}
              Создать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
