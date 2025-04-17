from fastapi import FastAPI, HTTPException, BackgroundTasks, UploadFile, File, Form, Depends, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Dict, Optional
import google.generativeai as genai
import os
import json
from dotenv import load_dotenv
import logging
import re
from pymongo import MongoClient
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
import hashlib
from datetime import datetime, timedelta
from bson import ObjectId
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import pdfplumber
import tempfile
from starlette.responses import FileResponse
from fastapi import APIRouter, Depends, HTTPException
from pymongo.collection import Collection
from bson import ObjectId
from datetime import datetime
import logging
from google.api_core import exceptions as google_exceptions

# --- Setup Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

# --- Load Environment Variables ---
load_dotenv()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
EMAIL_USER = os.getenv("EMAIL_USER")
EMAIL_PASS = os.getenv("EMAIL_PASS")
if not GEMINI_API_KEY or not EMAIL_USER or not EMAIL_PASS:
    logger.error("Required environment variables not found")
    raise ValueError("GEMINI_API_KEY, EMAIL_USER, and EMAIL_PASS required")
genai.configure(api_key=GEMINI_API_KEY)

# --- Database Setup ---
try:
    client = MongoClient("mongodb://localhost:27017/", serverSelectionTimeoutMS=5000)
    client.server_info()  # Test connection
    logger.info("MongoDB connection established")
except Exception as e:
    logger.error(f"MongoDB connection failed: {str(e)}")
    raise ConnectionError("Failed to connect to MongoDB")

db = client["healthchain_db"]
users_collection = db["users"]
logs_collection = db["health_logs"]
meds_collection = db["medications"]
blockchain_collection = db["blockchain"]
nutrition_collection = db["nutrition"]
fitness_collection = db["fitness"]
reports_collection = db["reports"]
forum_collection = db["forum"]
doctors_collection = db["doctors"]
appointments_collection = db["appointments"]

# --- FastAPI App ---
app = FastAPI()

# --- Serve Static Files ---
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- CORS Configuration ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Models ---
class User(BaseModel):
    username: str
    password: str
    email: str

class SymptomsInput(BaseModel):
    symptoms: List[str]
    age: int
    gender: str

class Log(BaseModel):
    mood: str
    sleep: float
    water: float
    exercise: float
    note: Optional[str] = None
    timestamp: str = str(datetime.now())

class Trend(BaseModel):
    current_week: float
    previous_week: float
    change_percent: float

class WeeklyCalories(BaseModel):
    week: str
    calories: float

class Med(BaseModel):
    name: str
    time: str
    dosage: str
    timestamp: str

class NutritionInput(BaseModel):
    food_item: str
    calories: float
    protein: float
    fats: float
    carbs: float
    timestamp: str

class FetchNutritionInput(BaseModel):
    food_item: str

class FitnessInput(BaseModel):
    exercise_name: str
    duration: int
    intensity: int
    timestamp: str
    weight: Optional[float] = None
    goal: Optional[str] = None
    fitness_level: Optional[str] = None

class ForumPost(BaseModel):
    title: str
    content: str
    timestamp: str
    user_id: str = "anonymous"

class EmailReminder(BaseModel):
    name: str
    time: int  # Unix timestamp in milliseconds

class MedicineVerification(BaseModel):
    medicine_name: str

class PlanResponse(BaseModel):
    status: str
    workout_suggestion: Optional[str] = None
    estimated_calories_burned: Optional[float] = None
    weight: Optional[float] = None
    goal: Optional[str] = None
    fitness_level: Optional[str] = None
    message: Optional[str] = None
    nutrition_summary: Optional[str] = None

class ProgressResponse(BaseModel):
    weekly_calories: list[WeeklyCalories]
    duration_trend: Trend
    intensity_trend: Trend

class DoctorRegister(BaseModel):
    name: str
    email: str
    password: str
    location: str

class DoctorLogin(BaseModel):
    email: str
    password: str

class AppointmentRequest(BaseModel):
    doctor_id: str
    patient_email: str

class Appointment(BaseModel):
    doctor_id: str
    patient_name: Optional[str] = None
    patient_email: str
    requested_at: str = str(datetime.now())
    status: str = "pending"
    accepted_at: Optional[str] = None

SESSION_TIMEOUT = timedelta(hours=24)

def get_session(request: Request):
    session_id = request.cookies.get("session_id")
    if not session_id:
        return None
    user = users_collection.find_one({"session_id": session_id})
    if not user or not user.get("session_id") or datetime.fromisoformat(user.get("session_expiry", "2000-01-01")) < datetime.now():
        return None
    return user

def get_doctor_session(request: Request):
    session_id = request.cookies.get("doctor_session_id")
    if not session_id:
        return None
    doctor = doctors_collection.find_one({"session_id": session_id})
    if not doctor or not doctor.get("session_id") or datetime.fromisoformat(doctor.get("session_expiry", "2000-01-01")) < datetime.now():
        return None
    return doctor

# --- Email Sending Function ---
def send_email(to_email, subject, body):
    msg = MIMEMultipart()
    msg['From'] = EMAIL_USER
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))
    try:
        with smtplib.SMTP('smtp.gmail.com', 587) as server:
            server.starttls()
            server.login(EMAIL_USER, EMAIL_PASS)
            server.send_message(msg)
        logger.info(f"Email sent to {to_email}")
    except Exception as e:
        logger.error(f"Failed to send email: {str(e)}")

# --- Authentication Routes ---
@app.post("/api/register")
async def register(
    background_tasks: BackgroundTasks,
    user: User,
    response: Response
):
    logger.info(f"Register attempt for username: {user.username}")
    if users_collection.find_one({"username": user.username}):
        raise HTTPException(status_code=400, detail="Username already exists")
    hashed = hashlib.sha256((user.password + "salt").encode()).hexdigest()
    session_id = hashlib.sha256(os.urandom(16)).hexdigest()
    expiry = datetime.now() + SESSION_TIMEOUT
    users_collection.insert_one({
        "username": user.username,
        "password": hashed,
        "email": user.email,
        "session_id": session_id,
        "session_expiry": expiry.isoformat()
    })
    response.set_cookie(key="session_id", value=session_id, httponly=True, path="/")
    background_tasks.add_task(send_welcome_email, user.email)
    return {"status": "success", "redirect": "/static/index.html"}

