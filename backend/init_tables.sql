-- init_tables.sql
-- Run these statements against your MySQL server to ensure the basic schema exists.
-- Adjust database name, charset, or types as needed for your environment.

CREATE DATABASE IF NOT EXISTS `ai_healthmate_db` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `ai_healthmate_db`;

-- Users table
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) DEFAULT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Conditions table (example structure) -- update to match your seeded data
CREATE TABLE IF NOT EXISTS `conditions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `symptoms` TEXT DEFAULT NULL,
  `description` TEXT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Analysis history table
CREATE TABLE IF NOT EXISTS `analysis_history` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT DEFAULT NULL,
  `user_name` VARCHAR(255) DEFAULT NULL,
  `symptoms` TEXT,
  `matched_condition_id` INT DEFAULT NULL,
  `matched_condition_name` VARCHAR(255) DEFAULT NULL,
  `accuracy` INT DEFAULT NULL,
  `meta` JSON DEFAULT NULL,
  -- archival columns removed; records are now hard-deleted when requested
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
