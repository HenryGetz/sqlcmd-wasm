CREATE TABLE IF NOT EXISTS startup_demo (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);

INSERT INTO startup_demo (id, label) VALUES
  (1, 'first row'),
  (2, 'second row');
