"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  CloudOff,
  Layers,
  Loader2,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
  bootSync,
  flushSync,
  getSyncStatus,
  initDataSync,
  subscribeSyncStatus,
} from "@/lib/endpoint-sync";
import { refreshPushTimezone } from "@/lib/push-client";
import type { PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { usePwa } from "@/hooks/use-pwa";
import { UserAvatar } from "./user-avatar";
import { UserGate } from "./user-gate";
import { PlannerView } from "./planner-view";
import { ProjectsView } from "./projects-view";
import { SettingsView } from "./settings-view";

const STORAGE_KEY = "planner.currentUserId";

type Tab = "planner" | "projects" | "settings";

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "planner", label: "План", icon: <CalendarCheck2 className="h-6 w-6" /> },
  { key: "projects", label: "Проекты", icon: <Layers className="h-6 w-6" /> },
  { key: "settings", label: "Ещё", icon: <Settings2 className="h-6 w-6" /> },
];

const TAB_TITLES: Record<Tab, string> = {
  planner: "Ежедневник",
  projects: "Проекты",
  settings: "Настройки",
};

/** Корневой клиентский компонент: сессия, шапка, таб-бар и переключение экранов. */
export function AppRoot() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>("planner");
  const { standalone, isIos } = usePwa();
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);

  /* Автосинхронизация: подписка на изменения и отправка при закрытии приложения */
  useEffect(() => initDataSync(), []);
  useEffect(() => {
    const onHide = () => flushSync();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /* Автовход по сохранённому профилю (+ предварительная синхронизация с GitHub) */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // подтягиваем свежие данные из папки сайта до первого рендера
        await Promise.race([
          bootSync(),
          new Promise((resolve) => setTimeout(resolve, 9000)),
        ]);
      } catch {
        // ошибка уже отражена в статусе синхронизации
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        if (!cancelled) setBooting(false);
        return;
      }
      try {
        const u = await api.getUser(stored);
        if (!cancelled) setUser(u);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = useCallback((u: PublicUser) => {
    localStorage.setItem(STORAGE_KEY, u.id);
    setUser(u);
    setTab("planner");
    toast.success(`Добро пожаловать, ${u.name}!`);
  }, []);

  /* Фоновое обновление push-подписки: профиль и часовой пояс устройства */
  useEffect(() => {
    if (user) void refreshPushTimezone(user);
  }, [user]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const handleUserUpdated = useCallback((u: PublicUser) => {
    setUser(u);
  }, []);

  if (booting) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background pt-safe pb-safe">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <UserGate onLogin={handleLogin} />;
  }

  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-background">
      {/* Шапка */}
      <header className="pt-safe sticky top-0 z-30 border-b bg-background/80 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight">{TAB_TITLES[tab]}</h1>
            <p className="text-xs text-muted-foreground">
              {standalone
                ? "Установленное приложение"
                : "PWA · данные на устройстве + синхронизация с сервером"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Индикатор синхронизации (виден, когда она настроена) */}
            {syncStatus.configured && (
              <button
                type="button"
                onClick={() => setTab("settings")}
                className="rounded-full p-1.5 transition-colors hover:bg-muted"
                aria-label={`Синхронизация с сервером: ${syncStatus.message}`}
                title={`Синхронизация: ${syncStatus.message}`}
              >
                {syncStatus.state === "syncing" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                {syncStatus.state === "ok" && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                )}
                {syncStatus.state === "error" && (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                )}
                {syncStatus.state === "idle" && (
                  <CloudOff className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setTab("settings")}
              className="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 shadow-sm transition-colors hover:bg-muted"
              aria-label={`Профиль ${user.name}, перейти к настройкам`}
            >
              <UserAvatar name={user.name} color={user.color} size="sm" />
              <span className="max-w-[110px] truncate text-sm font-medium">{user.name}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Контент */}
      <main className="flex-1 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+88px)] pt-4">
        {tab === "planner" && <PlannerView userId={user.id} />}
        {tab === "projects" && <ProjectsView userId={user.id} />}
        {tab === "settings" && (
          <SettingsView
            user={user}
            onUserUpdated={handleUserUpdated}
            onLogout={handleLogout}
            onSwitchUser={handleLogin}
            standalone={standalone}
            isIos={isIos}
          />
        )}
      </main>

      {/* Нижний таб-бар (iOS-стиль) */}
      <nav
        aria-label="Основная навигация"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t bg-background/85 backdrop-blur-xl"
      >
        <div className="mx-auto flex max-w-lg items-stretch justify-around">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 transition-colors",
                tab === t.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.icon}
              <span className="text-[11px] font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
