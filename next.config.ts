import type { NextConfig } from "next";

/**
 * Два режима сборки:
 *  - по умолчанию — обычный dev/standalone для локальной разработки;
 *  - PAGES_BUILD=1 — статический экспорт для GitHub Pages (basePath = /pwa,
 *    т.е. имя репозитория Edsonssss/pwa).
 */
const isPages = process.env.PAGES_BUILD === "1";
const BASE = isPages ? "/pwa" : "";

const nextConfig: NextConfig = {
  ...(isPages
    ? {
        output: "export" as const,
        basePath: BASE,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : { output: "standalone" as const }),
  env: {
    NEXT_PUBLIC_BASE_PATH: BASE,
    NEXT_PUBLIC_SW_PATH: `${BASE}/sw.js`,
    NEXT_PUBLIC_MANIFEST_PATH: `${BASE}/manifest.webmanifest`,
    // Сервер синхронизации по умолчанию (файл api.php в папке приложения на хостинге).
    // Значения можно переопределить переменными окружения при сборке.
    NEXT_PUBLIC_SYNC_URL:
      process.env.NEXT_PUBLIC_SYNC_URL ?? "https://ediai.ru/pwa/api.php",
    NEXT_PUBLIC_SYNC_KEY:
      process.env.NEXT_PUBLIC_SYNC_KEY ?? "5e254577c0cffc3536b691c9368b46ed",
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
