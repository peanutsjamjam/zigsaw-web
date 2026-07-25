import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // 相対ベース。生成アセットを index.html からの相対パスで参照するため、
  // 同じビルド成果物が dev(/~sugawara/zigsaw/) でも本番(サブドメイン直下 /) でも動く。
  // （配信パスに依存しないので、環境ごとのビルド切替が不要）
  base: './',
  plugins: [react()],
})
