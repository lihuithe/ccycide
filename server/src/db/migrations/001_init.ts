import type { Knex } from 'knex';

/**
 * 建表语句取自《实现方案.md》7.2 节，逐条用 knex.raw 执行（mysql2 默认不允许一次执行多条语句）。
 * 注意：sessions 是分区表，主键必须包含分区列 created_at，不要自行修改主键。
 */
const STATEMENTS: string[] = [
  `CREATE TABLE devices (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_uid    CHAR(26)        NOT NULL COMMENT 'ULID，对外的设备标识',
  device_code   CHAR(9)         NOT NULL COMMENT '9 位数字设备码',
  public_key    BINARY(32)      NOT NULL COMMENT 'Ed25519 公钥',
  kind          VARCHAR(16)     NOT NULL COMMENT 'desktop | cli',
  platform      VARCHAR(16)     NOT NULL COMMENT 'windows | macos | linux',
  arch          VARCHAR(16)     NOT NULL COMMENT 'x86_64 | aarch64',
  os_version    VARCHAR(64)     NOT NULL DEFAULT '',
  app_version   VARCHAR(32)     NOT NULL DEFAULT '',
  status        TINYINT         NOT NULL DEFAULT 0 COMMENT '0 正常 1 封禁',
  register_ip   VARBINARY(16)   NULL,
  last_ip       VARBINARY(16)   NULL,
  last_seen_at  DATETIME(3)     NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_uid (device_uid),
  UNIQUE KEY uk_device_code (device_code),
  UNIQUE KEY uk_public_key (public_key),
  KEY idx_last_seen (last_seen_at),
  KEY idx_register_ip (register_ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备'`,

  `CREATE TABLE sessions (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_uid           CHAR(26)        NOT NULL COMMENT 'ULID',
  controller_device_id  BIGINT UNSIGNED NOT NULL,
  host_device_id        BIGINT UNSIGNED NOT NULL,
  relay_node            VARCHAR(64)     NOT NULL DEFAULT '',
  status                TINYINT         NOT NULL DEFAULT 0
                        COMMENT '0 待接受 1 已接受 2 已配对 3 已认证 4 正常结束 5 失败',
  fail_reason           VARCHAR(32)     NOT NULL DEFAULT ''
                        COMMENT 'rejected | timeout | auth_failed | pair_timeout | ...',
  controller_ip         VARBINARY(16)   NULL,
  host_ip               VARBINARY(16)   NULL,
  bytes_c2h             BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_h2c             BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  authed_at             DATETIME(3)     NULL,
  ended_at              DATETIME(3)     NULL,
  PRIMARY KEY (id, created_at),
  UNIQUE KEY uk_session_uid (session_uid, created_at),
  KEY idx_controller (controller_device_id, created_at),
  KEY idx_host (host_device_id, created_at),
  KEY idx_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话记录'
PARTITION BY RANGE COLUMNS (created_at) (
  PARTITION p202611 VALUES LESS THAN ('2026-12-01'),
  PARTITION p202612 VALUES LESS THAN ('2027-01-01'),
  PARTITION pmax    VALUES LESS THAN (MAXVALUE)
)`,

  `CREATE TABLE security_events (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type              VARCHAR(32)     NOT NULL
                    COMMENT 'auth_failed | host_locked | enum_suspected | rate_limited | key_mismatch',
  target_device_id  BIGINT UNSIGNED NULL,
  source_device_id  BIGINT UNSIGNED NULL,
  source_ip         VARBINARY(16)   NULL,
  session_uid       CHAR(26)        NULL,
  detail            JSON            NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_target (target_device_id, created_at),
  KEY idx_source_device (source_device_id, created_at),
  KEY idx_source_ip (source_ip, created_at),
  KEY idx_type (type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='安全事件'`,

  `CREATE TABLE bans (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind        VARCHAR(16)     NOT NULL COMMENT 'device | ip | cidr',
  value       VARCHAR(64)     NOT NULL COMMENT 'device_uid / IP / CIDR',
  reason      VARCHAR(255)    NOT NULL DEFAULT '',
  source      VARCHAR(16)     NOT NULL DEFAULT 'manual' COMMENT 'manual | auto',
  expires_at  DATETIME(3)     NULL COMMENT 'NULL 表示永久',
  created_by  VARCHAR(64)     NOT NULL DEFAULT '',
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_kind_value (kind, value),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='封禁'`,

  `CREATE TABLE relay_nodes (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  name        VARCHAR(64)   NOT NULL COMMENT '节点名，写进票据',
  region      VARCHAR(32)   NOT NULL COMMENT '如 cn-east',
  public_url  VARCHAR(255)  NOT NULL COMMENT 'wss://relay-01.example.com',
  status      TINYINT       NOT NULL DEFAULT 1 COMMENT '0 停用 1 启用 2 排空',
  capacity    INT UNSIGNED  NOT NULL DEFAULT 5000 COMMENT '会话数上限',
  created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='中继节点'`,

  `CREATE TABLE app_releases (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version          VARCHAR(32)     NOT NULL COMMENT '语义化版本',
  kind             VARCHAR(16)     NOT NULL COMMENT 'desktop | cli',
  platform         VARCHAR(16)     NOT NULL,
  arch             VARCHAR(16)     NOT NULL,
  channel          VARCHAR(16)     NOT NULL DEFAULT 'stable' COMMENT 'stable | beta',
  download_url     VARCHAR(512)    NOT NULL,
  signature        TEXT            NOT NULL COMMENT '更新包签名',
  notes            TEXT            NULL,
  rollout_percent  TINYINT UNSIGNED NOT NULL DEFAULT 100 COMMENT '灰度比例 0-100',
  status           TINYINT         NOT NULL DEFAULT 1 COMMENT '0 撤回 1 生效',
  published_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_release (version, kind, platform, arch, channel),
  KEY idx_lookup (kind, platform, arch, channel, status, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='版本发布'`,

  `CREATE TABLE app_config (
  cfg_key     VARCHAR(64)  NOT NULL,
  cfg_value   JSON         NOT NULL,
  remark      VARCHAR(255) NOT NULL DEFAULT '',
  updated_by  VARCHAR(64)  NOT NULL DEFAULT '',
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (cfg_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='下发配置'`,

  `CREATE TABLE daily_stats (
  stat_date         DATE            NOT NULL,
  new_devices       INT UNSIGNED    NOT NULL DEFAULT 0,
  active_devices    INT UNSIGNED    NOT NULL DEFAULT 0,
  sessions_total    INT UNSIGNED    NOT NULL DEFAULT 0,
  sessions_authed   INT UNSIGNED    NOT NULL DEFAULT 0,
  auth_failures     INT UNSIGNED    NOT NULL DEFAULT 0,
  bytes_relayed     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  peak_online       INT UNSIGNED    NOT NULL DEFAULT 0,
  peak_sessions     INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每日统计'`,

  `CREATE TABLE admin_users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(64)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL COMMENT 'Argon2id',
  role           VARCHAR(16)  NOT NULL DEFAULT 'operator',
  status         TINYINT      NOT NULL DEFAULT 1,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员'`,

  `CREATE TABLE admin_audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id    INT UNSIGNED    NOT NULL,
  action      VARCHAR(64)     NOT NULL,
  target      VARCHAR(128)    NOT NULL DEFAULT '',
  detail      JSON            NULL,
  ip          VARBINARY(16)   NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin (admin_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理操作审计'`,
];

const TABLES = [
  'admin_audit_logs',
  'admin_users',
  'daily_stats',
  'app_config',
  'app_releases',
  'relay_nodes',
  'bans',
  'security_events',
  'sessions',
  'devices',
];

export async function up(knex: Knex): Promise<void> {
  for (const sql of STATEMENTS) {
    await knex.raw(sql);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of TABLES) {
    await knex.raw(`DROP TABLE IF EXISTS \`${t}\``);
  }
}
