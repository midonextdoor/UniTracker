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
