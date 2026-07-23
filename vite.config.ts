import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const [githubOwner = '', githubRepo = ''] =
  process.env.GITHUB_REPOSITORY?.split('/') ?? []
const githubPagesBase =
  githubRepo && githubRepo.toLowerCase() !== `${githubOwner}.github.io`.toLowerCase()
    ? `/${githubRepo}/`
    : '/'

export default defineConfig({
  base:
    process.env.VITE_BASE_PATH ||
    (process.env.GITHUB_ACTIONS === 'true' ? githubPagesBase : '/'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
