-- 测试用 compose 的 MySQL 初始化：测试套件用 rterm 库（由 tsx 迁移，迁移记录名带 .ts），运行栈用 rterm_stack 库（编译后迁移，记录名带 .js），
-- 两者不能共用同一个库，否则 knex 会报 "migration directory is corrupt"。
CREATE DATABASE IF NOT EXISTS rterm_stack CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
