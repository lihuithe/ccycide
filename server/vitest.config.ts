import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 测试里有真实计时的用例（5s/10s/15s 超时），各文件并行跑以缩短总时长
    pool: 'forks',
  },
});
