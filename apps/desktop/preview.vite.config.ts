import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const app = '/Users/younes/Documents/wolffish/wolffish-cloud/apps/desktop'
export default defineConfig({
  root: resolve(app, 'src/renderer'),
  resolve: {
    alias: {
      '@main': resolve(app, 'src/main'),
      '@preload': resolve(app, 'src/preload'),
      '@renderer': resolve(app, 'src/renderer/src'),
      '@components': resolve(app, 'src/renderer/src/components'),
      '@hooks': resolve(app, 'src/renderer/src/hooks'),
      '@lib': resolve(app, 'src/renderer/src/lib'),
      '@pages': resolve(app, 'src/renderer/src/pages'),
      '@providers': resolve(app, 'src/renderer/src/providers'),
      '@resources': resolve(app, 'resources')
    }
  },
  server: { port: 5199, fs: { allow: [app] } },
  plugins: [react(), tailwindcss()]
})
