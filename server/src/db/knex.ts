import knexLib, { type Knex } from 'knex';
import path from 'node:path';

/** 迁移文件所在目录。tsx 直接跑 src 时是 .ts，编译成 dist 后是 .js */
const here = import.meta.dirname;
const ext = path.extname(import.meta.filename); // .ts 或 .js

export function migrationConfig(): Knex.MigratorConfig {
  return {
    directory: path.join(here, 'migrations'),
    loadExtensions: [ext],
    tableName: 'knex_migrations',
  };
}

/** 把 mysql://user:pass@host:3306/db 解析成 knex 的连接配置，并统一用 UTC */
export function createKnex(mysqlUrl: string): Knex {
  let u: URL;
  try {
    u = new URL(mysqlUrl);
  } catch {
    throw new Error('MYSQL_URL 格式不正确，应为 mysql://用户:密码@主机:3306/库名');
  }
  if (u.protocol !== 'mysql:') throw new Error('MYSQL_URL 必须以 mysql:// 开头');
  return knexLib({
    client: 'mysql2',
    connection: {
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      charset: 'utf8mb4',
      // 时间一律存取 UTC
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: false,
      connectTimeout: 10_000,
    },
    pool: {
      min: 0,
      max: 10,
      acquireTimeoutMillis: 10_000,
      // 会话时区固定为 UTC：DEFAULT CURRENT_TIMESTAMP(3) 用的是会话时区，不设的话取决于数据库服务器的时区配置
      afterCreate: (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) => {
        conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
      },
    },
    migrations: migrationConfig(),
  });
}
