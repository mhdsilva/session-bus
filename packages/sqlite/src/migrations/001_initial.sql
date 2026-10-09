CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  harness_name TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  project_root TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  current_focus TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','busy','away','offline')),
  last_seen_at TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','completed','closed')),
  created_by TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  context_summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  state TEXT NOT NULL CHECK (state IN ('invited','active','declined','left','removed')),
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_read_sequence INTEGER NOT NULL CHECK (last_read_sequence >= 0),
  PRIMARY KEY (room_id, session_id)
);
CREATE INDEX IF NOT EXISTS memberships_pending_by_session ON memberships(session_id, room_id) WHERE state = 'invited';

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  sender_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL CHECK (type IN ('message','question','decision','task_created','task_updated','artifact_published','conflict_reported','member_invited','member_joined','member_left','room_closed')),
  version INTEGER NOT NULL CHECK (version = 1),
  payload_json TEXT NOT NULL,
  reply_to_event_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_room_cursor ON events(room_id, sequence);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','claimed','blocked','completed','cancelled')),
  owner_session_id TEXT REFERENCES sessions(id),
  result_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_room ON tasks(room_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  publisher_session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('file','patch','commit','url','text')),
  uri TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_room ON artifacts(room_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
