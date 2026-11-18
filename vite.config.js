import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite' //allows tailwind

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In local dev the frontend (5173) and backend (8000) are different
    // origins, so relative /api calls need to be proxied to FastAPI.
    // In production, FastAPI serves the built frontend itself (see
    // server/main.py's SPA fallback), so this proxy isn't needed there.
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
      "/static": "http://127.0.0.1:8000",
    },
    open: true, // keeps auto-open behavior
  },
})
