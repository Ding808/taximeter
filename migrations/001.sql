CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  taskId TEXT,
  agentId TEXT,
  host TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('observed', 'blocked')),
  paymentKey TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_task ON events(taskId);
CREATE INDEX events_agent ON events(agentId);
CREATE INDEX events_host ON events(host);
CREATE UNIQUE INDEX events_payment ON events(paymentKey) WHERE status = 'observed';
CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  paymentId TEXT NOT NULL REFERENCES events(id),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX outcomes_payment ON outcomes(paymentId);
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only events'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only events'); END;
CREATE TRIGGER outcomes_no_update BEFORE UPDATE ON outcomes BEGIN SELECT RAISE(ABORT, 'append-only outcomes'); END;
CREATE TRIGGER outcomes_no_delete BEFORE DELETE ON outcomes BEGIN SELECT RAISE(ABORT, 'append-only outcomes'); END;
CREATE TRIGGER diagnostics_no_update BEFORE UPDATE ON diagnostics BEGIN SELECT RAISE(ABORT, 'append-only diagnostics'); END;
CREATE TRIGGER diagnostics_no_delete BEFORE DELETE ON diagnostics BEGIN SELECT RAISE(ABORT, 'append-only diagnostics'); END;
