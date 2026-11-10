"use client";

import { useEffect, useState } from "react";

/**
 * Регистрирует service worker и отслеживает режим standalone (iOS:
 * «На экран Домой»). Возвращает true, когда приложение запущено как
 * установленное PWA.
 */
export function usePwa(): { standalone: boolean; isIos: boolean } {
  const [standalone, setStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const nav = navigator as Navigator & { standalone?: boolean };
    const update = () => setStandalone(mq.matches || nav.standalone === true);

    const t = setTimeout(() => {
      const ios =
        /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      setIsIos(ios);
      update();
    }, 0);
    mq.addEventListener?.("change", update);

    if ("serviceWorker" in navigator) {
      // путь учитывает basePath (GitHub Pages: /pwa/sw.js)
      const swUrl = process.env.NEXT_PUBLIC_SW_PATH || "/sw.js";
      navigator.serviceWorker.register(swUrl).catch(() => undefined);
    }

    return () => {
      clearTimeout(t);
      mq.removeEventListener?.("change", update);
    };
  }, []);

  return { standalone, isIos };
}
