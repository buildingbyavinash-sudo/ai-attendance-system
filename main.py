import os
import uuid
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from contextlib import contextmanager
import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# DATABASE & STORAGE CONFIGURATION
DATABASE_URL = os.environ.get("DATABASE_URL")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# Supabase Client for Storage
supabase: Client = None
if SUPABASE_URL and SUPABASE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Connection pool for PostgreSQL
db_pool = None
if DATABASE_URL:
    import time
    for i in range(5): # Try 5 times
        try:
            db_pool = psycopg2.pool.SimpleConnectionPool(1, 20, dsn=DATABASE_URL)
            print("Database connection pool created successfully")
            break
        except Exception as e:
            print(f"Database connection attempt {i+1} failed: {e}")
            time.sleep(2) # Wait 2 seconds before retry
    if not db_pool:
        print("Final database connection attempt failed. App will run but DB features will fail.")

# FIXED PATH LOGIC
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# Static Mounting (Frontend only)
if os.path.exists(FRONTEND_DIR):
    app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")

@contextmanager
def get_db():
    if not DATABASE_URL:
        raise HTTPException(status_code=500, detail="DATABASE_URL environment variable is missing in Render settings.")
    if not db_pool:
        raise HTTPException(status_code=500, detail="Database connection pool failed to initialize. Check Render Logs for the exact error.")
    conn = db_pool.getconn()
    try:
        yield conn
    finally:
        db_pool.putconn(conn)

def init_db():
    if not db_pool:
        return
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, type TEXT)')
        cursor.execute('CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, org_id TEXT, name TEXT)')
        cursor.execute('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT, class_id TEXT, name TEXT, enrollment_id TEXT, roll_no TEXT, image_path TEXT)')
        cursor.execute('CREATE TABLE IF NOT EXISTS attendance (id SERIAL PRIMARY KEY, user_id TEXT, org_id TEXT, name TEXT, date TEXT, time TEXT, status TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
        conn.commit()
        cursor.close()

init_db()

class OrgSignup(BaseModel):
    name: str
    email: str
    password: str
    type: str

class OrgLogin(BaseModel):
    email: str
    password: str

class ClassCreate(BaseModel):
    org_id: str
    name: str

class AttendanceRecord(BaseModel):
    user_id: str
    org_id: str
    name: str
    date: str
    time: str
    status: str

@app.get("/")
async def get_index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"error": "Frontend not found"}

@app.post("/auth/signup")
async def signup(org: OrgSignup):
    with get_db() as conn:
        cursor = conn.cursor()
        org_id = str(uuid.uuid4())
        try:
            cursor.execute("INSERT INTO organizations VALUES (%s, %s, %s, %s, %s)", (org_id, org.name, org.email, org.password, org.type))
            conn.commit()
            return {"status": "success", "org_id": org_id}
        except Exception:
            conn.rollback()
            raise HTTPException(status_code=400, detail="Email exists or database error")
        finally:
            cursor.close()

@app.post("/auth/login")
async def login(credentials: OrgLogin):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, type FROM organizations WHERE email = %s AND password = %s", (credentials.email, credentials.password))
        row = cursor.fetchone()
        cursor.close()
        if row: return {"status": "success", "org_id": row[0], "name": row[1], "type": row[2]}
        raise HTTPException(status_code=401, detail="Invalid")

@app.post("/classes")
async def create_class(c: ClassCreate):
    with get_db() as conn:
        cursor = conn.cursor()
        class_id = str(uuid.uuid4())
        cursor.execute("INSERT INTO classes VALUES (%s, %s, %s)", (class_id, c.org_id, c.name))
        conn.commit()
        cursor.close()
        return {"status": "success", "class_id": class_id}

