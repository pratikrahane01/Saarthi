from fastapi import FastAPI

app = FastAPI(title="Zero-Magic Backend")

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Zero-Magic Backend is running"}
