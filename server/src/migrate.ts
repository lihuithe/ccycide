import { createKnex } from './db/knex.js';

/** 执行数据库迁移。只需要 MYSQL_URL，不依赖其他配置。STORE=memory 时无事可做。 */
async function main(): Promise<void> {
  if ((process.env.STORE ?? '').toLowerCase() === 'memory') {
    console.log('STORE=memory：使用内存存储，无需迁移');
    return;
  }
  const url = process.env.MYSQL_URL;
  if (!url) {
    console.error('缺少环境变量 MYSQL_URL（格式 mysql://用户:密码@主机:3306/库名）');
    process.exit(1);
  }
  const db = createKnex(url);
  try {
    const [batch, files] = (await db.migrate.latest()) as [number, string[]];
    if (files.length === 0) console.log('没有新的迁移，数据库已是最新');
    else console.log(`迁移批次 ${batch}，执行了：`, files);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('迁移失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
