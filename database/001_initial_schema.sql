-- 在应用选定的数据库中执行，兼容本机 MySQL 5.7 与腾讯云 MySQL 8。

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  employee_no VARCHAR(32) NOT NULL,
  name VARCHAR(80) NOT NULL,
  mobile VARCHAR(32) NOT NULL,
  department VARCHAR(120) NOT NULL,
  role VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  password_hash VARCHAR(255) NULL,
  password_salt VARCHAR(128) NULL,
  qualifications JSON NOT NULL,
  active_task_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_users_mobile (mobile),
  UNIQUE KEY uk_users_employee_no (employee_no),
  KEY idx_users_role_status (role, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  UNIQUE KEY uk_auth_token_hash (token_hash),
  KEY idx_auth_user_expiry (user_id, expires_at),
  CONSTRAINT fk_auth_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS inspection_orders (
  id CHAR(36) PRIMARY KEY,
  order_no VARCHAR(64) NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  site_address VARCHAR(240) NOT NULL,
  product_category VARCHAR(80) NOT NULL,
  planned_at DATETIME(3) NOT NULL,
  status VARCHAR(32) NOT NULL,
  inspection_type VARCHAR(80) NULL,
  receiving_unit VARCHAR(160) NULL,
  supplier_name VARCHAR(160) NULL,
  contact_name VARCHAR(80) NULL,
  contact_phone VARCHAR(32) NULL,
  source_status VARCHAR(64) NULL,
  source_sampler VARCHAR(120) NULL,
  source_remarks VARCHAR(500) NULL,
  import_source VARCHAR(255) NULL,
  imported_at DATETIME(3) NULL,
  item_list_version INT NOT NULL DEFAULT 1,
  created_by CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uk_orders_order_no (order_no),
  KEY idx_orders_status_planned (status, planned_at),
  CONSTRAINT fk_orders_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id CHAR(36) PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  list_version INT NOT NULL,
  product_code VARCHAR(64) NOT NULL,
  product_name VARCHAR(120) NOT NULL,
  batch_no VARCHAR(64) NOT NULL,
  quantity INT NOT NULL,
  order_line_id VARCHAR(64) NULL,
  specification VARCHAR(255) NULL,
  sample_quantity INT NULL,
  completed_sample_quantity INT NULL,
  source_sampler VARCHAR(120) NULL,
  source_status VARCHAR(64) NULL,
  remark VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_order_item_version_code (order_id, list_version, product_code, batch_no),
  KEY idx_items_order_version (order_id, list_version),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES inspection_orders(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS inspection_tasks (
  id CHAR(36) PRIMARY KEY,
  task_no VARCHAR(64) NOT NULL,
  order_id CHAR(36) NOT NULL,
  assignee_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL,
  assigned_at DATETIME(3) NOT NULL,
  accepted_at DATETIME(3) NULL,
  submitted_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  sample_item_ids JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_tasks_task_no (task_no),
  KEY idx_tasks_assignee_status (assignee_id, status),
  CONSTRAINT fk_tasks_order FOREIGN KEY (order_id) REFERENCES inspection_orders(id),
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS random_audits (
  id CHAR(36) PRIMARY KEY,
  draw_type VARCHAR(32) NOT NULL,
  subject_id CHAR(36) NOT NULL,
  rule_version VARCHAR(32) NOT NULL,
  candidate_hash CHAR(64) NOT NULL,
  candidate_count INT NOT NULL,
  selected_ids JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_random_subject (subject_id, draw_type)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) PRIMARY KEY,
  actor_id CHAR(36) NOT NULL,
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id CHAR(36) NOT NULL,
  detail JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_resource (resource_type, resource_id, created_at),
  KEY idx_audit_actor (actor_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS site_check_ins (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  accuracy DECIMAL(10,2) NOT NULL,
  address VARCHAR(240) NULL,
  client_channel VARCHAR(32) NOT NULL,
  checked_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_check_in_task (task_id),
  CONSTRAINT fk_check_in_task FOREIGN KEY (task_id) REFERENCES inspection_tasks(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS physical_sample_records (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  order_item_id CHAR(36) NOT NULL,
  pallet_count INT NOT NULL,
  boxes_per_pallet INT NOT NULL,
  items_per_box INT NOT NULL,
  sample_count INT NOT NULL,
  candidate_total BIGINT NOT NULL,
  candidate_hash CHAR(64) NOT NULL,
  rule_version VARCHAR(64) NOT NULL,
  positions JSON NOT NULL,
  created_by CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_physical_sample_task (task_id),
  CONSTRAINT fk_physical_sample_task FOREIGN KEY (task_id) REFERENCES inspection_tasks(id),
  CONSTRAINT fk_physical_sample_item FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_physical_sample_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS evidence_files (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  purpose VARCHAR(32) NOT NULL DEFAULT 'INSPECTION',
  sample_key VARCHAR(80) NULL,
  file_name VARCHAR(160) NOT NULL,
  mime_type VARCHAR(80) NOT NULL,
  file_size BIGINT NOT NULL,
  storage_key VARCHAR(500) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  accuracy DECIMAL(10,2) NULL,
  address VARCHAR(500) NULL,
  coordinate_system VARCHAR(32) NULL,
  map_provider VARCHAR(32) NULL,
  captured_at DATETIME(3) NULL,
  watermark_text VARCHAR(1000) NULL,
  watermark_version VARCHAR(64) NULL,
  uploaded_by CHAR(36) NOT NULL,
  uploaded_at DATETIME(3) NOT NULL,
  KEY idx_evidence_task (task_id, uploaded_at),
  KEY idx_evidence_sample (task_id, sample_key, uploaded_at),
  CONSTRAINT fk_evidence_task FOREIGN KEY (task_id) REFERENCES inspection_tasks(id),
  CONSTRAINT fk_evidence_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS inspection_results (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  sample_key VARCHAR(80) NOT NULL,
  conclusion VARCHAR(16) NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_result_task_position (task_id, sample_key),
  CONSTRAINT fk_result_task FOREIGN KEY (task_id) REFERENCES inspection_tasks(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS review_records (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  reviewer_id CHAR(36) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  comment VARCHAR(500) NOT NULL,
  reviewed_at DATETIME(3) NOT NULL,
  KEY idx_review_task_time (task_id, reviewed_at),
  CONSTRAINT fk_review_task FOREIGN KEY (task_id) REFERENCES inspection_tasks(id),
  CONSTRAINT fk_review_user FOREIGN KEY (reviewer_id) REFERENCES users(id)
) ENGINE=InnoDB;
