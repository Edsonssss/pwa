"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { PRIORITY_META } from "@/lib/client-consts";
import type { Reminder } from "@/lib/types";
import {
  addDaysISO,
  daysBetween,
  fullDateTitle,
  isPastDate,
  monthYearTitle,
  parseISODate,
  pluralize,
  relativeDayLabel,
  todayISO,
  weekdayShort,
} from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ReminderDialog } from "./reminder-dialog";

interface PlannerViewProps {
  userId: string;
}

const RANGE_BEFORE = 7;
const RANGE_AFTER = 21;

export function PlannerView({ userId }: PlannerViewProps) {
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [mode, setMode] = useState<"day" | "all">("day");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setReminders(await api.listReminders(userId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось загрузить данные");
      setReminders([]);
    }
  }, [userId]);

  useEffect(() => {
    setReminders(null);
    void load();
  }, [load]);

  /* Автопрокрутка ленты дней к выбранному дню (после загрузки и при смене режима) */
  const loaded = reminders !== null;
  useEffect(() => {
    if (!loaded) return;
    const el = stripRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [mode, loaded]);

  const stripDays = useMemo(() => {
    const base = todayISO();
    const days: string[] = [];
    for (let i = -RANGE_BEFORE; i <= RANGE_AFTER; i++) days.push(addDaysISO(base, i));
    return days;
  }, []);

  const dayCounts = useMemo(() => {
    const map = new Map<string, { total: number; done: number }>();
    for (const r of reminders ?? []) {
      const c = map.get(r.date) ?? { total: 0, done: 0 };
      c.total++;
      if (r.completed) c.done++;
      map.set(r.date, c);
    }
    return map;
  }, [reminders]);

  const sorted = useMemo(
    () =>
      [...(reminders ?? [])].sort((a, b) =>
        (a.date + (a.time ?? "~")).localeCompare(b.date + (b.time ?? "~"))
      ),
    [reminders]
  );

  const dayItems = useMemo(() => sorted.filter((r) => r.date === selectedDate), [sorted, selectedDate]);
  const active = dayItems.filter((r) => !r.completed);
  const done = dayItems.filter((r) => r.completed);
  const dayStats = dayCounts.get(selectedDate) ?? { total: 0, done: 0 };

  const shiftDate = (delta: number) => {
    setSelectedDate((d) => addDaysISO(d, delta));
  };

  const toggleComplete = async (r: Reminder) => {
    setToggling(r.id);
    const next = !r.completed;
    // оптимистичное обновление
    setReminders((list) =>
      (list ?? []).map((x) =>
        x.id === r.id ? { ...x, completed: next, completedAt: next ? new Date().toISOString() : null } : x
      )
    );
    try {
      const updated = await api.updateReminder(r.id, { userId, completed: next });
      setReminders((list) => (list ?? []).map((x) => (x.id === updated.id ? updated : x)));
      toast.success(next ? "Выполнено ✅" : "Снова в работе");
    } catch (e) {
      setReminders((list) => (list ?? []).map((x) => (x.id === r.id ? r : x)));
      toast.error(e instanceof Error ? e.message : "Не удалось обновить");
    } finally {
      setToggling(null);
    }
  };

  const onSaved = (r: Reminder) => {
    setReminders((list) => {
      const rest = (list ?? []).filter((x) => x.id !== r.id);
      return [...rest, r];
    });
  };

  const onDeleted = (id: string) => {
    setReminders((list) => (list ?? []).filter((x) => x.id !== id));
  };

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (r: Reminder) => {
    setEditing(r);
    setDialogOpen(true);
  };

  if (reminders === null) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Заголовок месяца + прогресс дня */}
      <div className="rounded-3xl bg-gradient-to-br from-teal-600 to-emerald-700 p-4 text-white shadow-lg shadow-teal-900/20">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm/5 text-white/80">{fullDateTitle(selectedDate)}</p>
            <h2 className="text-xl font-bold tracking-tight">{monthYearTitle(selectedDate)}</h2>
          </div>
          <Badge variant="secondary" className="rounded-full bg-white/15 text-white hover:bg-white/25">
            {dayStats.total > 0
              ? `${dayStats.done} из ${dayStats.total} ${pluralize(dayStats.total, "дела", "дел", "дел")}`
              : "Нет дел"}
          </Badge>
        </div>
        {dayStats.total > 0 && (
          <div className="mt-3">
            <Progress
              value={(dayStats.done / dayStats.total) * 100}
              className="h-2 bg-white/20 [&>div]:bg-white"
              aria-label={`Выполнено ${dayStats.done} из ${dayStats.total}`}
            />
          </div>
        )}
      </div>

      {/* Лента дней */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-full"
          onClick={() => shiftDate(-1)}
          aria-label="Предыдущий день"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div ref={stripRef} className="no-scrollbar flex flex-1 gap-1.5 overflow-x-auto scroll-smooth px-1 py-1">
          {stripDays.map((d) => {
            const selected = d === selectedDate;
            const isToday = d === todayISO();
            const count = dayCounts.get(d);
            return (
              <button
                key={d}
                type="button"
                data-selected={selected}
                onClick={() => setSelectedDate(d)}
                aria-pressed={selected}
                className={cn(
                  "flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-2xl py-2 transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <span className="text-[11px] leading-none">{weekdayShort(d)}</span>
                <span className={cn("text-lg font-semibold leading-6", isToday && !selected && "text-primary")}>
                  {parseISODate(d).getDate()}
                </span>
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    count && count.done === count.total && count.total > 0
                      ? "bg-emerald-500"
                      : count
                        ? "bg-amber-400"
                        : selected
                          ? "bg-white/40"
                          : "bg-transparent"
                  )}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-full"
          onClick={() => shiftDate(1)}
          aria-label="Следующий день"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      {/* Переключатель День / Все */}
      <div className="flex rounded-2xl bg-muted p-1" role="tablist" aria-label="Режим просмотра">
        {(
          [
            { key: "day", label: "День" },
            { key: "all", label: "Все дела" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={mode === t.key}
            onClick={() => setMode(t.key)}
            className={cn(
              "flex-1 rounded-xl py-1.5 text-sm font-medium transition-all",
              mode === t.key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Список дел */}
      {mode === "day" ? (
        <DayList
          active={active}
          done={done}
          selectedDate={selectedDate}
          onToggle={toggleComplete}
          onEdit={openEdit}
          toggling={toggling}
          onCreate={openCreate}
        />
      ) : (
        <AllList
          items={sorted}
          onToggle={toggleComplete}
          onEdit={openEdit}
          toggling={toggling}
          onCreate={openCreate}
        />
      )}

      {/* Кнопка «+» над таб-баром (выровнена по колонке контента) */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+78px)] z-40 mx-auto max-w-lg">
        <button
          type="button"
          onClick={openCreate}
          aria-label="Добавить напоминание"
          className="pointer-events-auto mr-5 flex ml-auto h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl shadow-teal-900/30 transition-transform hover:scale-105 active:scale-95"
        >
          <Plus className="h-6 w-6" />
        </button>
      </div>

      <ReminderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        reminder={editing}
        defaultDate={selectedDate}
        userId={userId}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    </div>
  );
}

/* --------------------------------- подвиды -------------------------------- */

interface ItemHandlers {
  onToggle: (r: Reminder) => void;
  onEdit: (r: Reminder) => void;
  toggling: string | null;
  onCreate: () => void;
}

function ReminderCard({ r, onToggle, onEdit, toggling }: { r: Reminder } & ItemHandlers) {
  const overdue = !r.completed && isPastDate(r.date);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onEdit(r)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit(r);
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-2xl border bg-card p-3.5 text-left shadow-sm transition-all hover:shadow-md active:scale-[0.99]",
        r.completed && "opacity-60",
        overdue && "border-destructive/40 bg-destructive/5"
      )}
    >
      <Checkbox
        checked={r.completed}
        onCheckedChange={() => onToggle(r)}
        onClick={(e) => e.stopPropagation()}
        disabled={toggling === r.id}
        aria-label={r.completed ? "Отменить выполнение" : "Пометить выполненным"}
        className="mt-0.5 h-6 w-6 rounded-full data-[state=checked]:bg-primary data-[state=checked]:border-primary"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("font-medium leading-snug", r.completed && "line-through decoration-2")}>
            {r.title}
          </span>
          {overdue && (
            <Badge variant="destructive" className="rounded-full px-2 py-0 text-[11px]">
              Просрочено
            </Badge>
          )}
        </div>
        {r.note && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{r.note}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {r.time ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> {r.time}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" /> Без времени
            </span>
          )}
          <span className={cn("inline-flex items-center gap-1.5", r.priority === "high" && "font-medium text-rose-600 dark:text-rose-400")}>
            <span className={cn("h-2 w-2 rounded-full", PRIORITY_META[r.priority].dot)} />
            {PRIORITY_META[r.priority].label}
          </span>
          {overdue && daysBetween(r.date, todayISO()) > 0 && (
            <span className="text-destructive">
              {relativeDayLabel(r.date).toLowerCase()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed py-12 text-center">
      <span className="text-5xl" aria-hidden="true">
        🗓️
      </span>
      <p className="font-medium">На этот день дел нет</p>
      <p className="max-w-[240px] text-sm text-muted-foreground">
        Добавьте первое напоминание — оно сохранится на устройстве
      </p>
      <Button onClick={onCreate} className="mt-1 rounded-full">
        <Plus className="h-4 w-4" /> Добавить дело
      </Button>
    </div>
  );
}

function DayList({
  active,
  done,
  selectedDate,
  onToggle,
  onEdit,
  toggling,
  onCreate,
}: ItemHandlers & {
  active: Reminder[];
  done: Reminder[];
  selectedDate: string;
}) {
  if (active.length === 0 && done.length === 0) {
    return <EmptyState onCreate={onCreate} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {active.length > 0 && (
        <>
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            В работе · {active.length}
          </p>
          {active.map((r) => (
            <ReminderCard key={r.id} r={r} onToggle={onToggle} onEdit={onEdit} toggling={toggling} onCreate={onCreate} />
          ))}
        </>
      )}
      {done.length > 0 && (
        <>
          <p className="mt-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Выполнено · {done.length}
          </p>
          {done.map((r) => (
            <ReminderCard key={r.id} r={r} onToggle={onToggle} onEdit={onEdit} toggling={toggling} onCreate={onCreate} />
          ))}
        </>
      )}
    </div>
  );
}

function AllList({ items, onToggle, onEdit, toggling, onCreate }: ItemHandlers & { items: Reminder[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, Reminder[]>();
    for (const r of items) {
      const arr = map.get(r.date) ?? [];
      arr.push(r);
      map.set(r.date, arr);
    }
    return [...map.entries()];
  }, [items]);

  if (groups.length === 0) {
    return <EmptyState onCreate={onCreate} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map(([date, list]) => {
        const past = isPastDate(date);
        return (
          <div key={date} className="flex flex-col gap-2">
            <p
              className={cn(
                "flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide",
                past && list.some((r) => !r.completed) ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {relativeDayLabel(date)}
              <span className="font-normal normal-case">
                · {list.filter((r) => !r.completed).length} {pluralize(list.filter((r) => !r.completed).length, "активное", "активных", "активных")}
              </span>
            </p>
            {list.map((r) => (
              <ReminderCard key={r.id} r={r} onToggle={onToggle} onEdit={onEdit} toggling={toggling} onCreate={onCreate} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
