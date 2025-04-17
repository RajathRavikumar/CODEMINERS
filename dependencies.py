from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pymongo import MongoClient
import jwt
from datetime import datetime, timedelta

# Example dependency to get session
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

def get_session(token: str = Depends(oauth2_scheme)):
    try:
        # Decode token (example, adjust based on your JWT setup)
        payload = jwt.decode(token, "your-secret-key", algorithms=["HS256"])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
        
        # Connect to MongoDB and fetch session data
        client = MongoClient("mongodb://localhost:27017/")
        db = client["healthchain"]
        user = db.users.find_one({"_id": user_id})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        
        return {"_id": user_id}  # Return session data
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")