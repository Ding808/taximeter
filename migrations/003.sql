ALTER TABLE cache_prefix ADD COLUMN count TEXT NOT NULL DEFAULT '0'
  CHECK (count <> '' AND count NOT GLOB '*[^0-9]*');

INSERT INTO schema_version VALUES (3);