def send_welcome_email(email):
    logger.info(f"Welcome email sent to {email}: Thank you for joining HealthChain!")
    send_email(email, "Welcome to HealthChain", "Thank you for joining HealthChain!")

@app.post("/api/login")
async def login(response: Response, username: str = Form(...), password: str = Form(...)):
    logger.info(f"Login attempt for username: {username}")
    hashed = hashlib.sha256((password + "salt").encode()).hexdigest()
    user = users_collection.find_one({"username": username, "password": hashed})
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    session_id = hashlib.sha256(os.urandom(16)).hexdigest()
    expiry = datetime.now() + SESSION_TIMEOUT
    users_collection.update_one(
        {"_id": user["_id"]},
        {"$set": {"session_id": session_id, "session_expiry": expiry.isoformat()}}
    )
    response.set_cookie(key="session_id", value=session_id, httponly=True, path="/")
    logger.info(f"Login successful for {username}, session_id: {session_id}")
    return {"status": "success", "redirect": "/static/index.html"}

@app.post("/api/logout")
async def logout(response: Response, session: dict = Depends(get_session)):
    try:
        if session:
            users_collection.update_one(
                {"_id": session["_id"]},
                {"$set": {"session_id": None, "session_expiry": None}}
            )
            logger.info(f"User {session['username']} logged out")
        response.set_cookie(key="session_id", value="", httponly=True, max_age=0, path="/")
        return {"status": "success", "redirect": "/static/login.html"}
    except Exception as e:
        logger.error(f"Logout failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Logout failed")

