# UniTracker

I got tired of my uni's app going down so i decided to do this to keep track of
uni related stuff. It runs entirely on your own machine against a local
PostgreSQL database.

| View | What it does |
|---|---|
| Dashboard | Upcoming deadlines (14 days), overdue and pending counts, grade averages |
| Schedule | Weekly timetable grid, with configurable days and visible hours |
| Courses | Code, instructor, semester and credits per course |
| Assignments | Due dates, priority and status, filterable by course |
| Grades | Per-course entries with weighted average and letter grade |
| Notes | Plain-text notes, optionally linked to a course, with search |
| Roadmap | A reorderable checklist of longer-term goals |

## Requirements

- Python 3.11+
- PostgreSQL running on `localhost:5432` (developed against 17)

## Setup

```bash
pip install -r requirements.txt
psql -U postgres -c "CREATE DATABASE uni_tracker;"
cp .env.example .env     # then fill in your PostgreSQL password
python app.py
```

The tables are created automatically on first run. A native desktop window
opens. There is no web server and nothing listens on a port.

## Stack

pywebview window → Python `Api` class → psycopg3 → PostgreSQL.
The frontend is plain HTML/CSS/JS.
