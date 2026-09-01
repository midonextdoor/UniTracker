CREATE TABLE IF NOT EXISTS courses (
    id        SERIAL PRIMARY KEY,
    name      TEXT NOT NULL,
    code      TEXT,
    instructor TEXT,
    semester  TEXT,
    credits   INTEGER DEFAULT 3
);

CREATE TABLE IF NOT EXISTS assignments (
    id        SERIAL PRIMARY KEY,
    course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
    title     TEXT NOT NULL,
    due_date  DATE,
    status    TEXT DEFAULT 'todo'   CHECK (status   IN ('todo','in_progress','done')),
    priority  TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    notes     TEXT
);



CREATE TABLE IF NOT EXISTS grades (
    id              SERIAL PRIMARY KEY,
    course_id       INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    assessment_name TEXT NOT NULL,
    grade           NUMERIC(5,2)             CHECK (grade     BETWEEN 0 AND 100),
    max_grade       NUMERIC(5,2) DEFAULT 100 CHECK (max_grade BETWEEN 0 AND 100),
    weight          NUMERIC(5,2) DEFAULT 0   CHECK (weight    BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS notes (
    id         SERIAL PRIMARY KEY,
    course_id  INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    title      TEXT NOT NULL,
    content    TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- day_of_week: 0 = Monday … 6 = Sunday
CREATE TABLE IF NOT EXISTS schedule (
    id          SERIAL PRIMARY KEY,
    course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    note        TEXT,
    color       TEXT,
    CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS roadmap_items (
    id           SERIAL PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT,
    is_completed BOOLEAN NOT NULL DEFAULT FALSE,
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Semesters
-- Every record above belongs to exactly one semester. The statements below are
-- replayed on every startup by _ensure_schema(), so each one must be a no-op the
-- second time: that is what migrates an existing database with no data loss and
-- no manual step.
CREATE TABLE IF NOT EXISTS semesters (
    id                  SERIAL PRIMARY KEY,
    label               TEXT NOT NULL,
    semester_number     SMALLINT NOT NULL CHECK (semester_number IN (1, 2)),
    academic_year_start INTEGER NOT NULL,
    academic_year_end   INTEGER NOT NULL,
    is_current          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (academic_year_start, semester_number)
);

-- Seeds only on a database that has never had a semester.
INSERT INTO semesters (label, semester_number, academic_year_start, academic_year_end, is_current)
SELECT 'Semester 1 2026-2027', 1, 2026, 2027, TRUE
WHERE NOT EXISTS (SELECT 1 FROM semesters);

-- RESTRICT, not CASCADE: there is deliberately no delete-semester UI, so a stray
-- manual DELETE fails loudly rather than silently taking a whole term with it.
ALTER TABLE courses       ADD COLUMN IF NOT EXISTS semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;
ALTER TABLE assignments   ADD COLUMN IF NOT EXISTS semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;
ALTER TABLE grades        ADD COLUMN IF NOT EXISTS semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;
ALTER TABLE notes         ADD COLUMN IF NOT EXISTS semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;
ALTER TABLE schedule      ADD COLUMN IF NOT EXISTS semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;

-- Backfill pre-existing rows into the earliest semester. No-op once none are NULL.
UPDATE courses       SET semester_id = (SELECT id FROM semesters ORDER BY academic_year_start, semester_number LIMIT 1) WHERE semester_id IS NULL;
UPDATE assignments   SET semester_id = (SELECT id FROM semesters ORDER BY academic_year_start, semester_number LIMIT 1) WHERE semester_id IS NULL;
UPDATE grades        SET semester_id = (SELECT id FROM semesters ORDER BY academic_year_start, semester_number LIMIT 1) WHERE semester_id IS NULL;
UPDATE notes         SET semester_id = (SELECT id FROM semesters ORDER BY academic_year_start, semester_number LIMIT 1) WHERE semester_id IS NULL;
UPDATE schedule      SET semester_id = (SELECT id FROM semesters ORDER BY academic_year_start, semester_number LIMIT 1) WHERE semester_id IS NULL;
UPDATE roadmap_items SET semester_id = (SELECT id FROM semesters ORDER BY academic_year_start, semester_number LIMIT 1) WHERE semester_id IS NULL;

-- Safe to re-run: SET NOT NULL on an already-NOT NULL column is a silent no-op.
ALTER TABLE courses       ALTER COLUMN semester_id SET NOT NULL;
ALTER TABLE assignments   ALTER COLUMN semester_id SET NOT NULL;
ALTER TABLE grades        ALTER COLUMN semester_id SET NOT NULL;
ALTER TABLE notes         ALTER COLUMN semester_id SET NOT NULL;
ALTER TABLE schedule      ALTER COLUMN semester_id SET NOT NULL;
ALTER TABLE roadmap_items ALTER COLUMN semester_id SET NOT NULL;
