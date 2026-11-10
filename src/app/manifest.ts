import type { MetadataRoute } from "next";

// требуется для статического экспорта (GitHub Pages)
export const dynamic = "force-static";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ежедневник — дела и проекты",
    short_name: "Ежедневник",
    description:
      "Личный ежедневник с напоминаниями и меню проектов. Данные хранятся на устройстве, поддерживается несколько профилей.",
    id: `${BASE}/`,
    start_url: `${BASE}/`,
    scope: `${BASE}/`,
    display: "standalone",
    orientation: "portrait",
    lang: "ru",
    background_color: "#f8fafc",
    theme_color: "#0d9488",
    icons: [
      { src: `${BASE}/icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${BASE}/icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: `${BASE}/icons/icon-512-maskable.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