@app.get("/classes/{org_id}")
async def get_classes(org_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM classes WHERE org_id = %s", (org_id,))
        rows = cursor.fetchall()
        cursor.close()
        return [{"id": r[0], "name": r[1]} for r in rows]

@app.delete("/classes/{class_id}")
async def delete_class(class_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM classes WHERE id = %s", (class_id,))
        conn.commit()
        cursor.close()
        return {"status": "success"}

@app.post("/register-user")
async def register_user(
    name: str = Form(...), 
    enrollment_id: str = Form(...), 
    roll_no: str = Form(...),
    class_id: str = Form(...),
    org_id: str = Form(...), 
    image: UploadFile = File(...)
):
    if not supabase:
        raise HTTPException(status_code=500, detail="Storage not configured")
        
    user_id = str(uuid.uuid4())
    filename = f"{user_id}.jpg"
    
    # Upload to Supabase Storage
    content = await image.read()
    try:
        supabase.storage.from_("faces").upload(
            path=filename,
            file=content,
            file_options={"content-type": "image/jpeg"}
        )
        # Get Public URL
        res = supabase.storage.from_("faces").get_public_url(filename)
        db_image_path = res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Storage upload failed: {str(e)}")
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT INTO users VALUES (%s, %s, %s, %s, %s, %s, %s)", (user_id, org_id, class_id, name, enrollment_id, roll_no, db_image_path))
        conn.commit()
        cursor.close()
        return {"status": "success"}

@app.get("/users/{org_id}")
async def get_users_list(org_id: str, class_id: Optional[str] = None):
    with get_db() as conn:
        cursor = conn.cursor()
        if class_id and class_id != 'all':
            cursor.execute("""
                SELECT u.id, u.name, u.enrollment_id, c.name, u.image_path, u.roll_no 
                FROM users u JOIN classes c ON u.class_id = c.id 
                WHERE u.org_id = %s AND u.class_id = %s
            """, (org_id, class_id))
        else:
            cursor.execute("""
                SELECT u.id, u.name, u.enrollment_id, COALESCE(c.name, 'Unassigned'), u.image_path, u.roll_no 
                FROM users u LEFT JOIN classes c ON u.class_id = c.id 
                WHERE u.org_id = %s
            """, (org_id,))
        
        rows = cursor.fetchall()
        cursor.close()
        return [{"id": r[0], "name": r[1], "enrollment_id": r[2], "class_name": r[3], "image": r[4], "roll_no": r[5]} for r in rows]

@app.delete("/users/{user_id}")
async def delete_user(user_id: str):
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT image_path FROM users WHERE id = %s", (user_id,))
            row = cursor.fetchone()
            
            if row and supabase:
                # Extract filename from URL to delete from storage
                # URL format: .../faces/uuid.jpg
                filename = row[0].split("/")[-1]
                try:
                    supabase.storage.from_("faces").remove([filename])
                except: pass
            
            cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cursor.execute("DELETE FROM attendance WHERE user_id = %s", (user_id,))
            conn.commit()
            cursor.close()
            return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/update-user")
async def update_user(
    user_id: str = Form(...),
    name: str = Form(...),
    enrollment_id: str = Form(...),
    roll_no: str = Form(...),
    class_id: str = Form(...),
    image: Optional[UploadFile] = File(None)
):
    with get_db() as conn:
        cursor = conn.cursor()
        if image and supabase:
            filename = f"{user_id}.jpg"
            content = await image.read()
            # Overwrite in Supabase
            supabase.storage.from_("faces").upload(
                path=filename,
                file=content,
                file_options={"upsert": "true", "content-type": "image/jpeg"}
            )
            db_path = supabase.storage.from_("faces").get_public_url(filename)
            cursor.execute("UPDATE users SET name=%s, enrollment_id=%s, roll_no=%s, class_id=%s, image_path=%s WHERE id=%s", (name, enrollment_id, roll_no, class_id, db_path, user_id))
        else:
            cursor.execute("UPDATE users SET name=%s, enrollment_id=%s, roll_no=%s, class_id=%s WHERE id=%s", (name, enrollment_id, roll_no, class_id, user_id))
        conn.commit()
        cursor.close()
        return {"status": "success"}

@app.post("/mark-attendance")
async def mark_attendance_api(r: AttendanceRecord):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT INTO attendance (user_id, org_id, name, date, time, status) VALUES (%s, %s, %s, %s, %s, %s)", (r.user_id, r.org_id, r.name, r.date, r.time, r.status))
        conn.commit()
        cursor.close()
        return {"status": "success"}

@app.get("/reports/daily/{org_id}")
async def report_daily(org_id: str, date: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name, user_id, time, status FROM attendance WHERE org_id = %s AND date = %s", (org_id, date))
        rows = cursor.fetchall()
        cursor.close()
        return [{"name": r[0], "id": r[1], "time": r[2], "status": r[3]} for r in rows]

@app.get("/reports/individual/{user_id}")
async def report_individual(user_id: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT date, time, status FROM attendance WHERE user_id = %s ORDER BY timestamp DESC", (user_id,))
        rows = cursor.fetchall()
        cursor.close()
        return [{"date": r[0], "time": r[1], "status": r[2]} for r in rows]

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