# --- Doctor Authentication Routes ---
@app.post("/api/doctors/register")
async def doctor_register(
    background_tasks: BackgroundTasks,
    doctor: DoctorRegister,
    response: Response
):
    logger.info(f"Doctor registration attempt for email: {doctor.email}")
    if doctors_collection.find_one({"email": doctor.email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    hashed = hashlib.sha256((doctor.password + "salt").encode()).hexdigest()
    session_id = hashlib.sha256(os.urandom(16)).hexdigest()
    expiry = datetime.now() + SESSION_TIMEOUT
    doctor_data = {
        "name": doctor.name,
        "email": doctor.email,
        "password": hashed,
        "location": doctor.location,
        "session_id": session_id,
        "session_expiry": expiry.isoformat()
    }
    doctor_id = doctors_collection.insert_one(doctor_data).inserted_id
    response.set_cookie(key="doctor_session_id", value=session_id, httponly=True, path="/")
    background_tasks.add_task(send_doctor_welcome_email, doctor.email)
    return {"status": "success", "doctor_id": str(doctor_id), "redirect": "/static/doctors_login.html"}

def send_doctor_welcome_email(email):
    logger.info(f"Welcome email sent to doctor {email}")
    send_email(email, "Welcome to HealthChain as a Doctor", "Thank you for joining HealthChain as a doctor!")

@app.post("/api/doctors/login")
async def doctor_login(response: Response, email: str = Form(...), password: str = Form(...)):
    logger.info(f"Doctor login attempt for email: {email}")
    hashed = hashlib.sha256((password + "salt").encode()).hexdigest()
    doctor = doctors_collection.find_one({"email": email, "password": hashed})
    if not doctor:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    session_id = hashlib.sha256(os.urandom(16)).hexdigest()
    expiry = datetime.now() + SESSION_TIMEOUT
    doctors_collection.update_one(
        {"_id": doctor["_id"]},
        {"$set": {"session_id": session_id, "session_expiry": expiry.isoformat()}}
    )
    response.set_cookie(key="doctor_session_id", value=session_id, httponly=True, path="/")
    logger.info(f"Doctor login successful for {email}, session_id: {session_id}")
    return {"status": "success", "redirect": "/static/doctors_dashboard.html"}

@app.post("/api/doctors/logout")
async def doctor_logout(response: Response, session: dict = Depends(get_doctor_session)):
    try:
        if session:
            doctors_collection.update_one(
                {"_id": session["_id"]},
                {"$set": {"session_id": None, "session_expiry": None}}
            )
            logger.info(f"Doctor {session['name']} logged out")
        response.set_cookie(key="doctor_session_id", value="", httponly=True, max_age=0, path="/")
        return {"status": "success", "redirect": "/static/doctors_login.html"}
    except Exception as e:
        logger.error(f"Doctor logout failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Logout failed")

@app.get("/api/doctors/session")
async def doctor_check_session(session: dict = Depends(get_doctor_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"name": session["name"]}

@app.get("/api/doctors/appointments/accepted")
async def get_accepted_appointments(date: str = None, session: dict = Depends(get_doctor_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    try:
        doctor_id = str(session["_id"])
        query = {"doctor_id": doctor_id, "status": "accepted"}
        
        if date:
            try:
                start_date = datetime.strptime(date, "%Y-%m-%d")
                end_date = start_date.replace(hour=23, minute=59, second=59)
                query["accepted_at"] = {
                    "$gte": start_date.isoformat(),
                    "$lte": end_date.isoformat()
                }
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        
        appointments = list(appointments_collection.find(query).sort("accepted_at", 1))
        for app in appointments:
            app["_id"] = str(app["_id"])
            app["doctor_id"] = str(app["doctor_id"])
        
        logger.info(f"Retrieved {len(appointments)} accepted appointments for doctor {doctor_id}")
        return appointments
    except Exception as e:
        logger.error(f"Failed to fetch accepted appointments: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.get("/api/doctors")
async def get_doctors(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        doctors = list(doctors_collection.find({}, {"password": 0, "session_id": 0, "session_expiry": 0}))
        for doctor in doctors:
            doctor["_id"] = str(doctor["_id"])
        logger.info(f"Retrieved {len(doctors)} doctors")
        return doctors
    except Exception as e:
        logger.error(f"Failed to fetch doctors: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

# --- Appointment Routes ---
@app.post("/api/appointments/request")
async def request_appointment(
    background_tasks: BackgroundTasks,
    appointment: AppointmentRequest,
    session: dict = Depends(get_session)
):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        doctor = doctors_collection.find_one({"_id": ObjectId(appointment.doctor_id)})
        if not doctor:
            raise HTTPException(status_code=404, detail="Doctor not found")
        appointment_data = {
            "doctor_id": appointment.doctor_id,
            "patient_name": session.get("username", "Anonymous"),
            "patient_email": appointment.patient_email,
            "requested_at": str(datetime.now()),
            "status": "pending",
            "accepted_at": None
        }
        appointment_id = appointments_collection.insert_one(appointment_data).inserted_id
        background_tasks.add_task(send_appointment_email, doctor["email"], appointment_data)
        return {"status": "success", "appointment_id": str(appointment_id), "message": "Appointment requested! Check your email."}
    except Exception as e:
        logger.error(f"Failed to request appointment: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

def send_appointment_email(doctor_email, appointment):
    subject = "New Appointment Request"
    body = (
        f"Dear Dr. {doctor_email.split('@')[0]},\n\n"
        f"You have a new appointment request:\n"
        f"Patient Name: {appointment['patient_name']}\n"
        f"Patient Email: {appointment['patient_email']}\n"
        f"Requested At: {appointment['requested_at']}\n"
        f"Appointment ID: {appointment['_id']}\n\n"
        f"Please log in to your dashboard to accept or reject this appointment.\n\n"
        f"Best,\nHealthChain Team"
    )
    send_email(doctor_email, subject, body)

@app.get("/api/doctors/appointments")
async def get_doctor_appointments(session: dict = Depends(get_doctor_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        appointments = list(appointments_collection.find({"doctor_id": str(session["_id"]), "status": "pending"}, {"_id": 1, "patient_name": 1, "patient_email": 1, "requested_at": 1}))
        for app in appointments:
            app["_id"] = str(app["_id"])
        logger.info(f"Retrieved {len(appointments)} pending appointments for doctor {session['name']}")
        return appointments
    except Exception as e:
        logger.error(f"Failed to fetch appointments: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.post("/api/doctors/appointments/{appointment_id}/accept")
async def accept_appointment(
    background_tasks: BackgroundTasks,
    appointment_id: str,
    session: dict = Depends(get_doctor_session)
):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        appointment = appointments_collection.find_one({"_id": ObjectId(appointment_id), "doctor_id": str(session["_id"]), "status": "pending"})
        if not appointment:
            raise HTTPException(status_code=404, detail="Appointment not found or already processed")
        accepted_at = str(datetime.now())
        appointments_collection.update_one(
            {"_id": ObjectId(appointment_id)},
            {"$set": {"status": "accepted", "accepted_at": accepted_at}}
        )
        background_tasks.add_task(send_acceptance_email, appointment["patient_email"], appointment)
        return {"status": "success", "message": "Appointment accepted!"}
    except Exception as e:
        logger.error(f"Failed to accept appointment: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

def send_acceptance_email(patient_email, appointment):
    subject = "Appointment Accepted"
    body = (
        f"Dear {appointment['patient_name']},\n\n"
        f"Your appointment request has been accepted by your doctor.\n"
        f"Appointment ID: {appointment['_id']}\n"
        f"Requested At: {appointment['requested_at']}\n"
        f"Accepted At: {appointment['accepted_at']}\n\n"
        f"Please contact your doctor at {appointment['doctor_id']} for further details.\n\n"
        f"Best,\nHealthChain Team"
    )
    send_email(patient_email, subject, body)

@app.post("/api/send-email-reminder")
async def send_email_reminder(reminder: EmailReminder, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        user = users_collection.find_one({"_id": ObjectId(session["_id"])})
        if not user or not user.get("email"):
            raise HTTPException(status_code=400, detail="User email not found")
        reminder_time = datetime.fromtimestamp(reminder.time / 1000)
        subject = f"Medication Reminder: {reminder.name}"
        body = f"Dear {user['username']},\n\nThis is a reminder to take your {reminder.name} at {reminder_time.strftime('%H:%M')}.\n\nBest,\nHealthChain Team"
        send_email(user["email"], subject, body)
        return {"status": "success", "message": f"Email reminder scheduled for {reminder.name} at {reminder_time.strftime('%H:%M')}"}
    except Exception as e:
        logger.error(f"Failed to send email reminder: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to schedule email reminder")

# --- Middleware for Session Checking ---
async def check_session(request: Request, call_next):
    excluded_paths = (
        "/static",
        "/api/register",
        "/api/login",
        "/health",
        "/api/debug",
        "/login.html",
        "/static/index.html",
        "/api/doctors/register",
        "/api/doctors/login",
        "/api/doctors/logout",
        "/api/doctors/session",
        "/static/doctors_login.html",
        "/static/doctors_register.html"
    )
    if not any(request.url.path.startswith(path) for path in excluded_paths) and request.url.path != "/":
        session = get_session(request) if "doctor" not in request.url.path else get_doctor_session(request)
        if not session:
            logger.warning(f"Unauthorized access attempt to {request.url.path}")
            return Response(status_code=302, headers={"Location": "/static/login.html" if "doctor" not in request.url.path else "/static/doctors_login.html"})
    try:
        response = await call_next(request)
        return response
    except Exception as e:
        logger.error(f"Middleware error for {request.url.path}: {str(e)}", exc_info=True)
        return Response(status_code=500, content="Internal Server Error")

app.middleware("http")(check_session)

# --- Debug Endpoint ---
@app.get("/api/debug")
async def debug():
    try:
        client.server_info()
        return {
            "status": "success",
            "mongodb": "connected",
            "collections": db.list_collection_names()
        }
    except Exception as e:
        logger.error(f"Debug endpoint failed: {str(e)}")
        return {"status": "error", "mongodb": "disconnected", "error": str(e)}

# --- Symptom Checker Endpoint ---
@app.post("/api/symptoms")
async def check_symptoms(input: SymptomsInput, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    logger.info(f"Symptom check: symptoms={input.symptoms}, age={input.age}, gender={input.gender}")
    try:
        model = genai.GenerativeModel("gemini-1.5-flash")
        prompt = (
            f"Given symptoms {', '.join(input.symptoms)}, age {input.age}, gender {input.gender}, "
            "list possible conditions with confidence percentages in the format: 'Condition: X%' (one per line). "
            "If no conditions match, return 'No conditions found'. "
            "Include: 'Disclaimer: Not a substitute for medical advice.'"
        )
        response = model.generate_content(prompt)
        if not response.text:
            logger.error("Empty response from Gemini API")
            raise ValueError("No response from Gemini API")
        
        logger.info(f"Raw response: {response.text}")
        conditions = []
        for line in response.text.split("\n"):
            if match := re.match(r"^(?:Condition:)?\s*(.+?)\s*:\s*(\d+)%$", line.strip()):
                condition, confidence = match.groups()
                conditions.append({"condition": condition.strip(), "confidence": float(confidence)})
            elif "No conditions found" in line:
                return {"diagnoses": [], "medicine_suggestions": []}
        
        medicine_suggestions = []
        symptom_rules = {
            "fever": {"medicine": "Paracetamol", "dosage": "500mg every 6 hours as needed"},
            "cough": {"medicine": "Cough syrup", "dosage": "10ml every 8 hours as needed"},
            "headache": {"medicine": "Ibuprofen", "dosage": "200mg every 6 hours as needed"},
        }
        for symptom in input.symptoms:
            if symptom.lower() in symptom_rules:
                medicine_suggestions.append(symptom_rules[symptom.lower()])

        logger.info(f"Parsed: conditions={conditions}, suggestions={medicine_suggestions}")
        return {"diagnoses": conditions, "medicine_suggestions": medicine_suggestions}
    except Exception as e:
        logger.error(f"Symptom check error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to process symptoms")

# --- Logs Endpoints ---
@app.get("/api/logs")
async def get_logs(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        logs = list(logs_collection.find({"user_id": str(session["_id"])}, {'_id': 0}))
        logger.info(f"Retrieved {len(logs)} logs for user {session['username']}")
        return logs
    except Exception as e:
        logger.error(f"Error fetching logs: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch logs")

@app.post("/api/logs")
async def add_log(log: Log, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if log.sleep > 10 or log.water > 5 or log.exercise > 300:
        raise HTTPException(status_code=400, detail="Invalid input: Sleep ≤ 10hrs, Water ≤ 5L, Exercise ≤ 300min")
    try:
        log_dict = log.dict()
        log_dict["user_id"] = str(session["_id"])
        log_id = logs_collection.insert_one(log_dict).inserted_id
        logger.info(f"Log added with ID {log_id}")
        return {"status": "success", "log_id": str(log_id)}
    except Exception as e:
        logger.error(f"Failed to add log: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

# --- Blockchain Endpoints ---
@app.post("/api/blockchain")
async def save_blockchain(chain_data: List[Dict], session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        blockchain_collection.delete_many({})
        result = blockchain_collection.insert_many(chain_data)
        logger.info(f"Blockchain saved with {len(result.inserted_ids)} blocks")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Error saving blockchain: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to save blockchain")

@app.get("/api/blockchain/status")
async def get_blockchain_status(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        blockchain_data = list(blockchain_collection.find().limit(1))
        return {"status": "active" if blockchain_data else "inactive", "last_update": str(datetime.now())}
    except Exception as e:
        logger.error(f"Blockchain status check failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to check blockchain status")

# --- Reports Endpoints ---
@app.post("/api/reports")
async def generate_report(
    session: dict = Depends(get_session),
    username: str = Form(None),
    logs: List[Dict] = Form(None),
    image: UploadFile = File(None)
):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        user_id = str(session["_id"])
        username = username or session.get("username", "User")

        logs_data = logs if logs else list(logs_collection.find({"user_id": user_id}, {"_id": 0}))
        if not logs_data:
            logs_data = [{"timestamp": str(datetime.now()), "mood": "N/A", "sleep": 0, "water": 0, "exercise": 0, "note": "No logs available"}]

        report_analyses = list(reports_collection.find({"user_id": user_id}, {"_id": 0, "analysis": 1, "timestamp": 1}))
        analyses_text = "\n".join([f"Analysis from {r['timestamp']}: {r.get('analysis', 'No analysis available')}" for r in report_analyses]) or "No previous analyses available."

        image_analysis = ""
        if image:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
                content = await image.read()
                temp_file.write(content)
                temp_file_path = temp_file.name
            logger.info(f"Temporary image file saved at: {temp_file_path}")

            from PIL import Image
            with Image.open(temp_file_path) as img:
                model = genai.GenerativeModel("gemini-1.5-pro")
                prompt = (
                    "Analyze the provided image for health-related content. Identify any visible medical conditions, injuries, "
                    "or skin issues with high specificity (e.g., rash, bruise, swelling, cut, burn). Structure the response as follows:\n"
                    "- **Condition**: [Exact condition or 'Unable to determine' if unclear]\n"
                    "- **Description**: [Detailed description of the observed issue, including any visible signs or abnormalities]\n"
                    "- **Possible Diagnosis**: [Specific diagnosis if detectable, e.g., 'Eczema', 'Second-degree burn', or 'N/A']\n"
                    "- **Suggested Actions**: [Detailed steps, e.g., 'Clean with soap and water, apply antiseptic', 'Seek medical attention']\n"
                    "- **Medication Suggestions**: [Specific over-the-counter options, e.g., 'Hydrocortisone cream for inflammation', 'N/A']\n"
                    "Include: 'Disclaimer: Not a substitute for professional medical advice.' at the end."
                )
                response = model.generate_content([prompt, img])
                if not response.text:
                    raise ValueError("No response from Gemini API for image analysis")
                image_analysis = response.text.strip()
            os.unlink(temp_file_path)
            logger.info(f"Temporary image file deleted: {temp_file_path}")

        model = genai.GenerativeModel("gemini-1.5-pro")
        prompt = (
            f"Generate a detailed health report summary for user {username} based on the following data:\n"
            f"Logs:\n{json.dumps(logs_data, indent=2)}\n"
            f"Previous Analyses:\n{analyses_text}\n"
            f"Image Analysis:\n{image_analysis if image_analysis else 'No image analysis available.'}\n"
            "Structure the response as follows:\n"
            "- **Condition**: [Overall health condition or 'N/A' if unclear, incorporating image and log data]\n"
            "- **Description**: [Detailed description based on logs, previous analyses, and image analysis]\n"
            "- **Possible Diagnosis**: [General diagnosis if detectable, e.g., 'Fatigue', 'Typhoid Fever', or 'N/A']\n"
            "- **Suggested Actions**: [Comprehensive recommendations based on all data]\n"
            "- **Medication Suggestions**: [General suggestions based on all data, e.g., 'Multivitamins if deficient', 'N/A']\n"
            "Include: 'Disclaimer: Not a substitute for professional medical advice.' at the end."
        )
        response = model.generate_content(prompt)
        if not response.text:
            raise ValueError("No response from Gemini API for summary")
        ai_analysis = response.text.strip()

        report_data = {
            "user_id": user_id,
            "username": username,
            "logs": logs_data,
            "analysis": ai_analysis,
            "timestamp": str(datetime.now()),
        }
        report_id = reports_collection.insert_one(report_data).inserted_id
        logger.info(f"Report inserted with ID: {report_id}")

        pdf_path = f"reports/report_{report_id}.pdf"
        os.makedirs("reports", exist_ok=True)
        if not os.access("reports", os.W_OK):
            raise Exception("No write permission for 'reports' directory")

        doc = SimpleDocTemplate(pdf_path, pagesize=letter)
        styles = getSampleStyleSheet()
        heading_style = styles['Heading1']
        normal_style = styles['Normal']
        italic_style = styles['Italic']

        content = [
            Paragraph("HealthChain Medical Report", heading_style),
            Spacer(1, 20),
            Paragraph(f"Patient Name: {username}", normal_style),
            Paragraph(f"Report ID: {report_id}", normal_style),
            Paragraph(f"Date of Issue: {datetime.now().strftime('%B %d, %Y %H:%M:%S')}", normal_style),
            Spacer(1, 20),
            Paragraph("Health Logs", heading_style),
            Spacer(1, 10),
        ]

        log_table_data = [["Timestamp", "Mood", "Sleep (hrs)", "Water (L)", "Exercise (min)", "Note"]]
        for log in logs_data:
            log_table_data.append([
                log.get("timestamp", "N/A"),
                log.get("mood", "N/A").replace("Z", "").strip(),
                str(log.get("sleep", 0)),
                str(log.get("water", 0)),
                str(log.get("exercise", 0)),
                log.get("note", "N/A")
            ])
        table = Table(log_table_data, colWidths=[90, 60, 60, 60, 70, 110])
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 1, colors.black),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ]))
        content.append(table)
        content.append(Spacer(1, 20))

        content.append(Paragraph("AI Analysis Report", heading_style))
        content.append(Spacer(1, 10))
        for line in ai_analysis.split("\n"):
            if line.strip():
                if "Disclaimer" in line:
                    content.append(Paragraph(line, italic_style))
                else:
                    content.append(Paragraph(line, normal_style))
        content.append(Spacer(1, 20))

        doc.build(content)
        logger.info(f"PDF generated at: {pdf_path}")

        reports_collection.update_one(
            {"_id": report_id},
            {"$set": {"pdf_path": pdf_path}}
        )

        download_url = f"/api/download-report/{report_id}"
        return {
            "status": "success",
            "report_id": str(report_id),
            "download_url": download_url,
            "summary": ai_analysis.split("Disclaimer:")[0].strip(),
            "timestamp": report_data["timestamp"]
        }

    except HTTPException as http_err:
        logger.error(f"HTTP error in generate_report: {str(http_err)}", exc_info=True)
        raise
    except Exception as e:
        logger.error(f"Failed to generate report: {str(e)}", exc_info=True)
        try:
            if 'temp_file_path' in locals():
                os.unlink(temp_file_path)
                logger.info(f"Cleaned up temporary file: {temp_file_path}")
        except Exception as cleanup_err:
            logger.warning(f"Failed to clean up temporary file: {str(cleanup_err)}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.get("/api/download-report/{report_id}")
async def download_report(report_id: str):
    try:
        report = reports_collection.find_one({"_id": ObjectId(report_id)})
        if not report or "pdf_path" not in report:
            raise HTTPException(status_code=404, detail="Report not found")
        
        pdf_path = report["pdf_path"]
        if not os.path.exists(pdf_path):
            raise HTTPException(status_code=404, detail="PDF file not found")
        
        return FileResponse(pdf_path, filename=f"report_{report_id}.pdf", media_type="application/pdf")
    except Exception as e:
        logger.error(f"Failed to download report: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to download report")

@app.get("/api/reports")
async def get_reports(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        reports = list(reports_collection.find({"user_id": str(session["_id"])}))
        for report in reports:
            report["_id"] = str(report["_id"])
        logger.info(f"Retrieved {len(reports)} reports for user {session['username']}")
        return reports
    except Exception as e:
        logger.error(f"Error fetching reports: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch reports")

@app.post("/api/analyze-report")
async def analyze_report(file: UploadFile = File(...), session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        logger.info(f"Received file: {file.filename}, content type: {file.content_type}")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_file_path = temp_file.name
        logger.info(f"Temporary file saved at: {temp_file_path}")

        from PIL import Image
        with Image.open(temp_file_path) as image:
            model = genai.GenerativeModel("gemini-1.5-pro")
            prompt = (
                "Analyze the provided image for health-related content. Identify any visible medical conditions, injuries, "
                "or skin issues with high specificity (e.g., rash, bruise, swelling, cut, burn). Structure the response as follows:\n"
                "- **Condition**: [Exact condition or 'Unable to determine' if unclear]\n"
                "- **Description**: [Detailed description of the observed issue]\n"
                "- **Possible Diagnosis**: [Specific diagnosis if detectable, e.g., 'Eczema', 'Second-degree burn', or 'N/A']\n"
                "- **Suggested Actions**: [Detailed steps, e.g., 'Clean with soap and water, apply antiseptic', 'Seek medical attention']\n"
                "- **Medication Suggestions**: [Specific over-the-counter options, e.g., 'Hydrocortisone cream for inflammation', 'Antibiotic ointment like Neosporin', or 'N/A if not applicable']\n"
                "Include: 'Disclaimer: Not a substitute for professional medical advice.' at the end."
            )
            logger.info("Sending image and prompt to Gemini API")
            response = model.generate_content([prompt, image])
            logger.info("Received response from Gemini API")
            if not response.text:
                logger.error("Empty response from Gemini AI")
                raise ValueError("No response from Gemini API")

        analysis = {
            "filename": file.filename,
            "extracted_text": "N/A (Image-based analysis)",
            "ai_analysis": response.text
        }

        os.unlink(temp_file_path)
        logger.info("Temporary file deleted")

        logger.info(f"File {file.filename} analyzed successfully with Gemini AI")
        return {"analysis": analysis}
    except HTTPException as http_err:
        logger.error(f"HTTP error in analyze_report: {str(http_err)}", exc_info=True)
        raise
    except Exception as e:
        logger.error(f"Error analyzing file: {str(e)}", exc_info=True)
        try:
            if 'temp_file_path' in locals():
                os.unlink(temp_file_path)
                logger.info(f"Cleaned up temporary file: {temp_file_path}")
        except Exception as cleanup_err:
            logger.warning(f"Failed to clean up temporary file: {str(cleanup_err)}")
        raise HTTPException(status_code=500, detail=f"Error analyzing file: {str(e)}")

# --- Forum Endpoints ---
@app.post("/api/forum")
async def add_forum_post(post: ForumPost, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        post_dict = post.dict()
        post_dict["user_id"] = str(session["_id"])
        post_id = forum_collection.insert_one(post_dict).inserted_id
        logger.info(f"Forum post added with ID {post_id}")
        return {"status": "success", "post_id": str(post_id)}
    except Exception as e:
        logger.error(f"Failed to add forum post: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.get("/api/forum")
async def get_forum_posts(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        posts = list(forum_collection.find({}, {'_id': 0}))
        logger.info(f"Retrieved {len(posts)} forum posts")
        return posts
    except Exception as e:
        logger.error(f"Failed to fetch forum posts: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

# --- Nutrition Endpoints ---
@app.post("/api/nutrition")
async def add_nutrition(nutrition: NutritionInput, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        nutrition_dict = nutrition.dict()
        nutrition_dict["user_id"] = str(session["_id"])
        nutrition_id = nutrition_collection.insert_one(nutrition_dict).inserted_id
        logger.info(f"Nutrition entry added with ID {nutrition_id}")
        return {
            "status": "success",
            "suggestion": "Consider balancing your diet with more vegetables!",
            "nutrition_id": str(nutrition_id)
        }
    except Exception as e:
        logger.error(f"Failed to add nutrition: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.get("/api/nutrition")
async def get_nutrition(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        nutrition_data = list(nutrition_collection.find({"user_id": str(session["_id"])}, {'_id': 0}))
        today = datetime.now().date().isoformat()
        today_entries = [n for n in nutrition_data if n['timestamp'].startswith(today)]
        summary = {"calories": 0, "protein": 0, "fats": 0, "carbs": 0}
        for item in today_entries:
            summary["calories"] += item["calories"]
            summary["protein"] += item["protein"]
            summary["fats"] += item["fats"]
            summary["carbs"] += item["carbs"]
        suggestion = "You're on track!" if summary["calories"] < 2500 else "Consider reducing calorie intake today."
        return {
            "entries": nutrition_data,
            "today_summary": {**summary, "suggestion": suggestion}
        }
    except Exception as e:
        logger.error(f"Failed to fetch nutrition: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.post("/api/nutrition/fetch")
async def fetch_nutrients(nutrition: FetchNutritionInput, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        food_item = nutrition.food_item.strip()
        if not food_item:
            raise HTTPException(status_code=400, detail="Food item is required")

        model = genai.GenerativeModel("gemini-1.5-pro")
        prompt = f"Provide nutritional information for {food_item} in the following format: 'calories: X, protein: Y g, fats: Z g, carbs: W g' where X, Y, Z, W are approximate values in numerical form. Respond only with the formatted string. If unable to provide data, return 'error: no data available'."
        response = model.generate_content(prompt)
        nutrient_text = response.text.strip()

        if nutrient_text.startswith("error:"):
            raise HTTPException(status_code=400, detail=nutrient_text.replace("error: ", ""))

        nutrients = {}
        for part in nutrient_text.split(", "):
            if ":" in part:
                key_value = part.split(":", 1)
                if len(key_value) == 2:
                    key = key_value[0].strip()
                    value = key_value[1].strip()
                    numeric_value = "".join(filter(lambda x: x.isdigit() or x == ".", value.split(" ")[0]))
                    if numeric_value:
                        nutrients[key] = float(numeric_value)
                    else:
                        nutrients[key] = 0.0
                else:
                    logger.warning(f"Skipping malformed part: {part}")
            else:
                logger.warning(f"No colon found in part: {part}")

        required_nutrients = {"calories", "protein", "fats", "carbs"}
        for nutrient in required_nutrients:
            nutrients.setdefault(nutrient, 0.0)

        return {
            "status": "success",
            "calories": nutrients.get("calories", 0),
            "protein": nutrients.get("protein", 0),
            "fats": nutrients.get("fats", 0),
            "carbs": nutrients.get("carbs", 0)
        }
    except google_exceptions.GoogleAPIError as e:
        logger.error(f"Gemini API error: {str(e)}")
        raise HTTPException(status_code=500, detail="Gemini API is currently unavailable. Please try again later.")
    except ValueError as e:
        logger.error(f"Parsing error: {str(e)} - Raw response: {nutrient_text}")
        raise HTTPException(status_code=500, detail="Unable to parse nutritional data from AI response.")
    except Exception as e:
        logger.error(f"Error fetching nutrients from Gemini API: {str(e)} - Raw response: {nutrient_text}")
        raise HTTPException(status_code=500, detail="Failed to fetch nutrients from AI")

# --- Fitness Endpoints ---
@app.post("/api/fitness")
async def add_fitness(
    session: dict = Depends(get_session),
    exercise_name: str = Form(...),
    duration: int = Form(...),
    intensity: int = Form(...),
    weight: Optional[float] = Form(None),
    goal: Optional[str] = Form(None),
    fitness_level: Optional[str] = Form(None)
):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        fitness_data = {
            "exercise_name": exercise_name,
            "duration": duration,
            "intensity": intensity,
            "timestamp": str(datetime.now()),
            "user_id": str(session["_id"]),
            "weight": weight,
            "goal": goal,
            "fitness_level": fitness_level
        }
        fitness_id = fitness_collection.insert_one(fitness_data).inserted_id
        logger.info(f"Fitness entry added with ID {fitness_id}")
        return {"status": "success", "fitness_id": str(fitness_id)}
    except Exception as e:
        logger.error(f"Failed to add fitness: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.get("/api/fitness")
async def get_fitness(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        fitness_data = list(fitness_collection.find({"user_id": str(session["_id"])}, {'_id': 0}))
        logger.info(f"Retrieved {len(fitness_data)} fitness entries")
        return fitness_data
    except Exception as e:
        logger.error(f"Failed to fetch fitness: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.get("/api/fitness/plan", response_model=PlanResponse)
async def get_fitness_plan(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        latest_fitness = fitness_collection.find_one({"user_id": str(session["_id"])}, sort=[("timestamp", -1)])
        if not latest_fitness or not latest_fitness.get("fitness_level") or not latest_fitness.get("goal"):
            return {"status": "info", "message": "Please log a fitness session with goal and fitness level first."}

        weight = latest_fitness.get("weight", 70.0)
        goal = latest_fitness.get("goal", "maintain fitness")
        fitness_level = latest_fitness.get("fitness_level", "beginner")
        duration = latest_fitness.get("duration", 30)
        
        today = datetime.now().date().isoformat()
        nutrition_data = list(nutrition_collection.find({"user_id": str(session["_id"]), "timestamp": {"$regex": f"^{today}"}}))
        total_calories = sum(n["calories"] for n in nutrition_data) if nutrition_data else 0
        total_protein = sum(n["protein"] for n in nutrition_data) if nutrition_data else 0

        calorie_threshold = 2000
        if total_calories > calorie_threshold:
            intensity_factor = 1.2
            suggestion_modifier = " with increased intensity"
        elif total_calories < calorie_threshold * 0.8:
            intensity_factor = 0.8
            suggestion_modifier = " with lighter effort"
        else:
            intensity_factor = 1.0
            suggestion_modifier = ""

        if goal == "lose weight":
            if fitness_level == "beginner":
                suggestion = f"30 minutes of brisk walking{suggestion_modifier}"
                calories = (3.0 * duration * weight * intensity_factor) / 60
            elif fitness_level == "intermediate":
                suggestion = f"20 minutes of jogging{suggestion_modifier}"
                calories = (7.0 * duration * weight * intensity_factor) / 60
            else:
                suggestion = f"15 minutes of HIIT{suggestion_modifier}"
                calories = (8.0 * duration * weight * intensity_factor) / 60
        elif goal == "gain muscle":
            suggestion = f"30 minutes of weightlifting{suggestion_modifier} (ensure {total_protein*2.2:.0f}g protein intake)"
            calories = (5.0 * duration * weight * intensity_factor) / 60
        else:
            suggestion = f"30 minutes of mixed cardio and strength{suggestion_modifier}"
            calories = (4.0 * duration * weight * intensity_factor) / 60

        return {
            "status": "success",
            "workout_suggestion": suggestion,
            "estimated_calories_burned": round(calories, 1),
            "weight": weight,
            "goal": goal,
            "fitness_level": fitness_level,
            "nutrition_summary": f"Today's Intake: {total_calories} kcal, Protein: {total_protein}g"
        }
    except Exception as e:
        logger.error(f"Failed to generate fitness plan: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to generate fitness plan")

@app.get("/api/fitness/progress", response_model=ProgressResponse)
async def get_fitness_progress(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    
    try:
        user_id = str(session["_id"])
        client = MongoClient("mongodb://localhost:27017/")
        db = client["healthchain"]
        fitness_collection = db.fitness

        pipeline = [
            {"$match": {"user_id": user_id}},
            {
                "$group": {
                    "_id": {
                        "$dateToString": {"format": "%Y-W%V", "date": "$timestamp"}
                    },
                    "total_duration": {"$sum": "$duration"},
                    "total_intensity": {"$sum": "$intensity"},
                    "total_weighted_calories": {
                        "$sum": {
                            "$multiply": [
                                {"$switch": {
                                    "branches": [
                                        {"case": {"$eq": ["$exercise_name", "walking"]}, "then": 3.0},
                                        {"case": {"$eq": ["$exercise_name", "jogging"]}, "then": 7.0},
                                        {"case": {"$eq": ["$exercise_name", "HIIT"]}, "then": 8.0},
                                        {"case": {"$eq": ["$exercise_name", "weightlifting"]}, "then": 5.0},
                                        {"case": True, "then": 3.0}
                                    ],
                                    "default": 3.0
                                }},
                                "$duration",
                                {"$ifNull": ["$weight", 70]}
                            ]
                        }
                    },
                    "count": {"$sum": 1}
                }
            },
            {"$sort": {"_id": -1}}
        ]

        progress_data = list(fitness_collection.aggregate(pipeline))
        if not progress_data:
            return ProgressResponse(
                weekly_calories=[],
                duration_trend=Trend(current_week=0, previous_week=0, change_percent=0),
                intensity_trend=Trend(current_week=0, previous_week=0, change_percent=0)
            )

        weekly_calories = [
            WeeklyCalories(week=doc["_id"], calories=doc["total_weighted_calories"] / 60)
            for doc in progress_data[:4]
        ]
        current_week = progress_data[0]
        previous_week = progress_data[1] if len(progress_data) > 1 else None

        current_duration_avg = current_week["total_duration"] / current_week["count"] if current_week["count"] else 0
        previous_duration_avg = previous_week["total_duration"] / previous_week["count"] if previous_week and previous_week["count"] else 0
        duration_change_percent = (
            ((current_duration_avg - previous_duration_avg) / previous_duration_avg * 100)
            if previous_duration_avg and current_duration_avg
            else 0
        )

        current_intensity_avg = current_week["total_intensity"] / current_week["count"] if current_week["count"] else 0
        previous_intensity_avg = previous_week["total_intensity"] / previous_week["count"] if previous_week and previous_week["count"] else 0
        intensity_change_percent = (
            ((current_intensity_avg - previous_intensity_avg) / previous_intensity_avg * 100)
            if previous_intensity_avg and current_intensity_avg
            else 0
        )

        duration_trend = Trend(
            current_week=current_duration_avg,
            previous_week=previous_duration_avg,
            change_percent=duration_change_percent
        )
        intensity_trend = Trend(
            current_week=current_intensity_avg,
            previous_week=previous_intensity_avg,
            change_percent=intensity_change_percent
        )

        return ProgressResponse(
            weekly_calories=weekly_calories,
            duration_trend=duration_trend,
            intensity_trend=intensity_trend
        )
    except Exception as e:
        logger.error(f"Failed to get fitness progress: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to retrieve progress data")

# --- Medication Endpoints ---
@app.post("/api/meds")
async def add_med(
    session: dict = Depends(get_session),
    name: str = Form(...),
    time: str = Form(...),
    dosage: str = Form(None)
):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        name = name.lower().strip()
        logger.info(f"Validating medicine: {name}")
        model = genai.GenerativeModel("gemini-1.5-flash")
        prompt = f"Is '{name}' a recognized medicine or pharmaceutical drug? Respond with 'yes' or 'no' only."
        logger.info(f"Sending prompt to Gemini API: {prompt}")
        response = model.generate_content(prompt)
        logger.info(f"Gemini API response: {response.text}")
        if "no" in response.text.lower():
            raise HTTPException(status_code=400, detail=f"'{name}' is not a recognized medicine. Only approved medicines are allowed.")

        med_data = {
            "name": name,
            "time": time,
            "dosage": dosage,
            "timestamp": str(datetime.now()),
            "user_id": str(session["_id"])
        }
        med_id = meds_collection.insert_one(med_data).inserted_id
        logger.info(f"Medication added with ID {med_id}")
        return {"status": "success", "med_id": str(med_id)}
    except genai.exceptions.GenerativeAIError as e:
        logger.error(f"Gemini API error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Gemini API validation failed: {str(e)}")
    except Exception as e:
        logger.error(f"Failed to add medication or validate with Gemini API: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Database error or medicine validation failed")

@app.get("/api/meds")
async def get_meds(session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        meds = list(meds_collection.find({"user_id": str(session["_id"])}, {'_id': 0}))
        logger.info(f"Retrieved {len(meds)} medications")
        return meds
    except Exception as e:
        logger.error(f"Failed to fetch medications: {str(e)}")
        raise HTTPException(status_code=500, detail="Database error")

@app.post("/api/verify-medicine")
async def verify_medicine(medicine: MedicineVerification, session: dict = Depends(get_session)):
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        model = genai.GenerativeModel("gemini-1.5-flash")
        prompt = (
            "Verify if the provided medicine name is valid. Return ONLY a JSON object with the following structure:\n"
            "{\n"
            "  \"is_valid\": true|false,\n"
            "  \"reason\": \"string (optional, only if is_valid is false)\"\n"
            "}\n"
            "Set 'is_valid' to true if the medicine name exists or it is a medicine brand name. "
            "Set 'is_valid' to false for any non-medicine terms or any other material than medicine (e.g., 'drive', 'apple', 'pipe', 'car', 'pen'). "
            "If invalid, provide a reason in the 'reason' field (e.g., 'Not a recognized medicine')."
        )
        response = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
        if not response.text:
            logger.error("Empty response from Gemini API")
            raise ValueError("No response from Gemini API")
        
        logger.info(f"Raw response: {response.text}")
        import json
        try:
            result = json.loads(response.text.strip())
            if "is_valid" not in result or not isinstance(result["is_valid"], bool):
                raise ValueError("Invalid response structure: 'is_valid' must be a boolean")
            is_valid = result["is_valid"]
            reason = result.get("reason", "Medicine name not recognized") if not is_valid else None
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error: {str(e)}, Raw response: {response.text}")
            is_valid = False
            reason = "Invalid response format from Gemini"

        return {"is_valid": is_valid, "reason": reason}
    except Exception as e:
        logger.error(f"Medicine verification error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to verify medicine")

# --- Health Check and Root Endpoints ---
@app.get("/health")
async def health_check():
    logger.info("Health check requested")
    return {"status": "healthy"}

@app.get("/")
async def root():
    return {"message": "HealthChain Symptom Checker API", "redirect": "/static/index.html"}

# --- Startup and Shutdown Events ---
@app.on_event("startup")
async def startup_event():
    logger.info("Starting HealthChain API")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down HealthChain API")
    client.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)