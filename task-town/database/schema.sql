CREATE TABLE IF NOT EXISTS families (
  id CHAR(36) PRIMARY KEY, code CHAR(10) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL, created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS parents (
  id CHAR(36) PRIMARY KEY, family_id CHAR(36) NOT NULL,
  username VARCHAR(32) NOT NULL UNIQUE, display_name VARCHAR(96) NOT NULL,
  password_hash VARCHAR(200) NOT NULL, created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS children (
  id CHAR(36) PRIMARY KEY, family_id CHAR(36) NOT NULL,
  login_name VARCHAR(32) NOT NULL, display_name VARCHAR(96) NOT NULL,
  pin_hash VARCHAR(200) NOT NULL, balance INT UNSIGNED NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY family_login (family_id,login_name),
  FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY, role ENUM('parent','kid') NOT NULL,
  user_id CHAR(36) NOT NULL, csrf_token CHAR(64) NOT NULL, expires_at BIGINT NOT NULL,
  INDEX session_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS tasks (
  id CHAR(36) PRIMARY KEY, family_id CHAR(36) NOT NULL, child_id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL, description VARCHAR(2000) NOT NULL, category VARCHAR(40) NOT NULL,
  reward INT UNSIGNED NOT NULL, recurrence ENUM('once','daily') NOT NULL, due_at VARCHAR(32),
  photo_required TINYINT UNSIGNED NOT NULL DEFAULT 0, active TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id), FOREIGN KEY (child_id) REFERENCES children(id),
  INDEX tasks_child (child_id,created_at), CHECK(reward BETWEEN 1 AND 1000),
  CHECK(photo_required IN(0,1)), CHECK(active IN(0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS runs (
  id CHAR(36) PRIMARY KEY, task_id CHAR(36) NOT NULL, family_id CHAR(36) NOT NULL,
  child_id CHAR(36) NOT NULL, period_key VARCHAR(10) NOT NULL,
  status ENUM('claimed','submitted','approved') NOT NULL,
  note VARCHAR(1200) NOT NULL DEFAULT '', review_comment VARCHAR(1200) NOT NULL DEFAULT '',
  photo MEDIUMBLOB, photo_type VARCHAR(32), claimed_at VARCHAR(32) NOT NULL,
  submitted_at VARCHAR(32), reviewed_at VARCHAR(32), reviewer_id CHAR(36),
  UNIQUE KEY task_period (task_id,child_id,period_key),
  FOREIGN KEY (task_id) REFERENCES tasks(id), FOREIGN KEY (family_id) REFERENCES families(id),
  FOREIGN KEY (child_id) REFERENCES children(id), FOREIGN KEY (reviewer_id) REFERENCES parents(id),
  INDEX runs_family (family_id,claimed_at), INDEX runs_child (child_id,claimed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS rewards (
  id CHAR(36) PRIMARY KEY, family_id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL, price INT UNSIGNED NOT NULL, icon VARCHAR(16) NOT NULL,
  active TINYINT UNSIGNED NOT NULL DEFAULT 1, created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (family_id) REFERENCES families(id), INDEX rewards_family (family_id,created_at),
  CHECK(price BETWEEN 1 AND 100000), CHECK(active IN(0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS redemptions (
  id CHAR(36) PRIMARY KEY, family_id CHAR(36) NOT NULL, child_id CHAR(36) NOT NULL,
  reward_id CHAR(36) NOT NULL, title VARCHAR(160) NOT NULL, price INT UNSIGNED NOT NULL,
  request_key VARCHAR(80) NOT NULL, status ENUM('pending','fulfilled','rejected') NOT NULL,
  comment VARCHAR(1200) NOT NULL DEFAULT '', created_at VARCHAR(32) NOT NULL, reviewed_at VARCHAR(32),
  UNIQUE KEY child_request (child_id,request_key),
  FOREIGN KEY (family_id) REFERENCES families(id), FOREIGN KEY (child_id) REFERENCES children(id),
  FOREIGN KEY (reward_id) REFERENCES rewards(id), INDEX redemption_family (family_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ledger (
  id CHAR(36) PRIMARY KEY, family_id CHAR(36) NOT NULL, child_id CHAR(36) NOT NULL,
  delta INT NOT NULL, balance_after INT UNSIGNED NOT NULL, kind VARCHAR(32) NOT NULL,
  reference_id CHAR(36) NOT NULL, note VARCHAR(500) NOT NULL, created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY event_reference (kind,reference_id),
  FOREIGN KEY (family_id) REFERENCES families(id), FOREIGN KEY (child_id) REFERENCES children(id),
  INDEX ledger_child (child_id,created_at), INDEX ledger_family (family_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
