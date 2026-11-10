"use client";

import { useState } from "react";
import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";

interface PinPadProps {
  onComplete: (pin: string) => void;
  disabled?: boolean;
  error?: string | null;
}

/** iOS-подобная цифровая клавиатура для ввода 4-значного PIN-кода. */
export function PinPad({ onComplete, disabled, error }: PinPadProps) {
  const [pin, setPin] = useState("");

  const press = (d: string) => {
    if (disabled || pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) {
      // вызываем ровно один раз на каждую завершённую комбинацию;
      // сброс точек — таймером, который не очищается ререндерами
      onComplete(next);
      window.setTimeout(() => setPin(""), 400);
    }
  };
  const backspace = () => setPin((p) => p.slice(0, -1));

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];

  return (
    <div className="flex flex-col items-center gap-5" role="group" aria-label="Ввод PIN-кода">
      <div className={cn("flex gap-3", error && "animate-pulse")} aria-live="polite">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full border-2 transition-colors",
              pin.length > i ? "border-primary bg-primary" : "border-muted-foreground/40",
              error && "border-destructive"
            )}
          />
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid w-full max-w-[260px] grid-cols-3 gap-3">
        {keys.map((k, idx) =>
          k === "" ? (
            <span key={idx} />
          ) : k === "del" ? (
            <button
              key={idx}
              type="button"
              onClick={backspace}
              disabled={disabled || pin.length === 0}
              aria-label="Удалить цифру"
              className="flex h-14 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted active:bg-muted disabled:opacity-30"
            >
              <Delete className="h-5 w-5" />
            </button>
          ) : (
            <button
              key={idx}
              type="button"
              onClick={() => press(k)}
              disabled={disabled}
              className="h-14 rounded-full bg-muted/70 text-xl font-medium transition-colors hover:bg-muted active:bg-muted disabled:opacity-40"
            >
              {k}
            </button>
          )
        )}
      </div>
    </div>
  );
}
