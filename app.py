import os
import re
import json
import threading
import webbrowser
from decimal import Decimal
from datetime import date, datetime, time as dt_time
from pathlib import Path
from urllib.parse import urlparse

import webview
import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).parent
_local = threading.local()


def _conninfo():
    return " ".join([
        f"host={os.getenv('DB_HOST', 'localhost')}",
        f"port={os.getenv('DB_PORT', '5432')}",
        f"dbname={os.getenv('DB_NAME', 'uni_tracker')}",
        f"user={os.getenv('DB_USER', 'postgres')}",
        f"password={os.getenv('DB_PASSWORD', '')}",
    ])


def _conn():
    if not hasattr(_local, 'conn') or _local.conn.closed:
        _local.conn = psycopg.connect(_conninfo(), row_factory=dict_row)
    return _local.conn


def _serialize(obj):
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    # time is not a subclass of date/datetime, so it needs its own branch.
    # HH:MM is the format timeField() expects on the frontend.
    if isinstance(obj, dt_time):
        return obj.strftime('%H:%M')
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Not serializable: {type(obj)}")


def _j(data):
    return json.loads(json.dumps(data, default=_serialize))


DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

DEFAULT_SCHEDULE_DAYS = [0, 1, 2, 3, 4]
DEFAULT_START_HOUR = 8
DEFAULT_END_HOUR = 20

def _ensure_schema():
    """Apply db/schema.sql, which is idempotent. Failures are logged, not
    raised, so the window still opens and the DB error surfaces in the UI.
    """
    try:
        sql = (BASE_DIR / 'db' / 'schema.sql').read_text(encoding='utf-8')
        c = _conn()
        with c.cursor() as cur:
            cur.execute(sql)
        c.commit()
    except Exception as e:
        print(f"[schema] skipped: {e}")


def _parse_time(value):
    """Accept 'HH:MM' or 'HH:MM:SS' from the frontend, return a datetime.time."""
    if isinstance(value, dt_time):
        return value
    s = str(value or '').strip()
    for fmt in ('%H:%M', '%H:%M:%S'):
        try:
            return datetime.strptime(s, fmt).time()
        except ValueError:
            continue
    raise ValueError(f"Invalid time: {value!r}")


def _normalize_url(raw):
    """Return a safe http(s) URL, or None. Non-http(s) schemes are rejected:
    webbrowser.open() would hand them to the OS to launch.
    """
    s = str(raw or '').strip()
    if not s:
        return None
    if not re.match(r'^https?://', s, re.I):
        # Reject anything with its own scheme; "host:8080" is a port, not one.
        m = re.match(r'^([a-zA-Z][a-zA-Z0-9+.\-]*):(.*)$', s, re.S)
        if m and not m.group(2).split('/')[0].isdigit():
            return None
        s = 'https://' + s
    p = urlparse(s)
    if p.scheme.lower() not in ('http', 'https') or not p.netloc:
        return None
    return s


