import type { Knex } from 'knex';

/**
 * 每台设备每天一行的流量汇总：只存数字，不记录任何内容。
 * 一台设备一年 365 行，每行约几十字节，可以永久保留，不需要分区和清理。
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `CREATE TABLE device_traffic (
  device_id   BIGINT UNSIGNED NOT NULL COMMENT 'devices.id',
  stat_date   DATE            NOT NULL COMMENT 'UTC 日期',
  bytes_in    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '该设备收到的字节数（经中继转发给它的）',
  bytes_out   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '该设备发出的字节数（它发给中继的）',
  frames_in   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '收到的 WebSocket 帧数',
  frames_out  BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '发出的 WebSocket 帧数',
  PRIMARY KEY (device_id, stat_date),
  KEY idx_date (stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备每日流量'`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS `device_traffic`');
}
