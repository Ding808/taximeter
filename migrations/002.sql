CREATE TABLE cache_cursors (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  eventRowid INTEGER NOT NULL CHECK (eventRowid >= 0),
  outcomeRowid INTEGER NOT NULL CHECK (outcomeRowid >= 0)
);
INSERT INTO cache_cursors VALUES (1, 0, 0);

CREATE TABLE cache_payments (
  paymentId TEXT PRIMARY KEY REFERENCES events(id),
  paymentKey TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  maxAttemptedAt TEXT
);

CREATE TABLE cache_attempts (
  paymentId TEXT NOT NULL REFERENCES cache_payments(paymentId),
  attemptId TEXT NOT NULL,
  firstTs TEXT NOT NULL,
  firstId TEXT NOT NULL,
  winnerTs TEXT NOT NULL,
  winnerId TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'confirmed', 'failed')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (paymentId, attemptId)
);
CREATE INDEX cache_attempt_selection ON cache_attempts (
  paymentId, status, firstTs, firstId COLLATE NOCASE, firstId DESC
);

CREATE TABLE cache_prefix (
  partitionKey TEXT NOT NULL,
  prefix TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount <> '' AND amount NOT GLOB '*[^0-9]*'),
  PRIMARY KEY (partitionKey, prefix)
) WITHOUT ROWID;

INSERT INTO schema_version VALUES (2);
