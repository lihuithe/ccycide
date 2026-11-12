import type { Knex } from 'knex';

/**
 * 每台设备每分钟一行的流量汇总（只有这一分钟有流量才有行），永久保留。
 * 一台设备一年最多 52.6 万行，每行约 40 字节；如果以后嫌大，可以按 minute_ts 分区或归档。
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE TABLE device_traffic_minute (
  device_id   BIGINT UNSIGNED NOT NULL COMMENT 'devices.id',
  minute_ts   INT UNSIGNED    NOT NULL COMMENT '该分钟起点的 Unix 秒（UTC，60 的整数倍）',
  bytes_in    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '该设备收到的字节数',
  bytes_out   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '该设备发出的字节数',
  frames_in   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '收到的 WebSocket 帧数',
  frames_out  BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '发出的 WebSocket 帧数',
  PRIMARY KEY (device_id, minute_ts),
  KEY idx_minute (minute_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备每分钟流量'`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS `device_traffic_minute`');
}
