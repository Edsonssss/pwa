"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  Apple,
  Bell,
  BellOff,
  BellRing,
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Loader2,
  LogOut,
  Moon,
  Pencil,
  ShieldCheck,
  Smartphone,
  Sun,
  SunMoon,
  Trash2,
  Upload,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { exportAll, importAll } from "@/lib/local-store";
import {
  getSyncStatus,
  loadSyncConfig,
  pullFromServer,
  pushToServer,
  saveSyncConfig,
  subscribeSyncStatus,
  testConnection,
  type SyncConfig,
} from "@/lib/endpoint-sync";
import {
  disablePush,
  enablePush,
  getPushSnapshot,
  type PushSnapshot,
} from "@/lib/push-client";
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./user-avatar";
import { PinPad } from "./pin-pad";

interface SettingsViewProps {
  user: PublicUser;
  onUserUpdated: (u: PublicUser) => void;
  onLogout: () => void;
  onSwitchUser: (u: PublicUser) => void;
  standalone: boolean;
  isIos: boolean;
}

const COLORS = USER_COLORS_CLIENT;

type ThemeMode = "system" | "light" | "dark";

export function SettingsView({
  user,
  onUserUpdated,
  onLogout,
  onSwitchUser,
  standalone,
  isIos,
}: SettingsViewProps) {
  const { theme, setTheme } = useTheme();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [mounted, setMounted] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [pinInput, setPinInput] = useState("");
  const [saving, setSaving] = useState(false);

  const [pinTarget, setPinTarget] = useState<PublicUser | null>(null); // профиль, требующий PIN
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<unknown>(null);
  const [importConfirm, setImportConfirm] = useState(false);
  const [importing, setImporting] = useState(false);

  /* ------------------------------ синхронизация ------------------------------ */
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
  const [syncForm, setSyncForm] = useState<SyncConfig | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [syncSaving, setSyncSaving] = useState(false);
  const [syncPulling, setSyncPulling] = useState(false);
  const [syncPushing, setSyncPushing] = useState(false);
  const [pullConfirm, setPullConfirm] = useState(false);

  /* --------------------------------- push ---------------------------------- */
  const [pushSnap, setPushSnap] = useState<PushSnapshot | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  const refreshPush = useCallback(async () => {
    try {
      setPushSnap(await getPushSnapshot());
    } catch {
      // снимок второстепенен — не мешает работе настроек
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch {
      // тихо: список профилей второстепенен
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    setSyncForm(loadSyncConfig());
    void loadUsers();
    void refreshPush();
  }, [loadUsers, refreshPush]);

  useEffect(() => {
    setName(user.name);
    setColor(user.color);
  }, [user]);

  const saveProfile = async () => {
    if (!name.trim()) {
      toast.error("Введите имя");
      return;
    }
    if (pinInput && !/^\d{4}$/.test(pinInput)) {
      toast.error("PIN-код должен состоять из 4 цифр");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateUser(user.id, {
        name: name.trim(),
        color,
        ...(pinInput ? { pin: pinInput } : {}),
      });
      if (updated) {
        onUserUpdated(updated);
      }
      toast.success("Профиль сохранён");
      setEditOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сохранить профиль");
    } finally {
      setSaving(false);
    }
  };

  const trySwitch = (u: PublicUser) => {
    if (u.id === user.id) return;
    if (u.hasPin) {
      setPinTarget(u);
    } else {
      setSwitchingId(u.id);
      void api
        .login(u.id, "")
        .then((logged) => onSwitchUser(logged))
        .catch((e) => toast.error(e instanceof Error ? e.message : "Ошибка входа"))
        .finally(() => setSwitchingId(null));
    }
  };

  const submitPinSwitch = async (pin: string) => {
    if (!pinTarget) return;
    try {
      const logged = await api.login(pinTarget.id, pin);
      onSwitchUser(logged);
      setPinTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка входа");
    }
  };

  const deleteProfile = async () => {
    setSaving(true);
    try {
      await api.deleteUser(user.id);
      toast.success(`Профиль «${user.name}» удалён вместе со всеми данными`);
      onLogout();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось удалить профиль");
    } finally {
      setSaving(false);
      setDeleteConfirm(false);
    }
  };

  /* ---------- экспорт / импорт данных (резервная копия JSON) ---------- */

  const handleExport = useCallback(async () => {
    try {
      const payload = await exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ezhednevnik-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Резервная копия сохранена");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось экспортировать данные");
    }
  }, []);

  const handleFileChosen = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("Файл повреждён");
      setPendingImport(parsed);
      setImportConfirm(true);
    } catch (e) {
      toast.error(
        e instanceof Error && e.message !== "Unexpected token" ? e.message : "Не удалось прочитать файл"
      );
    }
  }, []);

  const confirmImport = useCallback(async () => {
    if (!pendingImport) return;
    setImporting(true);
    try {
      const counts = await importAll(pendingImport);
      toast.success(
        `Импортировано: профилей ${counts.users}, напоминаний ${counts.reminders}, ссылок ${counts.links}`
      );
      // перезагружаем, чтобы вся сессия пересоздалась из новых данных
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось импортировать данные");
      setImporting(false);
      setImportConfirm(false);
    }
  }, [pendingImport]);

  /* ------------------------- действия синхронизации ------------------------- */

  const saveSyncSettings = useCallback(async () => {
    if (!syncForm) return;
    if (!/^https?:\/\//i.test(syncForm.url.trim())) {
      toast.error("Укажите адрес сервера синхронизации (https://…)");
      return;
    }
    setSyncSaving(true);
    try {
      saveSyncConfig({
        url: syncForm.url.trim(),
        key: syncForm.key.trim(),
        auto: syncForm.auto,
      });
      const msg = await testConnection();
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось подключиться к серверу");
    } finally {
      setSyncSaving(false);
    }
  }, [syncForm]);

  const doPull = useCallback(async (force: boolean) => {
    setSyncPulling(true);
    try {
      const result = await pullFromServer({ force });
      if (result === "applied") {
        toast.success("Данные с сервера загружены — обновляем…");
        setTimeout(() => window.location.reload(), 600);
        return;
      }
      if (result === "current") toast.success("Данные актуальны");
      if (result === "missing")
        toast.info("На сервере нет файла данных — отправьте данные кнопкой «Отправить»");
      if (result === "conflict")
        toast.warning("Данные есть и на сервере, и на устройстве — выберите действие вручную");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка загрузки данных");
    } finally {
      setSyncPulling(false);
      setPullConfirm(false);
    }
  }, []);

  const requestPull = useCallback(() => {
    if (syncStatus.dirty) {
      setPullConfirm(true);
      return;
    }
    void doPull(false);
  }, [syncStatus.dirty, doPull]);

  const doPush = useCallback(async () => {
    setSyncPushing(true);
    try {
      await pushToServer();
      toast.success("Данные отправлены на сервер");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка отправки данных");
    } finally {
      setSyncPushing(false);
    }
  }, []);

  /* ------------------------------ push-действия ------------------------------ */

  const enablePushNow = useCallback(async () => {
    setPushBusy(true);
    try {
      const res = await enablePush({ id: user.id, name: user.name });
      if (res.ok) {
        toast.success("Уведомления включены — напоминание придёт в назначенное время");
      } else {
        toast.error(res.error);
      }
    } finally {
      await refreshPush();
      setPushBusy(false);
    }
  }, [user.id, user.name, refreshPush]);

  const disablePushNow = useCallback(async () => {
    setPushBusy(true);
    try {
      const res = await disablePush();
      if (res.ok) toast.success("Уведомления выключены на этом устройстве");
      else toast.error(res.error);
    } finally {
      await refreshPush();
      setPushBusy(false);
    }
  }, [refreshPush]);

  const themeOptions: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: "system", label: "Как в системе", icon: <SunMoon className="h-4 w-4" /> },
    { value: "light", label: "Светлая", icon: <Sun className="h-4 w-4" /> },
    { value: "dark", label: "Тёмная", icon: <Moon className="h-4 w-4" /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Профиль */}
      <div className="flex items-center gap-4 rounded-3xl bg-card p-4 shadow-sm border">
        <UserAvatar name={user.name} color={user.color} size="xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{user.name}</p>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            {user.hasPin ? (
              <>
                <ShieldCheck className="h-3.5 w-3.5" /> PIN-код включён
              </>
            ) : (
              "Без PIN-кода"
            )}
          </p>
        </div>
        <Button
          variant="outline"
          className="rounded-2xl"
          onClick={() => {
            setEditOpen(true);
            setPinInput("");
          }}
        >
          <Pencil className="h-4 w-4" /> Изменить
        </Button>
      </div>

      {/* Смена профиля */}
      <section className="rounded-3xl border bg-card shadow-sm" aria-labelledby="switch-title">
        <h3 id="switch-title" className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Сменить профиль
        </h3>
        <ul className="p-2">
          {users
            .filter((u) => u.id !== user.id)
            .map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => trySwitch(u)}
                  disabled={switchingId === u.id}
                  className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <UserAvatar name={u.name} color={u.color} />
                  <span className="flex-1 truncate font-medium">{u.name}</span>
                  {switchingId === u.id ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </li>
            ))}
          {users.filter((u) => u.id !== user.id).length === 0 && (
            <li className="px-2 py-3 text-sm text-muted-foreground">Других профилей пока нет</li>
          )}
        </ul>
        <div className="px-3 pb-3">
          <Button variant="outline" className="w-full rounded-2xl border-dashed" onClick={onLogout}>
            <LogOut className="h-4 w-4" /> Выйти на экран выбора
          </Button>
        </div>
      </section>

      {/* Оформление */}
      <section className="rounded-3xl border bg-card p-4 shadow-sm" aria-labelledby="theme-title">
        <h3 id="theme-title" className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Оформление
        </h3>
        {mounted && (
          <div className="flex rounded-2xl bg-muted p-1" role="radiogroup" aria-label="Тема оформления">
            {themeOptions.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={theme === t.value}
                onClick={() => setTheme(t.value)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium transition-all",
                  theme === t.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Синхронизация с сервером (api.php на хостинге) */}
      <section className="rounded-3xl border bg-card p-4 shadow-sm" aria-labelledby="sync-title">
        <h3 id="sync-title" className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Синхронизация данных
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Данные живут на устройстве и автоматически копируются на сервер — файл api.php в папке
          приложения на хостинге. Так данные переносятся между устройствами.
        </p>

        <div
          className={cn(
            "mb-3 flex items-start gap-2 rounded-2xl p-3 text-sm",
            syncStatus.state === "error" && "bg-rose-500/10 text-rose-700 dark:text-rose-300",
            syncStatus.state === "syncing" && "bg-sky-500/10 text-sky-700 dark:text-sky-300",
            syncStatus.state === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            syncStatus.state === "idle" && "bg-muted text-muted-foreground"
          )}
          role="status"
          aria-live="polite"
        >
          <span className="mt-0.5 shrink-0">
            {syncStatus.state === "syncing" && <Loader2 className="h-4 w-4 animate-spin" />}
            {syncStatus.state === "ok" && <CheckCircle2 className="h-4 w-4" />}
            {syncStatus.state === "error" && <AlertTriangle className="h-4 w-4" />}
            {syncStatus.state === "idle" && <CloudOff className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            {syncStatus.message || "Синхронизация не настроена"}
            {syncStatus.at && (
              <span className="ml-1 whitespace-nowrap opacity-75">
                · {new Date(syncStatus.at).toLocaleString("ru-RU", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
          </span>
        </div>

        {syncStatus.dirty && (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            Есть несохранённые изменения — отправятся на сервер автоматически через несколько секунд.
          </p>
        )}

        {syncForm && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-url">Адрес сервера синхронизации</Label>
              <Input
                id="sync-url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={syncForm.url}
                placeholder="https://ediai.ru/pwa/api.php"
                onChange={(e) => setSyncForm({ ...syncForm, url: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-key">Ключ синхронизации</Label>
              <div className="relative">
                <Input
                  id="sync-key"
                  type={showKey ? "text" : "password"}
                  value={syncForm.key}
                  placeholder="задаётся в api.php (константа SYNC_KEY)"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="pr-10"
                  onChange={(e) => setSyncForm({ ...syncForm, key: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showKey ? "Скрыть ключ" : "Показать ключ"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Ключ — это не секретный токен GitHub: он лишь защищает файл данных от посторонних.
                Адрес и ключ по умолчанию уже вшиты в сборку — менять их нужно только при смене
                сервера или ключа.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-muted/60 p-3">
              <div className="min-w-0 pr-3">
                <p className="text-sm font-medium">Автосинхронизация</p>
                <p className="text-xs text-muted-foreground">
                  Отправлять изменения через несколько секунд после правок и при закрытии приложения
                </p>
              </div>
              <Switch
                checked={syncForm.auto}
                onCheckedChange={(v) => setSyncForm({ ...syncForm, auto: v })}
                aria-label="Автосинхронизация"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-w-[150px] flex-1 rounded-2xl"
                onClick={() => void saveSyncSettings()}
                disabled={syncSaving}
              >
                {syncSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Сохранить и проверить
              </Button>
              <Button variant="outline" className="rounded-2xl" onClick={requestPull} disabled={syncPulling}>
                {syncPulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
                Загрузить
              </Button>
              <Button variant="outline" className="rounded-2xl" onClick={() => void doPush()} disabled={syncPushing}>
                {syncPushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
                Отправить
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Данные хранятся в закрытой папке storage на хостинге (доступ напрямую запрещён
              через .htaccess). Ключ не даёт посторонним читать и перезаписывать файл данных.
            </p>
          </div>
        )}
      </section>

      {/* Push-уведомления о напоминаниях */}
      <section className="rounded-3xl border bg-card p-4 shadow-sm" aria-labelledby="push-title">
        <h3 id="push-title" className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Push-уведомления
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Если у дела указано время, в назначенный момент на это устройство придёт
          системное уведомление — даже когда приложение закрыто. Включите уведомления
          на каждом телефоне, где нужны напоминания.
        </p>

        {!pushSnap ? (
          <div className="flex items-center gap-2 rounded-2xl bg-muted p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Проверяем поддержку устройства…
          </div>
        ) : (
          <>
            {pushSnap.enabled ? (
              <div className="mb-3 flex items-start gap-2 rounded-2xl bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300" role="status">
                <BellRing className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong className="font-semibold">Уведомления включены</strong> — напоминания
                  со временем будут приходить на это устройство.
                </span>
              </div>
            ) : pushSnap.support.permission === "denied" ? (
              <div className="mb-3 flex items-start gap-2 rounded-2xl bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300" role="alert">
                <BellOff className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Разрешение на уведомления отклонено. Включите его: Настройки iPhone →
                  Уведомления → «Ежедневник», затем вернитесь сюда.
                </span>
              </div>
            ) : pushSnap.support.blocker ? (
              <div className="mb-3 flex items-start gap-2 rounded-2xl bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{pushSnap.support.blocker}</span>
              </div>
            ) : (
              <div className="mb-3 flex items-start gap-2 rounded-2xl bg-muted p-3 text-sm text-muted-foreground" role="status">
                <Bell className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Уведомления выключены на этом устройстве</span>
              </div>
            )}

            <div className="flex gap-2">
              {pushSnap.enabled ? (
                <Button
                  variant="outline"
                  className="flex-1 rounded-2xl"
                  onClick={() => void disablePushNow()}
                  disabled={pushBusy}
                >
                  {pushBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellOff className="h-4 w-4" />}
                  Выключить уведомления
                </Button>
              ) : (
                <Button
                  className="flex-1 rounded-2xl"
                  onClick={() => void enablePushNow()}
                  disabled={pushBusy || !!pushSnap.support.blocker || pushSnap.support.permission === "denied"}
                >
                  {pushBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                  Включить уведомления
                </Button>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Требования iPhone: iOS 16.4 или новее, приложение установлено на «Экран Домой»
              (секция ниже), разрешение на уведомления выдано. Срок считается по времени этого
              устройства. Напоминания без времени push не получают.
            </p>
          </>
        )}
      </section>

      {/* Данные: экспорт / импорт */}
      <section className="rounded-3xl border bg-card p-4 shadow-sm" aria-labelledby="data-title">
        <h3 id="data-title" className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Данные
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Основное хранилище — это устройство; при настроенной синхронизации копия автоматически
          уходит на сервер (api.php в папке приложения). Экспорт создаёт резервный JSON-файл вручную —
          им можно перенести данные на новый телефон или поделиться с другим человеком.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 rounded-2xl" onClick={() => void handleExport()}>
            <FileJson className="h-4 w-4" /> Экспорт JSON
          </Button>
          <Button
            variant="outline"
            className="flex-1 rounded-2xl"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4" /> Импорт JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFileChosen(f);
              e.target.value = ""; // позволяем выбрать тот же файл повторно
            }}
          />
        </div>
      </section>

      {/* Установка PWA */}
      <section className="rounded-3xl border bg-card p-4 shadow-sm" aria-labelledby="install-title">
        <h3 id="install-title" className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Установка на iPhone / iPad
        </h3>
        {standalone ? (
          <div className="flex items-center gap-3 rounded-2xl bg-emerald-500/10 p-3 text-emerald-700 dark:text-emerald-300">
            <Smartphone className="h-5 w-5 shrink-0" />
            <p className="text-sm font-medium">Приложение установлено и работает как отдельное</p>
          </div>
        ) : (
          <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
            <li className="flex gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                1
              </span>
              <span>Откройте этот сайт в браузере <strong className="text-foreground">Safari</strong> на iPhone</span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                2
              </span>
              <span>
                Нажмите кнопку <Apple className="inline h-4 w-4 -translate-y-0.5 text-foreground" /> «Поделиться»
                внизу экрана
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                3
              </span>
              <span>
                Выберите <Download className="inline h-4 w-4 -translate-y-0.5 text-foreground" /> «На экран „Домой“»
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                4
              </span>
              <span>Нажмите «Добавить» — иконка появится на главном экране</span>
            </li>
          </ol>
        )}
      </section>

      {/* Опасная зона */}
      <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-4 shadow-sm" aria-labelledby="danger-title">
        <h3 id="danger-title" className="mb-2 text-xs font-semibold uppercase tracking-wide text-destructive">
          Опасная зона
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Удаление профиля сотрёт все его напоминания и ссылки на этом устройстве безвозвратно.
        </p>
        <Button variant="destructive" className="rounded-2xl" onClick={() => setDeleteConfirm(true)}>
          <Trash2 className="h-4 w-4" /> Удалить профиль «{user.name}»
        </Button>
      </section>

      <p className="pb-2 text-center text-xs text-muted-foreground">
        Ежедневник PWA · v2.1 · данные на устройстве + синхронизация с сервером
      </p>

      {/* Диалог редактирования профиля */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="rounded-3xl">
          <DialogHeader>
            <DialogTitle>Настройки профиля</DialogTitle>
            <DialogDescription>Имя, цвет и PIN-код доступа</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="set-name">Имя</Label>
              <Input
                id="set-name"
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
                      color === c
                        ? "scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background"
                        : "hover:scale-105"
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`Цвет ${c}`}
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="set-pin">Новый PIN-код</Label>
              <Input
                id="set-pin"
                inputMode="numeric"
                placeholder={user.hasPin ? "Заменить текущий PIN" : "4 цифры — защита профиля"}
                value={pinInput}
                maxLength={4}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))}
              />
              <p className="text-xs text-muted-foreground">
                Оставьте пустым, чтобы не менять PIN-код
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={saving}>
              Отмена
            </Button>
            <Button onClick={saveProfile} disabled={saving || !name.trim()} className="rounded-2xl">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Подтверждение загрузки с сервера поверх локальных изменений */}
      <AlertDialog open={pullConfirm} onOpenChange={setPullConfirm}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Загрузить данные с сервера?</AlertDialogTitle>
            <AlertDialogDescription>
              На устройстве есть изменения, ещё не отправленные на сервер. Загрузка заменит их данными
              с сервера. Если нужно сохранить локальные изменения — сначала нажмите «Отправить».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncPulling}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doPull(true);
              }}
              disabled={syncPulling}
            >
              {syncPulling && <Loader2 className="h-4 w-4 animate-spin" />}
              Заменить локальные
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Подтверждение импорта данных */}
      <AlertDialog open={importConfirm} onOpenChange={setImportConfirm}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Заменить все данные?</AlertDialogTitle>
            <AlertDialogDescription>
              Импорт заменит ВСЕ профили, напоминания и ссылки на этом устройстве данными из
              выбранного файла. Текущие данные будут потеряны, если они не экспортированы.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmImport();
              }}
              disabled={importing}
            >
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              Заменить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* PIN при переключении профиля */}
      <Dialog open={!!pinTarget} onOpenChange={(open) => !open && setPinTarget(null)}>
        <DialogContent className="max-w-xs rounded-3xl">
          <DialogHeader className="items-center text-center">
            <DialogTitle className="flex flex-col items-center gap-2">
              <UserAvatar name={pinTarget?.name ?? "?"} color={pinTarget?.color ?? "#0d9488"} size="lg" />
              Введите PIN-код
            </DialogTitle>
            <DialogDescription>Профиль «{pinTarget?.name}»</DialogDescription>
          </DialogHeader>
          <PinPad onComplete={submitPinSwitch} />
        </DialogContent>
      </Dialog>

      {/* Подтверждение удаления профиля */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить профиль?</AlertDialogTitle>
            <AlertDialogDescription>
              Все напоминания и ссылки профиля «{user.name}» будут удалены с этого устройства. Это действие
              нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deleteProfile();
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={saving}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
