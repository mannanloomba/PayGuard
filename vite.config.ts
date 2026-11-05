import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '.', '')
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': environment.PAYGUARD_BACKEND_URL || 'http://127.0.0.1:8000',
      },
    },
  }
})