class Api:

    def _q(self, sql, params=()):
        c = _conn()
        with c.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def _one(self, sql, params=()):
        c = _conn()
        with c.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def _run(self, sql, params=()):
        c = _conn()
        with c.cursor() as cur:
            cur.execute(sql, params)
        c.commit()

    def _ret(self, sql, params=()):
        c = _conn()
        with c.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
        c.commit()
        return row

    # Semesters
    # The active semester is server state, not a per-call argument. Every get_*
    # below scopes itself through _active_semester_id(), so a new view or query
    # cannot forget to filter and no stale id can arrive from the frontend.

    def _active_semester_id(self):
        """Stored active semester, else the is_current one, else the earliest."""
        raw = self._get_setting('active_semester_id')
        if raw:
            # Re-validated so a setting left pointing at a missing row self-heals
            # instead of filtering every view down to nothing.
            row = self._one("SELECT id FROM semesters WHERE id=%s", (int(raw),))
            if row:
                return row['id']
        row = self._one("""
            SELECT id FROM semesters
            ORDER BY is_current DESC, academic_year_start, semester_number LIMIT 1
        """)
        return row['id'] if row else None

    def get_semesters(self):
        return _j(self._q("""
            SELECT * FROM semesters ORDER BY academic_year_start, semester_number
        """))

    def get_active_semester(self):
        sid = self._active_semester_id()
        if sid is None:
            return None
        return _j(self._one("SELECT * FROM semesters WHERE id=%s", (sid,)))

    def set_active_semester(self, id):
        row = self._one("SELECT * FROM semesters WHERE id=%s", (int(id),))
        if not row:
            return {'error': 'That semester no longer exists.'}
        self._set_setting('active_semester_id', str(row['id']))
        return _j(row)

    def finish_semester(self):
        """Create the next semester in sequence and switch to it.

        One statement on purpose: _ret commits once, so the insert, the is_current
        flip and the active-semester setting land together. A multi-call version
        could leave a new semester that nothing points at.
        """
        cur = self._one(
            "SELECT * FROM semesters WHERE id=%s", (self._active_semester_id(),))
        if not cur:
            return {'error': 'No semester to finish.'}
        if cur['semester_number'] == 1:
            num, ys = 2, cur['academic_year_start']
        else:
            num, ys = 1, cur['academic_year_start'] + 1
        # DO UPDATE, not DO NOTHING: a double click, or a term the user already
        # created, returns the existing row rather than nothing.
        return _j(self._ret("""
            WITH nxt AS (
                INSERT INTO semesters
                    (label, semester_number, academic_year_start, academic_year_end,
                     is_current)
                VALUES (%s, %s, %s, %s, TRUE)
                ON CONFLICT (academic_year_start, semester_number)
                  DO UPDATE SET is_current = TRUE
                RETURNING *
            ), cleared AS (
                UPDATE semesters SET is_current = FALSE
                WHERE id <> (SELECT id FROM nxt) AND is_current
            ), active AS (
                INSERT INTO settings (key, value)
                SELECT 'active_semester_id', id::text FROM nxt
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            )
            SELECT * FROM nxt
        """, ('Semester %d %d-%d' % (num, ys, ys + 1), num, ys, ys + 1)))

    # Courses

    def get_courses(self):
        return _j(self._q("""
            SELECT c.*,
                ROUND(
                    AVG(g.grade / g.max_grade * 100) FILTER (WHERE g.grade IS NOT NULL),
                1) AS avg_grade,
                COUNT(DISTINCT a.id) AS assignment_count,
                COUNT(DISTINCT a.id) FILTER (WHERE a.status != 'done') AS pending_count
            FROM courses c
            LEFT JOIN grades g ON g.course_id = c.id
            LEFT JOIN assignments a ON a.course_id = c.id
            WHERE c.semester_id = %s
            GROUP BY c.id
            ORDER BY c.name
        """, (self._active_semester_id(),)))

    def get_all_courses_simple(self):
        return _j(self._q(
            "SELECT id, name FROM courses WHERE semester_id=%s ORDER BY name",
            (self._active_semester_id(),),
        ))

    def add_course(self, data):
        return _j(self._ret("""
            INSERT INTO courses (name, code, instructor, credits, semester_id)
            VALUES (%s, %s, %s, %s, %s) RETURNING *
        """, (
            data['name'],
            data.get('code') or None,
            data.get('instructor') or None,
            int(data.get('credits') or 3),
            self._active_semester_id(),
        )))

    def update_course(self, id, data):
        return _j(self._ret("""
            UPDATE courses SET name=%s, code=%s, instructor=%s, credits=%s
            WHERE id=%s RETURNING *
        """, (
            data['name'],
            data.get('code') or None,
            data.get('instructor') or None,
            int(data.get('credits') or 3),
            int(id),
        )))

    def delete_course(self, id):
        self._run("DELETE FROM courses WHERE id=%s", (int(id),))
        return {'ok': True}

    # Dashboard

    def get_dashboard(self):
        today = date.today()
        sid = self._active_semester_id()
        return _j({
            'upcoming': self._q("""
                SELECT a.id, a.title, a.due_date, a.priority, a.status,
                       c.name AS course_name
                FROM assignments a
                JOIN courses c ON c.id = a.course_id
                WHERE a.semester_id = %s
                  AND a.due_date BETWEEN %s AND %s + INTERVAL '14 days'
                  AND a.status != 'done'
                ORDER BY a.due_date,
                         CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
            """, (sid, today, today)),
            'overdue_count': self._one("""
                SELECT COUNT(*) AS n FROM assignments
                WHERE semester_id = %s AND due_date < %s AND status != 'done'
            """, (sid, today))['n'],
            'pending_count': self._one("""
                SELECT COUNT(*) AS n FROM assignments
                WHERE semester_id = %s AND status IN ('todo','in_progress')
            """, (sid,))['n'],
            'courses_count': self._one(
                "SELECT COUNT(*) AS n FROM courses WHERE semester_id = %s", (sid,))['n'],
            'grade_avgs': self._q("""
                SELECT c.id, c.name,
                    ROUND(
                        AVG(g.grade / g.max_grade * 100) FILTER (WHERE g.grade IS NOT NULL),
                    1) AS avg_grade
                FROM courses c
                LEFT JOIN grades g ON g.course_id = c.id
                WHERE c.semester_id = %s
                GROUP BY c.id, c.name
                HAVING COUNT(g.id) FILTER (WHERE g.grade IS NOT NULL) > 0
                ORDER BY c.name
            """, (sid,)),
        })

    # Assignments

    def get_assignments(self, course_id=None, status=None):
        where = ["a.semester_id = %s"]
        params = [self._active_semester_id()]
        if course_id is not None:
            where.append("a.course_id = %s")
            params.append(int(course_id))
        if status and status != 'all':
            where.append("a.status = %s")
            params.append(status)
        w = "WHERE " + " AND ".join(where)
        return _j(self._q(f"""
            SELECT a.*, c.name AS course_name
            FROM assignments a
            JOIN courses c ON c.id = a.course_id
            {w}
            ORDER BY a.due_date NULLS LAST,
                     CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
        """, params))

    def add_assignment(self, data):
        return _j(self._ret("""
            INSERT INTO assignments
                (course_id, title, due_date, status, priority, notes, semester_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *
        """, (
            int(data['course_id']),
            data['title'],
            data.get('due_date') or None,
            data.get('status', 'todo'),
            data.get('priority', 'medium'),
            data.get('notes') or None,
            self._active_semester_id(),
        )))

    def update_assignment(self, id, data):
        return _j(self._ret("""
            UPDATE assignments
            SET course_id=%s, title=%s, due_date=%s, status=%s, priority=%s, notes=%s
            WHERE id=%s RETURNING *
        """, (
            int(data['course_id']),
            data['title'],
            data.get('due_date') or None,
            data.get('status', 'todo'),
            data.get('priority', 'medium'),
            data.get('notes') or None,
            int(id),
        )))

    def delete_assignment(self, id):
        self._run("DELETE FROM assignments WHERE id=%s", (int(id),))
        return {'ok': True}

    # Grades

    def get_grades(self, course_id):
        rows = _j(self._q(
            "SELECT * FROM grades WHERE course_id=%s AND semester_id=%s ORDER BY id",
            (int(course_id), self._active_semester_id()),
        ))
        graded = [r for r in rows if r['grade'] is not None]
        weighted = [r for r in graded if (r['weight'] or 0) > 0]
        total_w = sum(r['weight'] for r in weighted)
        if total_w > 0:
            avg = (
                sum(r['grade'] / r['max_grade'] * r['weight'] for r in weighted)
                / total_w * 100
            )
        elif graded:
            avg = sum(r['grade'] / r['max_grade'] * 100 for r in graded) / len(graded)
        else:
            avg = None
        return {
            'grades': rows,
            'weighted_avg': round(avg, 1) if avg is not None else None,
            'total_weight': total_w,
        }

    @staticmethod
    def _validated_grade(data):
        """Coerce + validate a grade payload. Returns (values, error_message).

        Mirrors the CHECK (0-100) constraints in db/schema.sql.
        """
        raw = data.get('grade')
        fields = {}
        try:
            fields['grade'] = (
                None if raw in (None, '', 'null') else float(raw)
            )
            fields['max_grade'] = float(data.get('max_grade') or 100)
            fields['weight'] = float(data.get('weight') or 0)
        except (TypeError, ValueError):
            return None, 'Grade, max grade and weight must be numbers.'

        labels = {'grade': 'Grade', 'max_grade': 'Max grade', 'weight': 'Weight'}
        for key, value in fields.items():
            if value is not None and not 0 <= value <= 100:
                return None, f'{labels[key]} must be between 0 and 100.'

        name = (data.get('assessment_name') or '').strip()
        if not name:
            return None, 'Assessment name is required.'
        fields['assessment_name'] = name
        return fields, None

    def add_grade(self, data):
        v, err = self._validated_grade(data)
        if err:
            return {'error': err}
        return _j(self._ret("""
            INSERT INTO grades
                (course_id, assessment_name, grade, max_grade, weight, semester_id)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
        """, (
            int(data['course_id']),
            v['assessment_name'],
            v['grade'],
            v['max_grade'],
            v['weight'],
            self._active_semester_id(),
        )))

    def update_grade(self, id, data):
        v, err = self._validated_grade(data)
        if err:
            return {'error': err}
        return _j(self._ret("""
            UPDATE grades SET assessment_name=%s, grade=%s, max_grade=%s, weight=%s
            WHERE id=%s RETURNING *
        """, (
            v['assessment_name'],
            v['grade'],
            v['max_grade'],
            v['weight'],
            int(id),
        )))

    def delete_grade(self, id):
        self._run("DELETE FROM grades WHERE id=%s", (int(id),))
        return {'ok': True}

    # Notes

    def get_notes(self, course_id=None):
        sid = self._active_semester_id()
        if course_id is not None:
            return _j(self._q("""
                SELECT n.*, c.name AS course_name
                FROM notes n
                LEFT JOIN courses c ON c.id = n.course_id
                WHERE n.semester_id = %s AND n.course_id = %s
                ORDER BY n.created_at DESC
            """, (sid, int(course_id))))
        return _j(self._q("""
            SELECT n.*, c.name AS course_name
            FROM notes n
            LEFT JOIN courses c ON c.id = n.course_id
            WHERE n.semester_id = %s
            ORDER BY n.created_at DESC
        """, (sid,)))

    def add_note(self, data):
        return _j(self._ret("""
            INSERT INTO notes (course_id, title, content, semester_id)
            VALUES (%s, %s, %s, %s) RETURNING *
        """, (
            int(data['course_id']) if data.get('course_id') else None,
            data['title'],
            data.get('content', ''),
            self._active_semester_id(),
        )))

    def update_note(self, id, data):
        return _j(self._ret("""
            UPDATE notes SET course_id=%s, title=%s, content=%s WHERE id=%s RETURNING *
        """, (
            int(data['course_id']) if data.get('course_id') else None,
            data['title'],
            data.get('content', ''),
            int(id),
        )))

    def delete_note(self, id):
        self._run("DELETE FROM notes WHERE id=%s", (int(id),))
        return {'ok': True}

    # Settings

    def _get_setting(self, key, default=None):
        row = self._one("SELECT value FROM settings WHERE key=%s", (key,))
        return row['value'] if row else default

    def _set_setting(self, key, value):
        self._run("""
            INSERT INTO settings (key, value) VALUES (%s, %s)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        """, (key, value))

    # Schedule

    def _overlap(self, day, start, end, exclude_id=None):
        """Return the first entry clashing with [start, end) on `day`, else None.

        Touching endpoints are allowed: a 10:00 end and a 10:00 start do not clash.
        """
        sql = """
            SELECT s.start_time, s.end_time,
                   COALESCE(NULLIF(c.code, ''), c.name) AS label
            FROM schedule s
            JOIN courses c ON c.id = s.course_id
            WHERE s.semester_id = %s
              AND s.day_of_week = %s AND s.start_time < %s AND s.end_time > %s
        """
        params = [self._active_semester_id(), int(day), end, start]
        if exclude_id is not None:
            sql += " AND s.id <> %s"
            params.append(int(exclude_id))
        return self._one(sql + " ORDER BY s.start_time LIMIT 1", params)

    def _validated_entry(self, data, exclude_id=None):
        """Coerce + validate a schedule payload. Returns (values, error_message)."""
        try:
            start = _parse_time(data.get('start_time'))
            end = _parse_time(data.get('end_time'))
        except ValueError:
            return None, 'Start and end times are required.'
        if end <= start:
            return None, 'End time must be after start time.'
        day = int(data.get('day_of_week', 0))
        if not 0 <= day <= 6:
            return None, 'Invalid day.'
        clash = self._overlap(day, start, end, exclude_id)
        if clash:
            return None, (
                f"Overlaps {clash['label']} "
                f"({clash['start_time'].strftime('%H:%M')} - "
                f"{clash['end_time'].strftime('%H:%M')})"
            )
        return {
            'course_id': int(data['course_id']),
            'day_of_week': day,
            'start_time': start,
            'end_time': end,
            'note': (data.get('note') or '').strip() or None,
            'color': data.get('color') or None,
        }, None

    def get_schedule(self):
        return _j(self._q("""
            SELECT s.*, c.name AS course_name, c.code AS course_code
            FROM schedule s
            JOIN courses c ON c.id = s.course_id
            WHERE s.semester_id = %s
            ORDER BY s.day_of_week, s.start_time
        """, (self._active_semester_id(),)))

    def add_schedule_entry(self, data):
        v, err = self._validated_entry(data)
        if err:
            return {'error': err}
        return _j(self._ret("""
            INSERT INTO schedule
                (course_id, day_of_week, start_time, end_time, note, color, semester_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *
        """, (
            v['course_id'], v['day_of_week'], v['start_time'],
            v['end_time'], v['note'], v['color'], self._active_semester_id(),
        )))

    def update_schedule_entry(self, id, data):
        v, err = self._validated_entry(data, exclude_id=id)
        if err:
            return {'error': err}
        return _j(self._ret("""
            UPDATE schedule
            SET course_id=%s, day_of_week=%s, start_time=%s, end_time=%s, note=%s, color=%s
            WHERE id=%s RETURNING *
        """, (
            v['course_id'], v['day_of_week'], v['start_time'],
            v['end_time'], v['note'], v['color'], int(id),
        )))

    def delete_schedule_entry(self, id):
        self._run("DELETE FROM schedule WHERE id=%s", (int(id),))
        return {'ok': True}

    def get_schedule_settings(self):
        raw_days = self._get_setting('schedule_days')
        try:
            days = [int(d) for d in json.loads(raw_days)] if raw_days else None
        except (ValueError, TypeError):
            days = None
        if not days:
            days = DEFAULT_SCHEDULE_DAYS
        try:
            start_hour = int(self._get_setting('schedule_start_hour', DEFAULT_START_HOUR))
            end_hour = int(self._get_setting('schedule_end_hour', DEFAULT_END_HOUR))
        except (ValueError, TypeError):
            start_hour, end_hour = DEFAULT_START_HOUR, DEFAULT_END_HOUR
        if not 0 <= start_hour < end_hour <= 24:
            start_hour, end_hour = DEFAULT_START_HOUR, DEFAULT_END_HOUR
        return {
            'days': sorted(set(d for d in days if 0 <= d <= 6)) or DEFAULT_SCHEDULE_DAYS,
            'start_hour': start_hour,
            'end_hour': end_hour,
        }

    def save_schedule_settings(self, data):
        days = sorted(set(int(d) for d in (data.get('days') or []) if 0 <= int(d) <= 6))
        if not days:
            return {'error': 'Pick at least one day.'}
        start_hour = int(data.get('start_hour', DEFAULT_START_HOUR))
        end_hour = int(data.get('end_hour', DEFAULT_END_HOUR))
        if not 0 <= start_hour < end_hour <= 24:
            return {'error': 'End hour must be after start hour.'}
        self._set_setting('schedule_days', json.dumps(days))
        self._set_setting('schedule_start_hour', str(start_hour))
        self._set_setting('schedule_end_hour', str(end_hour))
        return self.get_schedule_settings()

    # Roadmap

    def get_roadmap(self):
        return _j(self._q("SELECT * FROM roadmap_items ORDER BY position, id"))

    def add_roadmap_item(self, data):
        return _j(self._ret("""
            INSERT INTO roadmap_items (title, description, position, semester_id)
            VALUES (%s, %s, (SELECT COALESCE(MAX(position), -1) + 1 FROM roadmap_items), %s)
            RETURNING *
        """, (
            data['title'],
            (data.get('description') or '').strip() or None,
            self._active_semester_id(),
        )))

    def update_roadmap_item(self, id, data):
        return _j(self._ret("""
            UPDATE roadmap_items SET title=%s, description=%s, is_completed=%s
            WHERE id=%s RETURNING *
        """, (
            data['title'],
            (data.get('description') or '').strip() or None,
            bool(data.get('is_completed')),
            int(id),
        )))

    def toggle_roadmap_item(self, id):
        return _j(self._ret("""
            UPDATE roadmap_items SET is_completed = NOT is_completed
            WHERE id=%s RETURNING *
        """, (int(id),)))

    def delete_roadmap_item(self, id):
        self._run("DELETE FROM roadmap_items WHERE id=%s", (int(id),))
        return {'ok': True}

    def reorder_roadmap(self, ids):
        """Persist a full ordering in one statement. Serves both drag-drop and arrows."""
        ordered = [int(i) for i in ids]
        if not ordered:
            return {'ok': True}
        self._run("""
            UPDATE roadmap_items r SET position = v.pos
            FROM unnest(%s::int[], %s::int[]) AS v(id, pos)
            WHERE r.id = v.id
        """, (ordered, list(range(len(ordered)))))
        return {'ok': True}

    # Uni Portal

    def get_portal_url(self):
        return {'url': self._get_setting('portal_url', '') or ''}

    def save_portal_url(self, url):
        clean = _normalize_url(url)
        if not clean:
            return {'error': 'Enter a valid http:// or https:// address.'}
        self._set_setting('portal_url', clean)
        return {'ok': True, 'url': clean}

    def open_portal(self):
        # Re-validate on the way out rather than trusting whatever is stored.
        clean = _normalize_url(self._get_setting('portal_url'))
        if not clean:
            return {'error': 'No portal URL saved yet.'}
        webbrowser.open(clean)
        return {'ok': True}


if __name__ == '__main__':
    _ensure_schema()
    window = webview.create_window(
        'UniTracker',
        url=(BASE_DIR / 'frontend' / 'index.html').as_uri(),
        js_api=Api(),
        width=1200,
        height=800,
        min_size=(900, 600),
    )
    webview.start()
